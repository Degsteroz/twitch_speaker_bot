import { randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { StoredOverlayRoast } from "@roastbot/shared";
import {
  createTestChannel,
  createTestEvent,
  startTestDatabase,
  type TestChannel,
  type TestDatabase
} from "@roastbot/testing";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { WebSocket } from "@fastify/websocket";

import { buildApp } from "./app.js";
import type { ApiConfig } from "./config.js";
import { encryptValue } from "./security.js";

const KEY = "ab".repeat(32);
let db: TestDatabase;
let app: Awaited<ReturnType<typeof buildApp>>;
let audioDir: string;
let streamer: TestChannel;
let owner: TestChannel;
const realFetch = globalThis.fetch;

beforeAll(async () => {
  db = await startTestDatabase();
  audioDir = await mkdtemp(join(tmpdir(), "roastbot-api-audio-"));
  const config: ApiConfig = {
    NODE_ENV: "test",
    HOST: "127.0.0.1",
    PORT: 0,
    DATABASE_URL: db.url,
    PUBLIC_URL: "https://app.test/api",
    DASHBOARD_URL: "https://app.test",
    TWITCH_CLIENT_ID: "client",
    TWITCH_CLIENT_SECRET: "secret",
    TWITCH_REDIRECT_URI: "https://app.test/api/auth/twitch/callback",
    TWITCH_OWNER_IDS: "",
    SESSION_SECRET: "s".repeat(48),
    TOKEN_ENCRYPTION_KEY: KEY,
    AUDIO_SIGNING_SECRET: "a".repeat(48),
    AUDIO_DIR: audioDir,
    ownerIds: new Set()
  };
  app = await buildApp(config);
  await app.ready();
}, 120_000);

afterAll(async () => {
  globalThis.fetch = realFetch;
  await app?.close();
  await db?.stop();
  if (audioDir) await rm(audioDir, { recursive: true, force: true });
});

beforeEach(async () => {
  globalThis.fetch = realFetch;
  streamer = await createTestChannel(db.sql);
  owner = await createTestChannel(db.sql, { role: "owner" });
  await db.sql`update global_settings set value='false'::jsonb where key='kill_switch'`;
});

const cookieFor = (channel: TestChannel, role: "owner" | "user" = "user") =>
  `roastbot_session=${app.jwt.sign({ userId: channel.userId, channelId: channel.channelId, role })}`;

async function call(
  method: "GET" | "POST" | "PATCH" | "PUT",
  url: string,
  channel?: TestChannel,
  payload?: unknown
) {
  return app.inject({
    method,
    url,
    headers: {
      ...(channel ? { cookie: cookieFor(channel) } : {}),
      ...(payload === undefined ? {} : { "content-type": "application/json" })
    },
    ...(payload === undefined ? {} : { payload: JSON.stringify(payload) })
  });
}

async function storeTokens(channel: TestChannel, expiresInSeconds = 3_600) {
  const access = encryptValue("access-token", KEY);
  const refresh = encryptValue("refresh-token", KEY);
  await db.sql`insert into twitch_tokens(channel_id,access_token_ciphertext,refresh_token_ciphertext,
    access_token_iv,access_token_tag,refresh_token_iv,refresh_token_tag,scopes,expires_at)
    values(${channel.channelId},${access.ciphertext},${refresh.ciphertext},${access.iv},${access.tag},
      ${refresh.iv},${refresh.tag},array['channel:read:redemptions'],
      now()+${expiresInSeconds}*interval '1 second')`;
}

function nextMessage(socket: WebSocket, type: string): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`no ${type} message`)), 5_000);
    const onMessage = (data: Buffer) => {
      const parsed = JSON.parse(data.toString()) as Record<string, unknown>;
      if (parsed.type !== type) return;
      clearTimeout(timer);
      socket.off("message", onMessage);
      resolve(parsed);
    };
    socket.on("message", onMessage);
  });
}

async function publishOverlayEvent(channel: TestChannel) {
  const eventId = await createTestEvent(db.sql, channel.channelId);
  const [roast] = await db.sql<{ id: string }[]>`
    insert into roasts(channel_id,event_id,source,viewer_login,tone,voice,toxicity,status,output_text)
    values(${channel.channelId},${eventId},'chat_command','viewer','tsundere','female',2,'done','Привет')
    returning id`;
  const audioFile = `${randomUUID()}.wav`;
  await writeFile(join(audioDir, audioFile), Buffer.from("RIFFfake"));
  const overlayId = randomUUID();
  const payload: StoredOverlayRoast = {
    version: 1,
    type: "roast.play",
    eventId: overlayId,
    roastId: roast!.id,
    viewerLogin: "viewer",
    text: "Привет",
    audioFile,
    expiresAt: new Date(Date.now() + 120_000).toISOString(),
    sentAt: new Date().toISOString()
  };
  await db.sql`insert into overlay_events(id,channel_id,roast_id,payload,expires_at)
    values(${overlayId},${channel.channelId},${roast!.id},${db.sql.json(payload)},
      now()+interval '2 minutes')`;
  await db.sql`select pg_notify('overlay_events',${channel.channelId})`;
  return { overlayId, roastId: roast!.id };
}

describe("auth and settings", () => {
  it("serves health and rejects anonymous requests", async () => {
    expect((await call("GET", "/health")).json()).toEqual({ ok: true });
    expect((await call("GET", "/ready")).statusCode).toBe(200);
    const anonymous = await call("GET", "/settings");
    expect(anonymous.statusCode).toBe(401);
    expect(anonymous.json()).toMatchObject({ error: { code: "unauthorized" } });
  });

  it("redirects OAuth errors back to the dashboard", async () => {
    const denied = await call("GET", "/auth/twitch/callback?error=access_denied");
    expect(denied.statusCode).toBe(302);
    expect(denied.headers.location).toBe("https://app.test/?auth_error=access_denied");
    const forged = await call("GET", "/auth/twitch/callback?code=x&state=y");
    expect(forged.headers.location).toContain("auth_error=invalid_oauth_state");
  });

  it("reads, validates and saves settings", async () => {
    const session = await call("GET", "/me/session", streamer);
    expect(session.json()).toMatchObject({
      channelId: streamer.channelId,
      overlayToken: streamer.overlayToken
    });

    const saved = await call("PATCH", "/settings", streamer, {
      tone: "yandere",
      toxicity: 4,
      triggers: { command: false, rewardId: "reward-1" },
      stopWords: ["скуф"]
    });
    expect(saved.statusCode).toBe(200);
    expect(saved.json()).toMatchObject({
      tone: "yandere",
      toxicity: 4,
      triggers: { command: false, rewardId: "reward-1" },
      stop_words: ["скуф"]
    });
    expect((await call("PATCH", "/settings", streamer, { toxicity: 9 })).statusCode).toBe(400);
    expect((await call("PATCH", "/settings", streamer, { unknown: true })).statusCode).toBe(400);
  });

  it("reports working, paused and limit states", async () => {
    expect((await call("GET", "/status", streamer)).json()).toMatchObject({
      state: "working",
      limit: 100,
      remaining: 100
    });
    await call("POST", "/settings/enabled", streamer, { enabled: false });
    expect((await call("GET", "/status", streamer)).json()).toMatchObject({
      state: "paused",
      enabled: false
    });
    await call("POST", "/settings/enabled", streamer, { enabled: true });
    await db.sql`update global_settings set value='true'::jsonb where key='kill_switch'`;
    expect((await call("GET", "/status", streamer)).json()).toMatchObject({
      state: "paused",
      killSwitch: true
    });
    await db.sql`update global_settings set value='false'::jsonb where key='kill_switch'`;
    await db.sql`insert into usage_monthly(channel_id,month,roasts)
      values(${streamer.channelId},${new Date().toISOString().slice(0, 7)},100)`;
    expect((await call("GET", "/status", streamer)).json()).toMatchObject({
      state: "limit",
      remaining: 0
    });
  });
});

describe("rewards", () => {
  it("lists rewards and explains channels without Channel Points", async () => {
    await storeTokens(streamer);
    globalThis.fetch = vi.fn(() =>
      Promise.resolve(
        Response.json({
          data: [
            {
              id: "r1",
              title: "Роаст",
              cost: 500,
              is_enabled: true,
              is_user_input_required: true,
              extra: 1
            }
          ]
        })
      )
    );
    const listed = await call("GET", "/rewards", streamer);
    if (listed.statusCode !== 200) console.log(listed.body);
    expect(listed.json()).toEqual({
      available: true,
      rewards: [
        { id: "r1", title: "Роаст", cost: 500, is_enabled: true, is_user_input_required: true }
      ]
    });

    globalThis.fetch = vi.fn(() => Promise.resolve(new Response("{}", { status: 403 })));
    expect((await call("GET", "/rewards", streamer)).json()).toEqual({
      available: false,
      reason: "not_affiliate",
      rewards: []
    });
    expect((await call("GET", "/rewards", owner)).json()).toMatchObject({
      reason: "reauth_required"
    });
  });

  it("refreshes an expired Twitch token before calling Helix", async () => {
    await storeTokens(streamer, 10);
    const fetchMock = vi.fn((url: string | URL | Request) =>
      Promise.resolve(
        (url instanceof Request ? url.url : url.toString()).includes("oauth2/token")
          ? Response.json({
              access_token: "new",
              refresh_token: "new-r",
              expires_in: 3600,
              scope: []
            })
          : Response.json({ data: [] })
      )
    );
    globalThis.fetch = fetchMock;
    expect((await call("GET", "/rewards", streamer)).json()).toEqual({
      available: true,
      rewards: []
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const [row] = await db.sql<{ expires_at: Date }[]>`
      select expires_at from twitch_tokens where channel_id=${streamer.channelId}`;
    expect(row!.expires_at.getTime()).toBeGreaterThan(Date.now() + 3_000_000);
  });
});

describe("test roast", () => {
  it("creates the roast, enqueues a job and scopes lookups to the channel", async () => {
    const response = await call("POST", "/roasts/test", streamer, {
      viewerLogin: "tester",
      inputText: "привет"
    });
    expect(response.statusCode).toBe(200);
    const { roastId } = response.json<{ roastId: string }>();
    const [job] = await db.sql<
      { data: { eventId: string; source: string }; retry_limit: number }[]
    >`
      select data, retry_limit from pgboss.job where name='roast.requested'
      and data->>'channelId'=${streamer.channelId}`;
    expect(job).toMatchObject({ data: { source: "dashboard_test" }, retry_limit: 0 });

    expect((await call("GET", `/roasts/${roastId}`, streamer)).json()).toMatchObject({
      id: roastId,
      status: "queued"
    });
    expect((await call("GET", `/roasts/${roastId}`, owner)).statusCode).toBe(404);
    expect((await call("POST", "/roasts/test", streamer, { viewerLogin: "" })).statusCode).toBe(
      400
    );
  });
});

describe("overlay websocket", () => {
  it("closes unknown tokens and survives malformed frames", async () => {
    const intruder = await app.injectWS("/overlay/not-a-token");
    intruder.send("definitely not json");
    const code = await new Promise<number>((resolve) => intruder.once("close", resolve));
    expect(code).toBe(1008);
    expect((await call("GET", "/health")).statusCode).toBe(200);
  });

  it("delivers pending roasts with a freshly signed audio URL and records the ack", async () => {
    const socket = await app.injectWS(`/overlay/${encodeURIComponent(streamer.overlayToken)}`);
    await nextMessage(socket, "overlay.ready");
    socket.send("{broken");
    socket.send(JSON.stringify({ hello: "world" }));
    const pending = nextMessage(socket, "roast.play");
    const { overlayId } = await publishOverlayEvent(streamer);
    const event = await pending;
    expect(event).toMatchObject({ eventId: overlayId, text: "Привет", viewerLogin: "viewer" });
    expect(event).not.toHaveProperty("audioFile");

    const audioUrl = new URL(String(event.audioUrl));
    expect(audioUrl.origin + audioUrl.pathname.replace(/\/audio\/.*/u, "")).toBe(
      "https://app.test/api"
    );
    const audio = await app.inject({
      method: "GET",
      url: `${audioUrl.pathname.replace(/^\/api/u, "")}${audioUrl.search}`
    });
    expect(audio.statusCode).toBe(200);
    expect(audio.headers["content-type"]).toBe("audio/wav");
    const forged = await app.inject({
      method: "GET",
      url: `${audioUrl.pathname.replace(/^\/api/u, "")}?expires=1&sig=x`
    });
    expect(forged.statusCode).toBe(403);

    socket.send(
      JSON.stringify({
        version: 1,
        type: "overlay.ack",
        eventId: overlayId,
        receivedAt: new Date().toISOString()
      })
    );
    await vi.waitFor(async () => {
      const [row] = await db.sql<
        { status: string }[]
      >`select status from overlay_events where id=${overlayId}`;
      expect(row!.status).toBe("delivered");
    });
    socket.terminate();
  });

  it("replays undelivered events on reconnect and closes sockets when the token rotates", async () => {
    const { overlayId } = await publishOverlayEvent(streamer);
    const socket = await app.injectWS(`/overlay/${encodeURIComponent(streamer.overlayToken)}`);
    expect(await nextMessage(socket, "roast.play")).toMatchObject({ eventId: overlayId });
    const closed = new Promise<number>((resolve) => socket.once("close", resolve));
    const rotated = await call("POST", "/me/overlay-token/rotate", streamer);
    expect(rotated.json<{ overlayToken: string }>().overlayToken).not.toBe(streamer.overlayToken);
    expect(await closed).toBe(1008);
  });
});

describe("back-office", () => {
  it("is owner-only, checked against the database role", async () => {
    expect((await call("GET", "/admin/overview", streamer)).statusCode).toBe(403);
    const forged = await app.inject({
      method: "GET",
      url: "/admin/overview",
      headers: { cookie: cookieFor(streamer, "owner") }
    });
    expect(forged.statusCode).toBe(403);
    const overview = await call("GET", "/admin/overview", owner);
    expect(overview.statusCode).toBe(200);
    expect(overview.json()).toMatchObject({ budget: 5, roastCap: 4000, killSwitch: false });
  });

  it("validates global settings and writes the audit log", async () => {
    expect((await call("PUT", "/admin/settings/model", owner, "gpt-4")).statusCode).toBe(400);
    expect((await call("PUT", "/admin/settings/kill_switch", owner, "yes")).statusCode).toBe(400);
    expect((await call("PUT", "/admin/settings/nope", owner, 1)).statusCode).toBe(400);
    const saved = await call("PUT", "/admin/settings/monthly_budget_usd", owner, 4.5);
    expect(saved.json()).toEqual({ key: "monthly_budget_usd", value: 4.5 });
    const [audit] = await db.sql<{ action: string; target: string }[]>`
      select action,target from audit_log where actor_user_id=${owner.userId} order by created_at desc limit 1`;
    expect(audit).toEqual({ action: "global_setting.update", target: "monthly_budget_usd" });
    await call("PUT", "/admin/settings/monthly_budget_usd", owner, 5);
  });

  it("lists users with plan and usage, and applies manual actions", async () => {
    const users = await call("GET", `/admin/users?search=${streamer.login}`, owner);
    expect(users.json()).toEqual([
      expect.objectContaining({ id: streamer.userId, plan: "free", used: 0, limit: 100 })
    ]);
    await call("POST", `/admin/users/${streamer.userId}/gift`, owner, { amount: 5 });
    await call("POST", `/admin/users/${streamer.userId}/subscription`, owner, {
      plan: "basic",
      validUntil: null
    });
    expect((await call("GET", "/status", streamer)).json()).toMatchObject({
      limit: 1000,
      gifted: 5
    });
    await call("POST", `/admin/users/${streamer.userId}/suspend`, owner);
    expect((await call("GET", "/status", streamer)).json()).toMatchObject({ state: "suspended" });
  });

  it("runs the moderation queue and grows the global stop-list", async () => {
    const eventId = await createTestEvent(db.sql, streamer.channelId);
    const [blocked] = await db.sql<{ id: string }[]>`
      insert into roasts(channel_id,event_id,source,viewer_login,input_text,tone,voice,toxicity,status)
      values(${streamer.channelId},${eventId},'chat_command','troll','плохое слово','tsundere','female',2,
        'blocked_output') returning id`;
    const queue = await call("GET", "/admin/moderation/queue", owner);
    expect(queue.json<{ id: string }[]>().map((row) => row.id)).toContain(blocked!.id);
    await call("PUT", "/admin/moderation", owner, ["первое"] as unknown);
    const reviewed = await call("POST", `/admin/roasts/${blocked!.id}/review`, owner, {
      addStopWord: "плохое"
    });
    expect(reviewed.statusCode).toBe(200);
    expect(
      (await call("GET", "/admin/moderation", owner)).json<{ words: string[] }>().words.sort()
    ).toEqual(["первое", "плохое"]);
    const after = await call("GET", "/admin/moderation/queue", owner);
    expect(after.json<{ id: string }[]>().map((row) => row.id)).not.toContain(blocked!.id);
    expect((await call("POST", `/admin/roasts/${blocked!.id}/review`, owner, {})).statusCode).toBe(
      404
    );
  });
});
