// DonationAlerts: an integration of an already signed-in channel, never a way to sign in. The
// callback needs the RoastBot session that started it and only stores tokens for that session's
// channel.
import { randomBytes } from "node:crypto";

import type { FastifyInstance, FastifyReply } from "fastify";
import { z } from "zod";

import { cookieOptions, denied, session, type RouteContext } from "./context.js";
import {
  authorizeUrl as authorizeDonationAlerts,
  exchangeCode as exchangeDonationAlertsCode,
  getUser as getDonationAlertsUser,
  type DonationAlertsConfig
} from "./donationalerts.js";
import { encryptValue } from "./security.js";

const DA_STATE_COOKIE = "da_oauth_state";

export function registerIntegrationRoutes(app: FastifyInstance, context: RouteContext) {
  const { sql, config, requireUser, audit } = context;

  const daConfig: DonationAlertsConfig | undefined =
    config.DONATIONALERTS_CLIENT_ID && config.DONATIONALERTS_CLIENT_SECRET
      ? {
          clientId: config.DONATIONALERTS_CLIENT_ID,
          clientSecret: config.DONATIONALERTS_CLIENT_SECRET,
          redirectUri: `${config.PUBLIC_URL}/integrations/donationalerts/callback`
        }
      : undefined;
  const integrationRedirect = (reply: FastifyReply, result: string) => {
    const url = new URL(config.DASHBOARD_URL);
    url.searchParams.set("donationalerts", result);
    return reply.redirect(url.toString());
  };

  app.get("/integrations/donationalerts", { preHandler: requireUser }, async (request) => {
    const [row] = await sql<{ name: string }[]>`
      select da_name "name" from donationalerts_accounts
      where channel_id=${session(request).channelId}`;
    return { configured: Boolean(daConfig), connected: Boolean(row), name: row?.name ?? null };
  });

  app.get(
    "/integrations/donationalerts/connect",
    { preHandler: requireUser },
    async (request, reply) => {
      if (!daConfig) return denied(reply, 404, "not_configured", "DonationAlerts не настроен");
      const state = randomBytes(24).toString("base64url");
      // The cookie also names who started: a callback landing in another session is rejected.
      reply.setCookie(DA_STATE_COOKIE, `${state}.${session(request).userId}`, {
        ...cookieOptions(config),
        maxAge: 600
      });
      return reply.redirect(authorizeDonationAlerts(daConfig, state));
    }
  );

  app.get("/integrations/donationalerts/callback", async (request, reply) => {
    const query = z
      .object({
        code: z.string().optional(),
        state: z.string().optional(),
        error: z.string().optional()
      })
      .parse(request.query);
    const startedBy = request.cookies[DA_STATE_COOKIE];
    reply.clearCookie(DA_STATE_COOKIE, { path: "/" });
    if (!daConfig) return integrationRedirect(reply, "not_configured");
    try {
      await request.jwtVerify();
    } catch {
      return integrationRedirect(reply, "login_required");
    }
    const { userId, channelId, mfaAt } = session(request);
    const [user] = await sql<{ status: string; mfaEnabled: boolean }[]>`
      select status, totp_enabled_at is not null "mfaEnabled" from users where id=${userId}`;
    if (!user || user.status === "pending" || (user.mfaEnabled && !mfaAt)) {
      return integrationRedirect(reply, "login_required");
    }
    if (query.error) return integrationRedirect(reply, "denied");
    const [state, startedUserId] = startedBy?.split(".") ?? [];
    if (!query.code || !state || state !== query.state || startedUserId !== userId) {
      return integrationRedirect(reply, "invalid_state");
    }
    let token;
    let account;
    try {
      token = await exchangeDonationAlertsCode(daConfig, query.code);
      account = await getDonationAlertsUser(token.access_token);
    } catch (error) {
      request.log.warn(error, "DonationAlerts OAuth exchange failed");
      return integrationRedirect(reply, "unavailable");
    }
    const access = encryptValue(token.access_token, config.TOKEN_ENCRYPTION_KEY);
    const refresh = encryptValue(token.refresh_token, config.TOKEN_ENCRYPTION_KEY);
    await sql.begin(async (tx) => {
      await tx`insert into donationalerts_accounts(channel_id,da_user_id,da_name,
          access_token_ciphertext,access_token_iv,access_token_tag,
          refresh_token_ciphertext,refresh_token_iv,refresh_token_tag,expires_at)
        values(${channelId},${String(account.id)},${account.name},
          ${access.ciphertext},${access.iv},${access.tag},
          ${refresh.ciphertext},${refresh.iv},${refresh.tag},
          now()+${token.expires_in}*interval '1 second')
        on conflict(channel_id) do update set da_user_id=excluded.da_user_id,
          da_name=excluded.da_name, access_token_ciphertext=excluded.access_token_ciphertext,
          access_token_iv=excluded.access_token_iv, access_token_tag=excluded.access_token_tag,
          refresh_token_ciphertext=excluded.refresh_token_ciphertext,
          refresh_token_iv=excluded.refresh_token_iv, refresh_token_tag=excluded.refresh_token_tag,
          expires_at=excluded.expires_at, updated_at=now()`;
      await audit(tx, request, "donationalerts.connect", channelId, {
        daUserId: String(account.id)
      });
    });
    return integrationRedirect(reply, "connected");
  });

  app.post(
    "/integrations/donationalerts/disconnect",
    { preHandler: requireUser },
    async (request) => {
      const { channelId } = session(request);
      await sql.begin(async (tx) => {
        await tx`delete from donationalerts_accounts where channel_id=${channelId}`;
        await audit(tx, request, "donationalerts.disconnect", channelId, {});
      });
      return { connected: false };
    }
  );
}
