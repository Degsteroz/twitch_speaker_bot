import {
  ROAST_REQUESTED_QUEUE,
  ROAST_REQUESTED_QUEUE_OPTIONS,
  STREAMER_JOB_PRIORITY
} from "@roastbot/shared";
import { createTestChannel, startTestDatabase, type TestDatabase } from "@roastbot/testing";
import { PgBoss } from "pg-boss";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { enqueueEvent, isOnCooldown } from "./core.js";

let db: TestDatabase;
let boss: PgBoss;

beforeAll(async () => {
  db = await startTestDatabase();
  boss = new PgBoss(db.url);
  await boss.start();
  await boss.createQueue(ROAST_REQUESTED_QUEUE, { ...ROAST_REQUESTED_QUEUE_OPTIONS });
}, 120_000);

afterAll(async () => {
  await boss?.stop({ graceful: false });
  await db?.stop();
});

describe("chat intake", () => {
  it("deduplicates provider events and enqueues a valid job", async () => {
    const channel = await createTestChannel(db.sql);
    const input = {
      channelId: channel.channelId,
      source: "chat_command" as const,
      providerEventId: "irc-msg-1",
      viewerLogin: "viewer",
      inputText: "мой aim",
      target: "viewer" as const,
      raw: { message: "!роаст мой aim" }
    };
    expect(await enqueueEvent(db.sql, boss, input)).toBe(true);
    expect(await enqueueEvent(db.sql, boss, input)).toBe(false);
    const [event] = await db.sql<{ raw: { message: string } }[]>`
      select raw from events where channel_id=${channel.channelId}`;
    expect(event!.raw).toEqual({ message: "!роаст мой aim" });
    const jobs = await db.sql<{ data: { source: string; inputText: string } }[]>`
      select data from pgboss.job where name=${ROAST_REQUESTED_QUEUE}
      and data->>'channelId'=${channel.channelId}`;
    expect(jobs).toHaveLength(1);
    expect(jobs[0]!.data).toMatchObject({ source: "chat_command", inputText: "мой aim" });
  });

  it("puts the streamer's own request ahead of the viewers' in the queue", async () => {
    const channel = await createTestChannel(db.sql);
    const base = {
      channelId: channel.channelId,
      source: "chat_keyword" as const,
      inputText: "ну что",
      target: "viewer" as const,
      raw: {}
    };
    await enqueueEvent(db.sql, boss, { ...base, providerEventId: "v1", viewerLogin: "viewer" });
    await enqueueEvent(db.sql, boss, {
      ...base,
      providerEventId: "s1",
      viewerLogin: channel.login,
      target: "streamer",
      priority: STREAMER_JOB_PRIORITY
    });
    const [first] = await boss.fetch<{ viewerLogin: string }>(ROAST_REQUESTED_QUEUE);
    expect(first!.data.viewerLogin).toBe(channel.login);
  });

  it("pre-filters channel and viewer cooldowns", async () => {
    const channel = await createTestChannel(db.sql);
    expect(await isOnCooldown(db.sql, channel.channelId, "viewer")).toBe(false);
    await db.sql`insert into cooldown_state(channel_id,scope,subject_key,next_allowed_at)
      values(${channel.channelId},'viewer','viewer',now()+interval '1 minute')`;
    expect(await isOnCooldown(db.sql, channel.channelId, "viewer")).toBe(true);
    expect(await isOnCooldown(db.sql, channel.channelId, "other")).toBe(false);
    await db.sql`insert into cooldown_state(channel_id,scope,subject_key,next_allowed_at)
      values(${channel.channelId},'channel','*',now()+interval '1 minute')`;
    expect(await isOnCooldown(db.sql, channel.channelId, "other")).toBe(true);
  });
});
