import cookie from "@fastify/cookie";
import jwt from "@fastify/jwt";
import websocket from "@fastify/websocket";
import { createDatabase } from "@roastbot/db";
import {
  DEMO_REQUESTED_QUEUE,
  DEMO_REQUESTED_QUEUE_OPTIONS,
  ROAST_REQUESTED_QUEUE,
  ROAST_REQUESTED_QUEUE_OPTIONS,
  VOICE_SAMPLE_QUEUE
} from "@roastbot/shared";
import Fastify, { type FastifyReply, type FastifyRequest } from "fastify";
import { PgBoss } from "pg-boss";
import type { JSONValue, TransactionSql } from "postgres";
import { ZodError } from "zod";

import { registerAdminRoutes } from "./admin.js";
import { registerAuthRoutes } from "./auth.js";
import type { ApiConfig } from "./config.js";
import {
  denied,
  OWNER_MFA_MAX_AGE_MS,
  session,
  SESSION_COOKIE,
  type RouteContext
} from "./context.js";
import { registerCharacterRoutes } from "./characters.js";
import { registerDashboardRoutes } from "./dashboard.js";
import { registerDemoRoutes } from "./demo.js";
import { registerIntegrationRoutes } from "./integrations.js";
import { registerInviteRoutes } from "./invites.js";
import { registerMfaRoutes } from "./mfa.js";
import { registerOverlayRoutes } from "./overlay.js";
import { registerShowcaseRoutes } from "./showcase.js";
import { registerTelegramRoutes } from "./telegram-bot.js";

export async function buildApp(config: ApiConfig) {
  const app = Fastify({ logger: config.NODE_ENV !== "test", trustProxy: true });
  const database = createDatabase(config.DATABASE_URL, { applicationName: "roastbot-api" });
  const sql = database.client;
  const boss = new PgBoss(config.DATABASE_URL);
  boss.on("error", (error) => app.log.error(error, "pg-boss error"));
  await boss.start();
  await boss.createQueue(ROAST_REQUESTED_QUEUE, { ...ROAST_REQUESTED_QUEUE_OPTIONS });
  await boss.createQueue(DEMO_REQUESTED_QUEUE, { ...DEMO_REQUESTED_QUEUE_OPTIONS });
  await boss.createQueue(VOICE_SAMPLE_QUEUE);

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
    // With open registration suspension is the owner's main tool: it closes the panel at once.
    if (user.status === "suspended") {
      return denied(reply, 403, "account_suspended", "Аккаунт приостановлен владельцем");
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

  const routeContext: RouteContext = {
    sql,
    boss,
    config,
    requireSession,
    requireUser,
    requireOwner,
    audit
  };
  const overlays = await registerOverlayRoutes(app, routeContext);
  registerAuthRoutes(app, routeContext);
  registerMfaRoutes(app, routeContext);
  registerDashboardRoutes(app, routeContext, overlays);
  registerIntegrationRoutes(app, routeContext);
  registerDemoRoutes(app, routeContext);
  registerInviteRoutes(app, routeContext);
  registerShowcaseRoutes(app, routeContext);
  registerCharacterRoutes(app, routeContext);
  registerTelegramRoutes(app, routeContext);
  registerAdminRoutes(app, routeContext);

  app.addHook("onClose", async () => {
    await overlays.shutdown();
    await boss.stop({ graceful: false });
    await database.close();
  });
  return app;
}
