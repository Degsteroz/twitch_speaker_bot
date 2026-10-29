// What the route modules share with app.ts: the session claims, the guards and the audit log.
import type { createDatabase } from "@roastbot/db";
import type { FastifyReply, FastifyRequest } from "fastify";
import type { PgBoss } from "pg-boss";
import type { JSONValue, TransactionSql } from "postgres";

import type { ApiConfig } from "./config.js";

export interface Session {
  userId: string;
  channelId: string;
  role: "owner" | "user";
  /** Epoch ms when the second factor was confirmed in this session; absent until then. */
  mfaAt?: number;
}

export type Sql = ReturnType<typeof createDatabase>["client"];
type Guard = (request: FastifyRequest, reply: FastifyReply) => Promise<unknown>;

export interface RouteContext {
  sql: Sql;
  boss: PgBoss;
  config: ApiConfig;
  /** Only proves the Twitch login: for the session probe, the 2FA screens and logout. */
  requireSession: Guard;
  requireUser: Guard;
  requireOwner: Guard;
  audit: (
    tx: TransactionSql,
    request: FastifyRequest,
    action: string,
    target: string,
    payload: JSONValue
  ) => Promise<void>;
}

export const SESSION_COOKIE = "roastbot_session";
// Owner actions need a second factor confirmed within this window, even inside a 7-day session.
export const OWNER_MFA_MAX_AGE_MS = 12 * 60 * 60 * 1000;

export const currentMonth = () => new Date().toISOString().slice(0, 7);
export const currentDay = () => new Date().toISOString().slice(0, 10);

export const cookieOptions = (config: ApiConfig) => ({
  httpOnly: true,
  secure: config.NODE_ENV === "production",
  sameSite: "lax" as const,
  path: "/"
});

// Landing demo money of this month, part of the same budget as the roasts.
// The UTC month as a range, so the created_at index answers it instead of a scan.
export const demoSpend = (sql: Sql, month: string) => sql`(select coalesce(sum(cost_usd),0)
  from demo_requests
  where created_at >= (${month}::text || '-01')::timestamp at time zone 'UTC'
    and created_at < ((${month}::text || '-01')::timestamp + interval '1 month') at time zone 'UTC')`;

export function session(request: FastifyRequest): Session {
  return request.user as Session;
}

export const denied = (reply: FastifyReply, status: number, code: string, message: string) =>
  reply.code(status).send({ error: { code, message } });
