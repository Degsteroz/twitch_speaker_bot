import { createDecipheriv, createCipheriv, randomBytes } from "node:crypto";

import type { createDatabase } from "@roastbot/db";
import {
  DEFAULT_COMMAND,
  ROAST_REQUESTED_QUEUE,
  type RoastSource,
  type RoastTarget
} from "@roastbot/shared";
import type { PgBoss } from "pg-boss";
import type { JSONValue } from "postgres";

type Sql = ReturnType<typeof createDatabase>["client"];

/** "!роаст текст" → "текст", a bare command → the viewer; `command` is the channel's own one. */
export function parseRoastCommand(
  message: string,
  fallbackLogin: string,
  command = DEFAULT_COMMAND
): string | null {
  const text = message.trim();
  const [word = ""] = text.split(/\s/u, 1);
  if (word.toLocaleLowerCase("ru-RU") !== command.toLocaleLowerCase("ru-RU")) return null;
  return text.slice(word.length).trim() || fallbackLogin;
}

/**
 * Cheap pre-check so chat spam during a cooldown never reaches the queue. The worker still makes
 * the authoritative, locked reservation; this only filters the obvious repeats.
 */
export async function isOnCooldown(
  sql: Sql,
  channelId: string,
  viewerLogin: string
): Promise<boolean> {
  const rows = await sql`
    select 1 from cooldown_state where channel_id=${channelId} and next_allowed_at>now()
    and ((scope='channel' and subject_key='*') or (scope='viewer' and subject_key=${viewerLogin}))
    limit 1`;
  return rows.length > 0;
}

export async function enqueueEvent(
  sql: Sql,
  boss: PgBoss,
  input: {
    channelId: string;
    source: RoastSource;
    providerEventId: string;
    viewerId?: string;
    viewerLogin: string;
    inputText: string;
    target: RoastTarget;
    eventSummary?: string;
    /** The channel's Twitch category, already filtered with gameContext(). */
    game?: string;
    /** Hold the job this long, e.g. until a donation alert has been read out. */
    delaySeconds?: number;
    /** A reward the frequency passed over: the worker answers with a stub. */
    declined?: boolean;
    /** A chat word that calls the character by name: the worker may answer it with a stub. */
    named?: boolean;
    /** pg-boss priority; the streamer's own requests get STREAMER_JOB_PRIORITY. */
    priority?: number;
    raw: JSONValue;
  }
): Promise<boolean> {
  const [event] = await sql<{ id: string }[]>`
    insert into events(channel_id,type,provider_event_id,raw)
    values(${input.channelId},${input.source},${input.providerEventId},${sql.json(input.raw)})
    on conflict(channel_id,provider_event_id) where provider_event_id is not null do nothing returning id`;
  if (!event) return false;
  await boss.send(
    ROAST_REQUESTED_QUEUE,
    {
      jobVersion: 1,
      eventId: event.id,
      channelId: input.channelId,
      source: input.source,
      ...(input.viewerId ? { viewerId: input.viewerId } : {}),
      viewerLogin: input.viewerLogin,
      inputText: input.inputText.slice(0, 2_000),
      target: input.target,
      ...(input.eventSummary ? { eventSummary: input.eventSummary.slice(0, 500) } : {}),
      ...(input.game ? { game: input.game.slice(0, 100) } : {}),
      ...(input.declined ? { declined: true } : {}),
      ...(input.named ? { named: true } : {}),
      requestedAt: new Date().toISOString()
    },
    {
      ...(input.delaySeconds ? { startAfter: input.delaySeconds } : {}),
      ...(input.priority ? { priority: input.priority } : {})
    }
  );
  return true;
}

export function reconnectDelayMs(attempt: number, random = Math.random()): number {
  return Math.min(60_000, 2_000 * 2 ** Math.min(attempt, 5)) * (0.8 + random * 0.4);
}

export interface CipherValue {
  ciphertext: string;
  iv: string;
  tag: string;
}

export function decryptToken(value: CipherValue, keyHex: string): string {
  const decipher = createDecipheriv(
    "aes-256-gcm",
    Buffer.from(keyHex, "hex"),
    Buffer.from(value.iv, "base64url")
  );
  decipher.setAuthTag(Buffer.from(value.tag, "base64url"));
  return Buffer.concat([
    decipher.update(Buffer.from(value.ciphertext, "base64url")),
    decipher.final()
  ]).toString("utf8");
}

export function encryptToken(value: string, keyHex: string): CipherValue {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", Buffer.from(keyHex, "hex"), iv);
  return {
    ciphertext: Buffer.concat([cipher.update(value), cipher.final()]).toString("base64url"),
    iv: iv.toString("base64url"),
    tag: cipher.getAuthTag().toString("base64url")
  };
}
