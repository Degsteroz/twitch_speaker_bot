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

export function session(request: FastifyRequest): Session {
  return request.user as Session;
}

export const denied = (reply: FastifyReply, status: number, code: string, message: string) =>
  reply.code(status).send({ error: { code, message } });
