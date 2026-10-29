// Twitch login, logout and the session the panel reads on every load.
import { randomBytes } from "node:crypto";

import {
  DEFAULT_SIGNUP_DAILY_LIMIT,
  DEFAULT_SIGNUP_MIN_ACCOUNT_AGE_DAYS,
  TWITCH_SCOPES
} from "@roastbot/shared";
import type { FastifyInstance, FastifyReply } from "fastify";
import { z } from "zod";

import type { ApiConfig } from "./config.js";
import {
  cookieOptions,
  denied,
  OWNER_MFA_MAX_AGE_MS,
  session,
  SESSION_COOKIE,
  type RouteContext,
  type Session
} from "./context.js";
import { applyInviteLink, inviteCodeSchema } from "./invites.js";
import { encryptValue } from "./security.js";
import { exchangeCode, getTwitchUser } from "./twitch.js";

const INVITE_COOKIE = "invite_link";

export async function issueSession(reply: FastifyReply, claims: Session, config: ApiConfig) {
  const { userId, channelId, role, mfaAt } = claims;
  const signed = await reply.jwtSign(
    { userId, channelId, role, ...(mfaAt ? { mfaAt } : {}) },
    { expiresIn: "7d" }
  );
  reply.setCookie(SESSION_COOKIE, signed, { ...cookieOptions(config), maxAge: 604_800 });
}

export function registerAuthRoutes(app: FastifyInstance, context: RouteContext) {
  const { sql, config, requireSession } = context;

  const dashboardRedirect = (reply: FastifyReply, authError: string) => {
    const url = new URL(config.DASHBOARD_URL);
    url.searchParams.set("auth_error", authError);
    return reply.redirect(url.toString());
  };

  app.get("/auth/twitch", async (request, reply) => {
    const state = randomBytes(24).toString("base64url");
    reply.setCookie("oauth_state", state, { ...cookieOptions(config), maxAge: 600 });
    // /i/<code> sends the visitor here with the link; the callback applies it after login.
    const invite = inviteCodeSchema.safeParse((request.query as { invite?: unknown }).invite);
    if (invite.success) {
      reply.setCookie(INVITE_COOKIE, invite.data, { ...cookieOptions(config), maxAge: 600 });
    }
    const url = new URL("https://id.twitch.tv/oauth2/authorize");
    url.search = new URLSearchParams({
      client_id: config.TWITCH_CLIENT_ID,
      redirect_uri: config.TWITCH_REDIRECT_URI,
      response_type: "code",
      scope: TWITCH_SCOPES.join(" "),
      state
    }).toString();
    return reply.redirect(url.toString());
  });

  app.get("/auth/twitch/callback", async (request, reply) => {
    const query = z
      .object({
        code: z.string().optional(),
        state: z.string().optional(),
        error: z.string().optional()
      })
      .parse(request.query);
    if (query.error) return dashboardRedirect(reply, query.error);
    if (
      !query.code ||
      !request.cookies.oauth_state ||
      request.cookies.oauth_state !== query.state
    ) {
      return dashboardRedirect(reply, "invalid_oauth_state");
    }
    reply.clearCookie("oauth_state", { path: "/" });
    const inviteLink = inviteCodeSchema.safeParse(request.cookies[INVITE_COOKIE]);
    reply.clearCookie(INVITE_COOKIE, { path: "/" });
    let token;
    let twitchUser;
    try {
      token = await exchangeCode(query.code, config);
      twitchUser = await getTwitchUser(token.access_token, config.TWITCH_CLIENT_ID);
    } catch (error) {
      request.log.warn(error, "Twitch OAuth exchange failed");
      return dashboardRedirect(reply, "twitch_unavailable");
    }
    const access = encryptValue(token.access_token, config.TOKEN_ENCRYPTION_KEY);
    const refresh = encryptValue(token.refresh_token, config.TOKEN_ENCRYPTION_KEY);
    const role = config.ownerIds.has(twitchUser.id) ? "owner" : "user";
    const login = twitchUser.login.toLowerCase();

    const accountAgeDays = twitchUser.created_at
      ? (Date.now() - Date.parse(twitchUser.created_at)) / 86_400_000
      : Number.NaN;

    const rows = await sql.begin(async (tx) => {
      // Open registration: a new login is active at once, unless the Twitch account is too young
      // or the day's signups are used up; then it waits for the owner like before. The owner and
      // invited logins always pass. An existing account keeps its status; a pending one is
      // lifted for the owner, or once it passes the same checks (the account grew old enough).
      // The lock makes the daily count exact under parallel logins.
      await tx`select pg_advisory_xact_lock(hashtext('roastbot-signup'))`;
      const [signup] = await tx<
        { existing: string | null; today: number; limit: number; minAge: number }[]
      >`
        select (select status::text from users where twitch_id=${twitchUser.id}) existing,
          (select count(*) from users where role='user' and status<>'pending'
            and created_at >= date_trunc('day', now() at time zone 'UTC') at time zone 'UTC')::int today,
          coalesce((select (value #>> '{}')::int from global_settings where key='signup_daily_limit'),
            ${DEFAULT_SIGNUP_DAILY_LIMIT})::int "limit",
          coalesce((select (value #>> '{}')::int from global_settings
            where key='signup_min_account_age_days'), ${DEFAULT_SIGNUP_MIN_ACCOUNT_AGE_DAYS})::int "minAge"`;
      // An unknown account age (Twitch left it out) counts as too young: review, not a pass.
      const reviewReason =
        role === "owner" || (signup?.existing && signup.existing !== "pending")
          ? null
          : !signup || signup.today >= signup.limit
            ? "daily_limit"
            : !(accountAgeDays >= signup.minAge)
              ? "young_account"
              : null;
      const [user] = await tx<{ id: string; status: string; created: boolean }[]>`
        insert into users (twitch_id, login, display_name, role, status)
        values (${twitchUser.id}, ${login}, ${twitchUser.display_name}, ${role},
          ${reviewReason ? "pending" : "active"})
        on conflict (twitch_id) do update set login=excluded.login,
          display_name=excluded.display_name, role=excluded.role,
          status=case when users.status='pending' and excluded.status='active'
            then 'active'::user_status else users.status end
        returning id, status, (xmax = 0) created`;
      if (!user) throw new Error("User upsert failed");
      if (user.status === "pending") {
        const invited = await tx`update invites set used_at=now(), used_by_user_id=${user.id}
          where login=${login} and used_at is null returning login`;
        if (invited.length) {
          await tx`update users set status='active' where id=${user.id}`;
          user.status = "active";
        }
      }
      if (user.created) {
        const payload = {
          status: user.status,
          ...(user.status === "pending" && reviewReason ? { review: reviewReason } : {})
        };
        await tx`insert into audit_log(actor_user_id,action,target,payload)
          values(${user.id},'user.signup',${login},${sql.json(payload)})`;
      }
      const [channel] = await tx<{ id: string }[]>`
        insert into channels (user_id, twitch_login, overlay_token)
        values (${user.id}, ${login}, ${randomBytes(32).toString("base64url")})
        on conflict (user_id) do update set twitch_login=excluded.twitch_login returning id`;
      if (!channel) throw new Error("Channel upsert failed");
      await tx`insert into settings (channel_id) values (${channel.id}) on conflict do nothing`;
      await tx`
        insert into subscriptions (user_id, plan_id)
        select ${user.id}, id from plans where code='free'
        and not exists (select 1 from subscriptions where user_id=${user.id})`;
      // After the free plan, so a plan the link grants is the newest subscription.
      if (inviteLink.success) await applyInviteLink(tx, inviteLink.data, user);
      await tx`
        insert into twitch_tokens (channel_id, access_token_ciphertext, refresh_token_ciphertext,
          access_token_iv, access_token_tag, refresh_token_iv, refresh_token_tag, scopes, expires_at)
        values (${channel.id}, ${access.ciphertext}, ${refresh.ciphertext}, ${access.iv}, ${access.tag},
          ${refresh.iv}, ${refresh.tag}, ${token.scope}, now() + ${token.expires_in} * interval '1 second')
        on conflict (channel_id) do update set access_token_ciphertext=excluded.access_token_ciphertext,
          refresh_token_ciphertext=excluded.refresh_token_ciphertext, access_token_iv=excluded.access_token_iv,
          access_token_tag=excluded.access_token_tag, refresh_token_iv=excluded.refresh_token_iv,
          refresh_token_tag=excluded.refresh_token_tag, scopes=excluded.scopes,
          expires_at=excluded.expires_at, updated_at=now()`;
      return { userId: user.id, channelId: channel.id };
    });
    // A fresh Twitch login never carries mfaAt: the second factor is asked again every time.
    await issueSession(reply, { ...rows, role }, config);
    return reply.redirect(config.DASHBOARD_URL);
  });

  app.post("/auth/logout", async (_request, reply) => {
    reply.clearCookie(SESSION_COOKIE, { path: "/" });
    return { ok: true };
  });

  app.get("/me/session", { preHandler: requireSession }, async (request, reply) => {
    const { userId, channelId, mfaAt } = session(request);
    const [row] = await sql<
      {
        status: string;
        mfaEnabled: boolean;
        overlayToken: string;
        recoveryCodesLeft: number;
        scopes: string[] | null;
      }[]
    >`
      select u.id "userId", c.id "channelId", u.login, u.display_name "displayName",
        u.role, u.status, c.twitch_login "channelLogin", c.overlay_token "overlayToken",
        u.totp_enabled_at is not null "mfaEnabled",
        cardinality(u.mfa_recovery_hashes)::int "recoveryCodesLeft", t.scopes
      from users u join channels c on c.user_id=u.id
      left join twitch_tokens t on t.channel_id=c.id
      where u.id=${userId} and c.id=${channelId}`;
    if (!row) {
      reply.clearCookie(SESSION_COOKIE, { path: "/" });
      return denied(reply, 401, "unauthorized", "Сессия устарела");
    }
    const mfaRequired = row.mfaEnabled && !mfaAt;
    const adminMfa = !row.mfaEnabled
      ? "setup"
      : !mfaAt || Date.now() - mfaAt > OWNER_MFA_MAX_AGE_MS
        ? "verify"
        : "ok";
    // The overlay token is a credential: not before approval and the second factor, and not
    // for a suspended account.
    const restricted = row.status !== "active" || mfaRequired;
    const { scopes, ...sessionRow } = row;
    return {
      ...sessionRow,
      overlayToken: restricted ? null : row.overlayToken,
      mfaRequired,
      adminMfa,
      // Scopes added after this channel logged in: its event triggers need a fresh Twitch login.
      missingScopes: TWITCH_SCOPES.filter((scope) => !(scopes ?? []).includes(scope))
    };
  });
}
