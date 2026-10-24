import { randomBytes, randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { runMigrations, seedDatabase } from "@roastbot/db";
import EmbeddedPostgres from "embedded-postgres";
import postgres from "postgres";

export interface TestDatabase {
  readonly url: string;
  readonly sql: postgres.Sql;
  stop(): Promise<void>;
}

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close(() =>
        typeof address === "object" && address
          ? resolve(address.port)
          : reject(new Error("no port"))
      );
    });
  });
}

/** A throwaway PostgreSQL 16 cluster with RoastBot migrations and seed applied. */
export async function startTestDatabase(): Promise<TestDatabase> {
  const databaseDir = await mkdtemp(join(tmpdir(), "roastbot-pg-"));
  const port = await freePort();
  const cluster = new EmbeddedPostgres({
    databaseDir,
    port,
    user: "roast",
    password: "roast",
    persistent: false,
    onLog: () => undefined,
    onError: () => undefined
  });
  await cluster.initialise();
  await cluster.start();
  await cluster.createDatabase("roast");
  const url = `postgres://roast:roast@127.0.0.1:${String(port)}/roast`;
  await runMigrations(url);
  await seedDatabase(url);
  const sql = postgres(url, { max: 4, onnotice: () => undefined });
  return {
    url,
    sql,
    async stop() {
      await sql.end({ timeout: 5 });
      await cluster.stop();
      await rm(databaseDir, { recursive: true, force: true });
    }
  };
}

export interface TestChannel {
  userId: string;
  channelId: string;
  twitchId: string;
  login: string;
  overlayToken: string;
}

export async function createTestChannel(
  sql: postgres.Sql,
  options: { role?: "owner" | "user"; plan?: "free" | "basic" | "premium"; login?: string } = {}
): Promise<TestChannel> {
  const twitchId = String(Math.floor(Math.random() * 1e9));
  const login = options.login ?? `streamer_${twitchId}`;
  const overlayToken = randomBytes(32).toString("base64url");
  const [user] = await sql<{ id: string }[]>`
    insert into users(twitch_id,login,display_name,role)
    values(${twitchId},${login},${login},${options.role ?? "user"}) returning id`;
  const [channel] = await sql<{ id: string }[]>`
    insert into channels(user_id,twitch_login,overlay_token)
    values(${user!.id},${login},${overlayToken}) returning id`;
  await sql`insert into settings(channel_id) values(${channel!.id})`;
  await sql`insert into subscriptions(user_id,plan_id)
    select ${user!.id}, id from plans where code=${options.plan ?? "free"}`;
  return { userId: user!.id, channelId: channel!.id, twitchId, login, overlayToken };
}

export async function createTestEvent(
  sql: postgres.Sql,
  channelId: string,
  type: "chat_command" | "reward" | "dashboard_test" = "chat_command"
): Promise<string> {
  const [event] = await sql<{ id: string }[]>`
    insert into events(channel_id,type,provider_event_id,raw)
    values(${channelId},${type},${randomUUID()},'{}'::jsonb) returning id`;
  return event!.id;
}
