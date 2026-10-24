import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { basename, join } from "node:path";
import { randomBytes, randomUUID } from "node:crypto";

import cookie from "@fastify/cookie";
import jwt from "@fastify/jwt";
import websocket, { type WebSocket } from "@fastify/websocket";
import { createDatabase } from "@roastbot/db";
import {
  COMMAND_PLANS,
  DEFAULT_GLOBAL_MONTHLY_ROAST_CAP,
  DEFAULT_MONTHLY_BUDGET_USD,
  DEFAULT_ELEVENLABS_MONTHLY_CHAR_LIMIT,
  DEFAULT_YANDEX_TTS_MONTHLY_LIMIT_RUB,
  ROAST_REQUESTED_QUEUE,
  ROAST_REQUESTED_QUEUE_OPTIONS,
  TWITCH_SCOPES,
  channelSettingsSchema,
  overlayClientEventSchema,
  roastStatusSchema,
  storedOverlayRoastSchema,
  testRoastRequestSchema,
  updateSettingsRequestSchema,
  YANDEX_TTS_RUB_PER_REQUEST,
  yandexBillingMonth
} from "@roastbot/shared";
import Fastify, { type FastifyReply, type FastifyRequest } from "fastify";
import { PgBoss } from "pg-boss";
import type { JSONValue, TransactionSql } from "postgres";
import { z, ZodError } from "zod";

import type { ApiConfig } from "./config.js";
import {
  authorizeUrl as authorizeDonationAlerts,
  exchangeCode as exchangeDonationAlertsCode,
  getUser as getDonationAlertsUser,
  type DonationAlertsConfig
} from "./donationalerts.js";
import { decryptValue, encryptValue, signAudioPath, verifyAudioSignature } from "./security.js";
import {
  generateRecoveryCodes,
  generateTotpSecret,
  hashRecoveryCode,
  normalizeRecoveryCode,
  otpauthUri,
  verifyTotp
} from "./totp.js";
import {
  TwitchApiError,
  exchangeCode,
  getRewards,
  getTwitchUser,
  refreshTwitchToken
} from "./twitch.js";

interface Session {
  userId: string;
  channelId: string;
  role: "owner" | "user";
  /** Epoch ms when the second factor was confirmed in this session; absent until then. */
  mfaAt?: number;
}

interface OverlayConnection {
  socket: WebSocket;
  channelId: string;
  sent: Set<string>;
}

const SESSION_COOKIE = "roastbot_session";

function session(request: FastifyRequest): Session {
  return request.user as Session;
}

const currentMonth = () => new Date().toISOString().slice(0, 7);

// Global settings the owner may edit, each with its own validation so a typo in /admin can never
// store a value the worker cannot use.
const globalSettingSchemas = {
  kill_switch: z.boolean(),
  global_monthly_limit: z.number().int().min(0).max(1_000_000),
  monthly_budget_usd: z.number().min(0).max(10_000),
  model: z.string().regex(/^claude-[a-z0-9-]+$/u),
  classifier_model: z.string().regex(/^claude-[a-z0-9-]+$/u),
  input_retention_days: z.number().int().min(1).max(30),
  yandex_tts_monthly_limit_rub: z.number().min(0).max(100_000),
  elevenlabs_monthly_char_limit: z.number().int().min(0).max(10_000_000)
} as const;
type GlobalSettingKey = keyof typeof globalSettingSchemas;

const stopWordsSchema = z.array(z.string().trim().min(1).max(100)).max(1000);

// Owner actions need a second factor confirmed within this window, even inside a 7-day session.
const OWNER_MFA_MAX_AGE_MS = 12 * 60 * 60 * 1000;
const MFA_MAX_FAILURES = 5;
const MFA_LOCK_MS = 15 * 60 * 1000;
const mfaCodeSchema = z.object({ code: z.string().trim().min(6).max(32) });
const twitchLoginSchema = z
  .string()
  .trim()
  .transform((value) => value.replace(/^@/u, "").toLowerCase())
  .pipe(z.string().regex(/^[a-z0-9_]{3,25}$/u, "Некорректный логин Twitch"));

type FactorCheck =
  | { ok: true; via: "totp" | "recovery" }
  | { ok: false; status: number; code: string; message: string };

const denied = (reply: FastifyReply, status: number, code: string, message: string) =>
  reply.code(status).send({ error: { code, message } });

export async function buildApp(config: ApiConfig) {
  const app = Fastify({ logger: config.NODE_ENV !== "test", trustProxy: true });
  const database = createDatabase(config.DATABASE_URL, { applicationName: "roastbot-api" });
  const sql = database.client;
  const boss = new PgBoss(config.DATABASE_URL);
  boss.on("error", (error) => app.log.error(error, "pg-boss error"));
  await boss.start();
  await boss.createQueue(ROAST_REQUESTED_QUEUE, { ...ROAST_REQUESTED_QUEUE_OPTIONS });

  await app.register(cookie);
  await app.register(jwt, {
    secret: config.SESSION_SECRET,
    cookie: { cookieName: SESSION_COOKIE, signed: false }
  });
  await app.register(websocket);

  app.setErrorHandler((error: Error & { statusCode?: number }, request, reply) => {
    if (error instanceof ZodError) {
      return reply.code(400).send({
        error: { code: "invalid_request", message: "Некорректный запрос", details: error.issues }
      });
    }
    const status = error.statusCode ?? 500;
    if (status >= 500) request.log.error(error);
    return reply.code(status).send({
      error: {
        code: status === 401 ? "unauthorized" : status >= 500 ? "internal_error" : "request_failed",
        message: status >= 500 ? "Внутренняя ошибка сервера" : error.message
      }
    });
  });

  // Only proves the Twitch login: for the session probe, the 2FA screens and logout.
  const requireSession = async (request: FastifyRequest) => {
    await request.jwtVerify();
  };
  // Approval and 2FA state come from the database on every request, so approving a streamer or
  // enabling 2FA takes effect without a new login.
  const requireUser = async (request: FastifyRequest, reply: FastifyReply) => {
    await request.jwtVerify();
    const [user] = await sql<{ status: string; mfaEnabled: boolean }[]>`
      select status, totp_enabled_at is not null "mfaEnabled" from users
      where id=${session(request).userId}`;
    if (!user) return denied(reply, 401, "unauthorized", "Сессия устарела");
    if (user.status === "pending") {
      return denied(reply, 403, "pending_approval", "Заявка ещё не одобрена владельцем");
    }
    if (user.mfaEnabled && !session(request).mfaAt) {
      return denied(reply, 403, "mfa_required", "Подтвердите вход кодом 2FA");
    }
  };
  // Role and status come from the database, not the 7-day JWT, so a demoted or suspended owner
  // loses /admin immediately. The owner must have 2FA and a recent confirmation of it.
  const requireOwner = async (request: FastifyRequest, reply: FastifyReply) => {
    await request.jwtVerify();
    const [user] = await sql<{ role: string; status: string; mfaEnabled: boolean }[]>`
      select role, status, totp_enabled_at is not null "mfaEnabled" from users
      where id=${session(request).userId}`;
    if (user?.role !== "owner" || user.status !== "active") {
      return denied(reply, 403, "owner_required", "Только владелец");
    }
    if (!user.mfaEnabled) {
      return denied(reply, 403, "mfa_setup_required", "Включите двухфакторную аутентификацию");
    }
    const { mfaAt } = session(request);
    if (!mfaAt || Date.now() - mfaAt > OWNER_MFA_MAX_AGE_MS) {
      return denied(reply, 403, "mfa_required", "Подтвердите вход кодом 2FA");
    }
  };

  // ---- overlay delivery -------------------------------------------------------------------
  const overlayConnections = new Set<OverlayConnection>();

  const sendJson = (socket: WebSocket, value: unknown) => {
    if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(value));
  };

  const deliverPending = async (connection: OverlayConnection) => {
    const rows = await sql<{ id: string; payload: unknown }[]>`
      select id, payload from overlay_events where channel_id=${connection.channelId}
      and status='pending' and available_at <= now() and expires_at > now() order by created_at`;
    for (const row of rows) {
      if (connection.sent.has(row.id)) continue;
      const stored = storedOverlayRoastSchema.safeParse(row.payload);
      if (!stored.success) continue;
      const { audioFile, ...event } = stored.data;
      connection.sent.add(row.id);
      sendJson(connection.socket, {
        ...event,
        audioUrl: `${config.PUBLIC_URL}${signAudioPath(audioFile, config.AUDIO_SIGNING_SECRET)}`
      });
    }
  };

  const overlayListener = await sql.listen("overlay_events", (channelId) => {
    for (const connection of overlayConnections) {
      if (connection.channelId !== channelId) continue;
      deliverPending(connection).catch((error: unknown) =>
        app.log.error(error, "overlay delivery")
      );
    }
  });

  const closeOverlays = (channelId: string, reason: string) => {
    for (const connection of overlayConnections) {
      if (connection.channelId === channelId) connection.socket.close(1008, reason);
    }
  };

  // ---- Twitch tokens ----------------------------------------------------------------------
  interface TokenRow {
    twitch_id: string;
    access_token_ciphertext: string;
    access_token_iv: string;
    access_token_tag: string;
    refresh_token_ciphertext: string;
    refresh_token_iv: string;
    refresh_token_tag: string;
    expires_at: Date;
  }

  const channelAccessToken = async (channelId: string, forceRefresh = false) => {
    const [row] = await sql<TokenRow[]>`
      select u.twitch_id, t.* from twitch_tokens t join channels c on c.id=t.channel_id
      join users u on u.id=c.user_id where c.id=${channelId}`;
    if (!row) return undefined;
    if (!forceRefresh && row.expires_at.getTime() > Date.now() + 120_000) {
      const token = decryptValue(
        {
          ciphertext: row.access_token_ciphertext,
          iv: row.access_token_iv,
          tag: row.access_token_tag
        },
        config.TOKEN_ENCRYPTION_KEY
      );
      return { token, twitchId: row.twitch_id };
    }
    const refreshPlaintext = decryptValue(
      {
        ciphertext: row.refresh_token_ciphertext,
        iv: row.refresh_token_iv,
        tag: row.refresh_token_tag
      },
      config.TOKEN_ENCRYPTION_KEY
    );
    const refreshed = await refreshTwitchToken(refreshPlaintext, config);
    const access = encryptValue(refreshed.access_token, config.TOKEN_ENCRYPTION_KEY);
    const refresh = encryptValue(refreshed.refresh_token, config.TOKEN_ENCRYPTION_KEY);
    await sql`update twitch_tokens set access_token_ciphertext=${access.ciphertext},
      access_token_iv=${access.iv},access_token_tag=${access.tag},
      refresh_token_ciphertext=${refresh.ciphertext},refresh_token_iv=${refresh.iv},
      refresh_token_tag=${refresh.tag},scopes=${refreshed.scope},
      expires_at=now()+${refreshed.expires_in}*interval '1 second',updated_at=now()
      where channel_id=${channelId}`;
    return { token: refreshed.access_token, twitchId: row.twitch_id };
  };

  // ---- health -----------------------------------------------------------------------------
  app.get("/health", () => ({ ok: true }));
  app.get("/ready", async (_request, reply) => {
    try {
      await sql`select 1`;
      return { ok: true };
    } catch {
      return reply.code(503).send({ ok: false });
    }
  });

  // ---- auth -------------------------------------------------------------------------------
  const cookieOptions = {
    httpOnly: true,
    secure: config.NODE_ENV === "production",
    sameSite: "lax" as const,
    path: "/"
  };
  const dashboardRedirect = (reply: FastifyReply, authError: string) => {
    const url = new URL(config.DASHBOARD_URL);
    url.searchParams.set("auth_error", authError);
    return reply.redirect(url.toString());
  };

  app.get("/auth/twitch", async (_request, reply) => {
    const state = randomBytes(24).toString("base64url");
    reply.setCookie("oauth_state", state, { ...cookieOptions, maxAge: 600 });
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

    const rows = await sql.begin(async (tx) => {
      // New logins wait for the owner's approval; the owner and invited logins pass at once.
      // An existing account keeps its status, except that pending is lifted for the owner.
      const [user] = await tx<{ id: string; status: string; created: boolean }[]>`
        insert into users (twitch_id, login, display_name, role, status)
        values (${twitchUser.id}, ${login}, ${twitchUser.display_name}, ${role},
          ${role === "owner" ? "active" : "pending"})
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
        await tx`insert into audit_log(actor_user_id,action,target,payload)
          values(${user.id},'user.signup',${login},${sql.json({ status: user.status })})`;
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
    await issueSession(reply, { ...rows, role });
    return reply.redirect(config.DASHBOARD_URL);
  });

  app.post("/auth/logout", async (_request, reply) => {
    reply.clearCookie(SESSION_COOKIE, { path: "/" });
    return { ok: true };
  });

  // ---- session and second factor ----------------------------------------------------------
  async function issueSession(reply: FastifyReply, claims: Session) {
    const { userId, channelId, role, mfaAt } = claims;
    const signed = await reply.jwtSign(
      { userId, channelId, role, ...(mfaAt ? { mfaAt } : {}) },
      { expiresIn: "7d" }
    );
    reply.setCookie(SESSION_COOKIE, signed, { ...cookieOptions, maxAge: 604_800 });
  }

  interface FactorRow {
    ciphertext: string | null;
    iv: string | null;
    tag: string | null;
    lastStep: number | null;
    recoveryHashes: string[];
    failures: number;
    lockedUntil: Date | null;
  }

  // Checks a TOTP or recovery code under a row lock, so parallel guesses all count toward the
  // lockout. Failures are committed even though the caller answers with an error.
  const checkSecondFactor = (userId: string, rawCode: string) =>
    sql.begin(async (tx): Promise<FactorCheck> => {
      const [row] = await tx<FactorRow[]>`
        select totp_secret_ciphertext ciphertext, totp_secret_iv iv, totp_secret_tag tag,
          totp_last_step::float8 "lastStep", mfa_recovery_hashes "recoveryHashes",
          mfa_failed_attempts failures, mfa_locked_until "lockedUntil"
        from users where id=${userId} for update`;
      if (!row?.ciphertext || !row.iv || !row.tag) {
        return { ok: false, status: 409, code: "mfa_not_configured", message: "2FA не настроена" };
      }
      if (row.lockedUntil && row.lockedUntil.getTime() > Date.now()) {
        const minutes = Math.ceil((row.lockedUntil.getTime() - Date.now()) / 60_000);
        return {
          ok: false,
          status: 429,
          code: "mfa_locked",
          message: `Слишком много неверных кодов. Повторите через ${String(minutes)} мин.`
        };
      }
      const code = rawCode.replace(/\s/gu, "");
      const secret = decryptValue(
        { ciphertext: row.ciphertext, iv: row.iv, tag: row.tag },
        config.TOKEN_ENCRYPTION_KEY
      );
      const step = verifyTotp(secret, code, row.lastStep);
      if (step !== null) {
        await tx`update users set totp_last_step=${step}, mfa_failed_attempts=0,
          mfa_locked_until=null where id=${userId}`;
        return { ok: true, via: "totp" };
      }
      const hash = hashRecoveryCode(code);
      if (normalizeRecoveryCode(code).length === 10 && row.recoveryHashes.includes(hash)) {
        await tx`update users set mfa_recovery_hashes=array_remove(mfa_recovery_hashes, ${hash}),
          mfa_failed_attempts=0, mfa_locked_until=null where id=${userId}`;
        return { ok: true, via: "recovery" };
      }
      const failures = row.failures + 1;
      const lock = failures >= MFA_MAX_FAILURES;
      await tx`update users set mfa_failed_attempts=${lock ? 0 : failures},
        mfa_locked_until=${lock ? new Date(Date.now() + MFA_LOCK_MS) : null} where id=${userId}`;
      return lock
        ? {
            ok: false,
            status: 429,
            code: "mfa_locked",
            message: "Слишком много неверных кодов. Вход по 2FA заблокирован на 15 минут."
          }
        : { ok: false, status: 400, code: "mfa_invalid", message: "Неверный код" };
    });

  interface MfaState {
    login: string;
    role: string;
    status: string;
    enabled: boolean;
    started: boolean;
  }
  const mfaState = async (userId: string) => {
    const [row] = await sql<MfaState[]>`
      select login, role, status, totp_enabled_at is not null enabled,
        totp_secret_ciphertext is not null started from users where id=${userId}`;
    return row;
  };

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
    // The overlay token is a credential: not before approval and the second factor.
    const restricted = row.status === "pending" || mfaRequired;
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

  app.post("/me/mfa/setup", { preHandler: requireSession }, async (request, reply) => {
    const { userId } = session(request);
    const state = await mfaState(userId);
    if (!state) return denied(reply, 401, "unauthorized", "Сессия устарела");
    if (state.status === "pending") {
      return denied(reply, 403, "pending_approval", "Заявка ещё не одобрена владельцем");
    }
    if (state.enabled) return denied(reply, 409, "mfa_already_enabled", "2FA уже включена");
    const secret = generateTotpSecret();
    const encrypted = encryptValue(secret, config.TOKEN_ENCRYPTION_KEY);
    await sql`update users set totp_secret_ciphertext=${encrypted.ciphertext},
      totp_secret_iv=${encrypted.iv}, totp_secret_tag=${encrypted.tag}, totp_last_step=null
      where id=${userId} and totp_enabled_at is null`;
    return { secret, otpauthUri: otpauthUri(secret, state.login) };
  });

  app.post("/me/mfa/enable", { preHandler: requireSession }, async (request, reply) => {
    const { code } = mfaCodeSchema.parse(request.body);
    const claims = session(request);
    const state = await mfaState(claims.userId);
    if (!state) return denied(reply, 401, "unauthorized", "Сессия устарела");
    if (state.status === "pending") {
      return denied(reply, 403, "pending_approval", "Заявка ещё не одобрена владельцем");
    }
    if (state.enabled) return denied(reply, 409, "mfa_already_enabled", "2FA уже включена");
    if (!state.started)
      return denied(reply, 409, "mfa_setup_required", "Сначала начните настройку");
    const result = await checkSecondFactor(claims.userId, code);
    if (!result.ok) return denied(reply, result.status, result.code, result.message);
    const recoveryCodes = generateRecoveryCodes();
    await sql.begin(async (tx) => {
      await tx`update users set totp_enabled_at=now(),
        mfa_recovery_hashes=${recoveryCodes.map(hashRecoveryCode)} where id=${claims.userId}`;
      await audit(tx, request, "mfa.enable", claims.userId, {});
    });
    await issueSession(reply, { ...claims, mfaAt: Date.now() });
    return { recoveryCodes };
  });

  app.post("/me/mfa/verify", { preHandler: requireSession }, async (request, reply) => {
    const { code } = mfaCodeSchema.parse(request.body);
    const claims = session(request);
    const state = await mfaState(claims.userId);
    if (!state) return denied(reply, 401, "unauthorized", "Сессия устарела");
    if (!state.enabled) return denied(reply, 409, "mfa_not_enabled", "2FA не включена");
    const result = await checkSecondFactor(claims.userId, code);
    if (!result.ok) return denied(reply, result.status, result.code, result.message);
    if (result.via === "recovery") {
      await sql.begin((tx) => audit(tx, request, "mfa.recovery_code_used", claims.userId, {}));
    }
    await issueSession(reply, { ...claims, mfaAt: Date.now() });
    const [left] = await sql<{ count: number }[]>`
      select cardinality(mfa_recovery_hashes)::int count from users where id=${claims.userId}`;
    return { ok: true, via: result.via, recoveryCodesLeft: left?.count ?? 0 };
  });

  app.post("/me/mfa/recovery-codes", { preHandler: requireUser }, async (request, reply) => {
    const { code } = mfaCodeSchema.parse(request.body);
    const { userId } = session(request);
    const state = await mfaState(userId);
    if (!state?.enabled) return denied(reply, 409, "mfa_not_enabled", "2FA не включена");
    const result = await checkSecondFactor(userId, code);
    if (!result.ok) return denied(reply, result.status, result.code, result.message);
    const recoveryCodes = generateRecoveryCodes();
    await sql.begin(async (tx) => {
      await tx`update users set mfa_recovery_hashes=${recoveryCodes.map(hashRecoveryCode)}
        where id=${userId}`;
      await audit(tx, request, "mfa.recovery_codes_regenerated", userId, {});
    });
    return { recoveryCodes };
  });

  app.post("/me/mfa/disable", { preHandler: requireUser }, async (request, reply) => {
    const { code } = mfaCodeSchema.parse(request.body);
    const claims = session(request);
    const state = await mfaState(claims.userId);
    if (!state?.enabled) return denied(reply, 409, "mfa_not_enabled", "2FA не включена");
    if (state.role === "owner") {
      return denied(reply, 403, "mfa_mandatory", "Владельцу сервиса 2FA отключать нельзя");
    }
    const result = await checkSecondFactor(claims.userId, code);
    if (!result.ok) return denied(reply, result.status, result.code, result.message);
    await sql.begin(async (tx) => {
      await tx`update users set totp_secret_ciphertext=null, totp_secret_iv=null,
        totp_secret_tag=null, totp_enabled_at=null, totp_last_step=null,
        mfa_recovery_hashes=ARRAY[]::text[] where id=${claims.userId}`;
      await audit(tx, request, "mfa.disable", claims.userId, {});
    });
    await issueSession(reply, {
      userId: claims.userId,
      channelId: claims.channelId,
      role: claims.role
    });
    return { ok: true };
  });

  // ---- streamer dashboard -----------------------------------------------------------------

  app.post("/me/overlay-token/rotate", { preHandler: requireUser }, async (request) => {
    const { channelId } = session(request);
    const overlayToken = randomBytes(32).toString("base64url");
    await sql`update channels set overlay_token=${overlayToken} where id=${channelId}`;
    closeOverlays(channelId, "token rotated");
    return { overlayToken };
  });

  app.get("/settings", { preHandler: requireUser }, async (request) => {
    const [row] = await sql`select * from settings where channel_id=${session(request).channelId}`;
    return row;
  });
  app.patch("/settings", { preHandler: requireUser }, async (request) => {
    const patch = updateSettingsRequestSchema.parse(request.body);
    const [current] = await sql<{ settings: unknown }[]>`
      select jsonb_build_object('tone',tone,'voice',voice,'toxicity',toxicity,'cooldownSec',cooldown_sec,
       'userCooldownSec',user_cooldown_sec,'triggers',triggers,'stopWords',stop_words,'enabled',enabled) settings
      from settings where channel_id=${session(request).channelId}`;
    const merged = channelSettingsSchema.parse({ ...(current?.settings as object), ...patch });
    const [updated] = await sql`
      update settings set tone=${merged.tone}, voice=${merged.voice}, toxicity=${merged.toxicity},
       cooldown_sec=${merged.cooldownSec}, user_cooldown_sec=${merged.userCooldownSec},
       triggers=${sql.json(merged.triggers)}, stop_words=${merged.stopWords}, enabled=${merged.enabled},
       updated_at=now() where channel_id=${session(request).channelId} returning *`;
    return updated;
  });
  app.post("/settings/enabled", { preHandler: requireUser }, async (request) => {
    const { enabled } = z.object({ enabled: z.boolean() }).parse(request.body);
    await sql`update settings set enabled=${enabled}, updated_at=now()
      where channel_id=${session(request).channelId}`;
    return { enabled };
  });

  app.get("/rewards", { preHandler: requireUser }, async (request) => {
    const { channelId } = session(request);
    try {
      let credentials = await channelAccessToken(channelId);
      if (!credentials) return { available: false, reason: "reauth_required", rewards: [] };
      try {
        return {
          available: true,
          rewards: await getRewards(
            credentials.token,
            config.TWITCH_CLIENT_ID,
            credentials.twitchId
          )
        };
      } catch (error) {
        if (!(error instanceof TwitchApiError) || error.status !== 401) throw error;
        credentials = await channelAccessToken(channelId, true);
        if (!credentials) throw error;
        return {
          available: true,
          rewards: await getRewards(
            credentials.token,
            config.TWITCH_CLIENT_ID,
            credentials.twitchId
          )
        };
      }
    } catch (error) {
      if (error instanceof TwitchApiError) {
        // Helix answers 403 for channels without affiliate/partner status: no Channel Points.
        const reason =
          error.status === 403
            ? "not_affiliate"
            : error.status === 400 || error.status === 401
              ? "reauth_required"
              : "twitch_unavailable";
        return { available: false, reason, rewards: [] };
      }
      throw error;
    }
  });

  // ---- DonationAlerts ----------------------------------------------------------------------
  // An integration of an already signed-in channel, never a way to sign in: the callback needs
  // the RoastBot session that started it and only stores tokens for that session's channel.
  const daConfig: DonationAlertsConfig | undefined =
    config.DONATIONALERTS_CLIENT_ID && config.DONATIONALERTS_CLIENT_SECRET
      ? {
          clientId: config.DONATIONALERTS_CLIENT_ID,
          clientSecret: config.DONATIONALERTS_CLIENT_SECRET,
          redirectUri: `${config.PUBLIC_URL}/integrations/donationalerts/callback`
        }
      : undefined;
  const DA_STATE_COOKIE = "da_oauth_state";
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
        ...cookieOptions,
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

  const channelStatus = async (request: FastifyRequest) => {
    const month = currentMonth();
    const [row] = await sql<
      {
        enabled: boolean;
        userStatus: string;
        used: number;
        limit: number;
        gifted: number;
        plan: string | null;
      }[]
    >`
      select s.enabled, u.status "userStatus", coalesce(um.roasts,0)::int used, p.code plan,
        coalesce(p.monthly_roast_limit,0)::int "limit",
        coalesce((select sum(amount-used) from gifted_quota
          where channel_id=c.id and month=${month}),0)::int gifted
      from channels c join users u on u.id=c.user_id join settings s on s.channel_id=c.id
      left join lateral (
        select plan_id from subscriptions sub where sub.user_id=c.user_id
        and (sub.valid_until is null or sub.valid_until>now()) order by sub.created_at desc limit 1
      ) sub on true
      left join plans p on p.id=sub.plan_id
      left join usage_monthly um on um.channel_id=c.id and um.month=${month}
      where c.id=${session(request).channelId}`;
    if (!row) throw new Error("channel_not_found");
    const [global] = await sql<
      { used: number; spent: number; cap: number; budget: number; kill: boolean }[]
    >`
      select coalesce(sum(roasts),0)::int used, coalesce(sum(cost_usd),0)::float8 spent,
        coalesce((select (value #>> '{}')::int from global_settings where key='global_monthly_limit'),
          ${DEFAULT_GLOBAL_MONTHLY_ROAST_CAP})::int cap,
        coalesce((select (value #>> '{}')::float8 from global_settings where key='monthly_budget_usd'),
          ${DEFAULT_MONTHLY_BUDGET_USD})::float8 budget,
        coalesce((select (value #>> '{}')::boolean from global_settings where key='kill_switch'),false) kill
      from usage_monthly where month=${month}`;
    const globalLimitReached =
      (global?.used ?? 0) >= (global?.cap ?? DEFAULT_GLOBAL_MONTHLY_ROAST_CAP) ||
      (global?.spent ?? 0) >= (global?.budget ?? DEFAULT_MONTHLY_BUDGET_USD);
    const remaining = Math.max(0, row.limit + row.gifted - row.used);
    const killSwitch = global?.kill ?? false;
    const state =
      row.userStatus !== "active"
        ? "suspended"
        : !row.enabled || killSwitch
          ? "paused"
          : remaining === 0 || globalLimitReached
            ? "limit"
            : "working";
    const channelId = session(request).channelId;
    const [eventsub] = await sql<{ connected: boolean; subscriptions: Record<string, string> }[]>`
      select connected, subscriptions from eventsub_state where channel_id=${channelId}`;
    return {
      month,
      plan: row.plan,
      // Is it actually on air: the overlay page is open somewhere (OBS), and Twitch accepted our
      // EventSub subscriptions (null when the channel needs none).
      overlayConnected: [...overlayConnections].some(
        (connection) =>
          connection.channelId === channelId &&
          connection.socket.readyState === connection.socket.OPEN
      ),
      twitchEvents: eventsub
        ? {
            connected: eventsub.connected,
            failed: Object.entries(eventsub.subscriptions)
              .filter(([, result]) => result !== "ok")
              .map(([type]) => type)
          }
        : null,
      // `!роаст` is a paid feature; the panel shows the switch disabled on the free plan.
      commandAvailable: COMMAND_PLANS.has(row.plan ?? ""),
      enabled: row.enabled,
      used: row.used,
      limit: row.limit,
      gifted: row.gifted,
      remaining,
      globalLimitReached,
      killSwitch,
      state
    };
  };
  app.get("/status", { preHandler: requireUser }, channelStatus);
  app.get("/quota", { preHandler: requireUser }, channelStatus);

  app.post("/roasts/test", { preHandler: requireUser }, async (request) => {
    const body = testRoastRequestSchema.parse(request.body ?? {});
    const { channelId } = session(request);
    const { eventId, roastId } = await sql.begin(async (tx) => {
      const [event] = await tx<{ id: string }[]>`
        insert into events (channel_id,type,provider_event_id,raw)
        values (${channelId},'dashboard_test',${randomUUID()},${sql.json(body)}) returning id`;
      if (!event) throw new Error("Event insert failed");
      const [roast] = await tx<{ id: string }[]>`
        insert into roasts(channel_id,event_id,source,viewer_login,input_text,tone,voice,toxicity)
        select ${channelId},${event.id},'dashboard_test',${body.viewerLogin},
          ${body.inputText},tone,voice,toxicity from settings
        where channel_id=${channelId} returning id`;
      if (!roast) throw new Error("Roast insert failed");
      return { eventId: event.id, roastId: roast.id };
    });
    // Enqueue only after commit: the worker must be able to see the event row.
    await boss.send(ROAST_REQUESTED_QUEUE, {
      jobVersion: 1,
      eventId,
      channelId,
      source: "dashboard_test",
      ...body,
      requestedAt: new Date().toISOString()
    });
    return { roastId, status: "queued" };
  });

  // What reached the bot lately and how it ended, plus Twitch's answer to our subscriptions: a
  // streamer whose reward "does nothing" sees here whether the redemption arrived at all.
  app.get("/activity", { preHandler: requireUser }, async (request) => {
    const { channelId } = session(request);
    const roasts = await sql`
      select r.id, r.created_at "createdAt", r.source, r.viewer_login "viewerLogin",
        left(r.input_text, 120) "inputText", r.output_text "outputText", r.status, r.error,
        o.status "overlayStatus"
      from roasts r left join overlay_events o on o.roast_id=r.id
      where r.channel_id=${channelId} order by r.created_at desc limit 15`;
    const [eventsub] = await sql`
      select connected, subscriptions, updated_at "updatedAt" from eventsub_state
      where channel_id=${channelId}`;
    return { roasts, eventsub: eventsub ?? null };
  });

  app.get("/roasts/:id", { preHandler: requireUser }, async (request, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    const [row] = await sql`
      select r.id, r.status, r.output_text "outputText", r.error, r.latency_ms "latencyMs",
        r.created_at "createdAt", o.status "overlayStatus"
      from roasts r left join overlay_events o on o.roast_id=r.id
      where r.id=${id} and r.channel_id=${session(request).channelId}`;
    if (!row)
      return reply.code(404).send({ error: { code: "not_found", message: "Роаст не найден" } });
    return row;
  });

  app.get("/audio/:filename", async (request, reply) => {
    const { filename } = z.object({ filename: z.string() }).parse(request.params);
    const query = z
      .object({ expires: z.coerce.number().int(), sig: z.string() })
      .safeParse(request.query);
    if (
      !query.success ||
      !verifyAudioSignature(
        filename,
        query.data.expires,
        query.data.sig,
        config.AUDIO_SIGNING_SECRET
      )
    ) {
      return reply
        .code(403)
        .send({ error: { code: "invalid_signature", message: "Ссылка истекла" } });
    }
    const path = join(config.AUDIO_DIR, basename(filename));
    const metadata = await stat(path).catch(() => null);
    if (!metadata?.isFile()) {
      return reply.code(404).send({ error: { code: "not_found", message: "Аудио удалено" } });
    }
    reply.header("cache-control", "no-store");
    reply.header("content-length", String(metadata.size));
    reply.type("audio/wav");
    return reply.send(createReadStream(path));
  });

  app.get("/overlay/:token", { websocket: true }, (socket, request) => {
    const token = (request.params as { token: string }).token;
    let connection: OverlayConnection | undefined;
    let heartbeat: NodeJS.Timeout | undefined;

    // Registered first and fully guarded: the socket is reachable before authentication, so a
    // malformed frame from anyone must never throw out of the ws receiver.
    socket.on("message", (raw: Buffer | ArrayBuffer | Buffer[]) => {
      if (!connection) return;
      try {
        const text = Array.isArray(raw)
          ? Buffer.concat(raw).toString("utf8")
          : Buffer.from(raw instanceof ArrayBuffer ? new Uint8Array(raw) : raw).toString("utf8");
        if (text.length > 4_096) return;
        const parsed = overlayClientEventSchema.safeParse(JSON.parse(text));
        if (parsed.success && parsed.data.type === "overlay.ack") {
          sql`update overlay_events set status='delivered', delivered_at=now()
            where id=${parsed.data.eventId} and channel_id=${connection.channelId}`.catch(
            (error: unknown) => request.log.error(error, "overlay ack")
          );
        }
      } catch {
        // Ignore frames that are not valid JSON.
      }
    });
    socket.on("close", () => {
      if (heartbeat) clearInterval(heartbeat);
      if (connection) overlayConnections.delete(connection);
    });
    socket.on("error", (error) => request.log.warn(error, "overlay socket error"));

    void (async () => {
      const [channel] = await sql<
        { id: string }[]
      >`select id from channels where overlay_token=${token}`;
      if (!channel) return socket.close(1008, "invalid token");
      if (socket.readyState !== socket.OPEN) return;
      connection = { socket, channelId: channel.id, sent: new Set() };
      overlayConnections.add(connection);
      sendJson(socket, {
        version: 1,
        type: "overlay.ready",
        eventId: randomUUID(),
        sentAt: new Date().toISOString()
      });
      heartbeat = setInterval(() => {
        sendJson(socket, {
          version: 1,
          type: "overlay.ping",
          eventId: randomUUID(),
          sentAt: new Date().toISOString()
        });
      }, 25_000);
      await deliverPending(connection);
    })().catch((error: unknown) => {
      request.log.error(error, "overlay connection");
      socket.close(1011);
    });
  });

  // ---- back-office ------------------------------------------------------------------------
  async function audit(
    tx: TransactionSql,
    request: FastifyRequest,
    action: string,
    target: string,
    payload: JSONValue
  ) {
    await tx`insert into audit_log(actor_user_id,action,target,payload)
      values(${session(request).userId},${action},${target},${sql.json(payload)})`;
  }

  app.get("/admin/overview", { preHandler: requireOwner }, async () => {
    const month = currentMonth();
    const [row] = await sql<
      {
        usersTotal: number;
        usersActive: number;
        usersPending: number;
        activeChannelsHour: number;
        roastsToday: number;
        errorsToday: number;
        blockedToday: number;
        skippedToday: number;
        roastsMonth: number;
        spentMonth: number;
        roastCap: number;
        budget: number;
        killSwitch: boolean;
        pendingModeration: number;
      }[]
    >`
      select
        (select count(*) from users)::int "usersTotal",
        (select count(*) from users where status='active')::int "usersActive",
        (select count(*) from users where status='pending')::int "usersPending",
        (select count(distinct channel_id) from roasts where created_at>now()-interval '1 hour')::int
          "activeChannelsHour",
        (select count(*) from roasts where created_at>=date_trunc('day',now())
          and status in ('done','blocked_output'))::int "roastsToday",
        (select count(*) from roasts where created_at>=date_trunc('day',now())
          and status='failed')::int "errorsToday",
        (select count(*) from roasts where created_at>=date_trunc('day',now())
          and status in ('blocked_input','blocked_output'))::int "blockedToday",
        (select count(*) from roasts where created_at>=date_trunc('day',now())
          and status='skipped')::int "skippedToday",
        (select coalesce(sum(roasts),0) from usage_monthly where month=${month})::int "roastsMonth",
        (select coalesce(sum(cost_usd),0) from usage_monthly where month=${month})::float8 "spentMonth",
        coalesce((select (value #>> '{}')::int from global_settings where key='global_monthly_limit'),
          ${DEFAULT_GLOBAL_MONTHLY_ROAST_CAP})::int "roastCap",
        coalesce((select (value #>> '{}')::float8 from global_settings where key='monthly_budget_usd'),
          ${DEFAULT_MONTHLY_BUDGET_USD})::float8 budget,
        coalesce((select (value #>> '{}')::boolean from global_settings where key='kill_switch'),false)
          "killSwitch",
        (select count(*) from roasts where moderation_reviewed_at is null
          and status in ('blocked_input','blocked_output'))::int "pendingModeration"`;
    const [tts] = await sql<
      { requests: number; limitRub: number; elevenLabsChars: number; elevenLabsLimit: number }[]
    >`
      select coalesce((select requests from tts_usage_monthly
          where provider='yandex' and month=${yandexBillingMonth(new Date())}),0)::int requests,
        coalesce((select (value #>> '{}')::float8 from global_settings
          where key='yandex_tts_monthly_limit_rub'), ${DEFAULT_YANDEX_TTS_MONTHLY_LIMIT_RUB})::float8 "limitRub",
        coalesce((select requests from tts_usage_monthly
          where provider='elevenlabs' and month=${new Date().toISOString().slice(0, 7)}),0)::int
          "elevenLabsChars",
        coalesce((select (value #>> '{}')::int from global_settings
          where key='elevenlabs_monthly_char_limit'), ${DEFAULT_ELEVENLABS_MONTHLY_CHAR_LIMIT})::int
          "elevenLabsLimit"`;
    return {
      ...row,
      yandexTtsSpentRub: Math.round((tts?.requests ?? 0) * YANDEX_TTS_RUB_PER_REQUEST * 100) / 100,
      yandexTtsLimitRub: tts?.limitRub ?? DEFAULT_YANDEX_TTS_MONTHLY_LIMIT_RUB,
      elevenLabsChars: tts?.elevenLabsChars ?? 0,
      elevenLabsLimit: tts?.elevenLabsLimit ?? DEFAULT_ELEVENLABS_MONTHLY_CHAR_LIMIT
    };
  });

  app.get("/admin/users", { preHandler: requireOwner }, async (request) => {
    const q = z
      .object({
        search: z.string().max(64).default(""),
        limit: z.coerce.number().int().min(1).max(100).default(50)
      })
      .parse(request.query);
    const month = currentMonth();
    return sql`
      select u.id, u.twitch_id, u.login, u.display_name, u.role, u.status, u.created_at,
        u.totp_enabled_at is not null mfa_enabled, c.id channel_id, c.twitch_login, s.enabled,
        coalesce(p.code::text,'none') plan, sub.valid_until,
        coalesce(um.roasts,0)::int used, coalesce(p.monthly_roast_limit,0)::int "limit",
        coalesce(um.cost_usd,0)::float8 cost_usd,
        coalesce((select sum(amount-used) from gifted_quota g
          where g.channel_id=c.id and g.month=${month}),0)::int gifted
      from users u left join channels c on c.user_id=u.id
      left join settings s on s.channel_id=c.id
      left join lateral (
        select plan_id, valid_until from subscriptions where user_id=u.id
        and (valid_until is null or valid_until>now()) order by created_at desc limit 1
      ) sub on true
      left join plans p on p.id=sub.plan_id
      left join usage_monthly um on um.channel_id=c.id and um.month=${month}
      where u.login ilike ${`%${q.search}%`}
      order by u.status='pending' desc, u.created_at desc limit ${q.limit}`;
  });

  const userIdParams = z.object({ id: z.string().uuid() });
  app.post("/admin/users/:id/suspend", { preHandler: requireOwner }, async (request) => {
    const { id } = userIdParams.parse(request.params);
    await sql.begin(async (tx) => {
      await tx`update users set status='suspended' where id=${id}`;
      await audit(tx, request, "user.suspend", id, {});
    });
    return { id, status: "suspended" };
  });
  app.post("/admin/users/:id/activate", { preHandler: requireOwner }, async (request) => {
    const { id } = userIdParams.parse(request.params);
    await sql.begin(async (tx) => {
      await tx`update users set status='active' where id=${id}`;
      await audit(tx, request, "user.activate", id, {});
    });
    return { id, status: "active" };
  });
  // Support case: a streamer lost the phone and the recovery codes. The owner's own factor is
  // never reset from the UI: a stolen owner session must not be able to drop the owner's 2FA.
  app.post("/admin/users/:id/mfa/reset", { preHandler: requireOwner }, async (request, reply) => {
    const { id } = userIdParams.parse(request.params);
    if (id === session(request).userId) {
      return denied(reply, 400, "mfa_self_reset", "Свою 2FA сбросить нельзя");
    }
    await sql.begin(async (tx) => {
      await tx`update users set totp_secret_ciphertext=null, totp_secret_iv=null,
        totp_secret_tag=null, totp_enabled_at=null, totp_last_step=null,
        mfa_recovery_hashes=ARRAY[]::text[], mfa_failed_attempts=0, mfa_locked_until=null
        where id=${id}`;
      await audit(tx, request, "mfa.reset", id, {});
    });
    return { id, mfaEnabled: false };
  });

  // Pre-approval by Twitch login: whoever signs in with it skips the review queue once.
  app.get(
    "/admin/invites",
    { preHandler: requireOwner },
    async () =>
      sql`select i.login, i.created_at, i.used_at, u.login used_by_login
      from invites i left join users u on u.id=i.used_by_user_id
      order by i.used_at is not null, i.created_at desc limit 200`
  );
  app.post("/admin/invites", { preHandler: requireOwner }, async (request) => {
    const { login } = z.object({ login: twitchLoginSchema }).parse(request.body);
    const approvedExisting = await sql.begin(async (tx) => {
      await tx`insert into invites(login,created_by_user_id)
        values(${login},${session(request).userId}) on conflict (login) do nothing`;
      // Someone with this login already signed in and waits for review: approve right away.
      const [waiting] = await tx<{ id: string }[]>`
        update users set status='active' where login=${login} and status='pending' returning id`;
      if (waiting) {
        await tx`update invites set used_at=now(), used_by_user_id=${waiting.id}
          where login=${login} and used_at is null`;
      }
      await audit(tx, request, "invite.create", login, { approvedExisting: Boolean(waiting) });
      return Boolean(waiting);
    });
    return { login, approvedExisting };
  });
  app.delete("/admin/invites/:login", { preHandler: requireOwner }, async (request) => {
    const { login } = z.object({ login: twitchLoginSchema }).parse(request.params);
    const deleted = await sql.begin(async (tx) => {
      const rows = await tx`delete from invites where login=${login} and used_at is null
        returning login`;
      await audit(tx, request, "invite.delete", login, {});
      return rows.length > 0;
    });
    return { login, deleted };
  });

  app.post("/admin/users/:id/subscription", { preHandler: requireOwner }, async (request) => {
    const { id } = userIdParams.parse(request.params);
    const body = z
      .object({
        plan: z.enum(["free", "basic", "premium"]),
        validUntil: z.string().datetime().nullable()
      })
      .parse(request.body);
    await sql.begin(async (tx) => {
      const inserted = await tx`insert into subscriptions(user_id,plan_id,valid_until)
        select ${id},id,${body.validUntil} from plans where code=${body.plan} returning id`;
      if (!inserted.length) throw Object.assign(new Error("Тариф не найден"), { statusCode: 404 });
      await audit(tx, request, "subscription.set", id, body);
    });
    return { id, ...body };
  });
  app.post("/admin/users/:id/gift", { preHandler: requireOwner }, async (request) => {
    const { id } = userIdParams.parse(request.params);
    const body = z
      .object({
        amount: z.number().int().positive().max(100_000),
        reason: z.string().max(500).optional()
      })
      .parse(request.body);
    await sql.begin(async (tx) => {
      const inserted =
        await tx`insert into gifted_quota(channel_id,month,amount,granted_by_user_id,reason)
        select id,${currentMonth()},${body.amount},${session(request).userId},${body.reason ?? null}
        from channels where user_id=${id} returning id`;
      if (!inserted.length) throw Object.assign(new Error("Канал не найден"), { statusCode: 404 });
      await audit(tx, request, "quota.gift", id, body);
    });
    return { id, ...body };
  });

  app.get("/admin/roasts", { preHandler: requireOwner }, async (request) => {
    const q = z
      .object({
        channelId: z.string().uuid().optional(),
        status: roastStatusSchema.optional(),
        from: z.string().datetime().optional(),
        to: z.string().datetime().optional(),
        limit: z.coerce.number().int().min(1).max(200).default(50)
      })
      .parse(request.query);
    return sql`select r.*, c.twitch_login from roasts r join channels c on c.id=r.channel_id
      where (${q.channelId ?? null}::uuid is null or r.channel_id=${q.channelId ?? null})
      and (${q.status ?? null}::text is null or r.status::text=${q.status ?? null})
      and (${q.from ?? null}::timestamptz is null or r.created_at>=${q.from ?? null})
      and (${q.to ?? null}::timestamptz is null or r.created_at<=${q.to ?? null})
      order by r.created_at desc limit ${q.limit}`;
  });

  app.get("/admin/moderation", { preHandler: requireOwner }, async () => {
    const [row] = await sql<{ value: string[] }[]>`
      select value from global_settings where key='global_stop_words'`;
    return { words: row?.value ?? [] };
  });
  app.put("/admin/moderation", { preHandler: requireOwner }, async (request) => {
    const words = [...new Set(stopWordsSchema.parse(request.body))];
    await sql.begin(async (tx) => {
      await tx`insert into global_settings(key,value) values('global_stop_words',${sql.json(words)})
        on conflict(key) do update set value=excluded.value,updated_at=now()`;
      await audit(tx, request, "global_stop_words.update", "global_stop_words", { words });
    });
    return { words };
  });
  app.get(
    "/admin/moderation/queue",
    { preHandler: requireOwner },
    async () =>
      sql`select r.id, r.channel_id, c.twitch_login, r.viewer_login, r.input_text, r.output_text,
        r.status, r.error, r.created_at
      from roasts r join channels c on c.id=r.channel_id
      where r.moderation_reviewed_at is null and r.status in ('blocked_input','blocked_output')
      order by r.created_at desc limit 100`
  );
  app.post("/admin/roasts/:id/review", { preHandler: requireOwner }, async (request, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    const body = z
      .object({ addStopWord: z.string().trim().min(1).max(100).optional() })
      .parse(request.body ?? {});
    const result = await sql.begin(async (tx) => {
      const updated = await tx`update roasts set moderation_reviewed_at=now()
        where id=${id} and moderation_reviewed_at is null and status in ('blocked_input','blocked_output')
        returning id`;
      if (!updated.length) return false;
      if (body.addStopWord) {
        await tx`insert into global_settings(key,value) values('global_stop_words',${sql.json([body.addStopWord])})
          on conflict(key) do update set value=(
            select coalesce(jsonb_agg(distinct w),'[]'::jsonb)
            from jsonb_array_elements_text(global_settings.value || excluded.value) w
          ),updated_at=now()`;
      }
      await audit(tx, request, "moderation.review", id, body);
      return true;
    });
    if (!result)
      return reply.code(404).send({ error: { code: "not_found", message: "Нет в очереди" } });
    return { id, reviewed: true };
  });

  app.get(
    "/admin/settings",
    { preHandler: requireOwner },
    async () => sql`select key, value, updated_at from global_settings order by key`
  );
  app.put("/admin/settings/:key", { preHandler: requireOwner }, async (request) => {
    const { key } = z
      .object({
        key: z.enum(Object.keys(globalSettingSchemas) as [GlobalSettingKey, ...GlobalSettingKey[]])
      })
      .parse(request.params);
    const value = globalSettingSchemas[key].parse(request.body);
    await sql.begin(async (tx) => {
      await tx`insert into global_settings(key,value) values(${key},${sql.json(value)})
        on conflict(key) do update set value=excluded.value,updated_at=now()`;
      await audit(tx, request, "global_setting.update", key, { value });
    });
    return { key, value };
  });
  app.get("/admin/audit", { preHandler: requireOwner }, async (request) => {
    const { limit } = z
      .object({ limit: z.coerce.number().int().min(1).max(200).default(100) })
      .parse(request.query);
    return sql`select a.*, u.login actor_login from audit_log a
      left join users u on u.id=a.actor_user_id order by a.created_at desc limit ${limit}`;
  });

  app.addHook("onClose", async () => {
    for (const connection of overlayConnections) connection.socket.close(1001, "server shutdown");
    await overlayListener.unlisten();
    await boss.stop({ graceful: false });
    await database.close();
  });
  return app;
}
