import { randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { TWITCH_SCOPES, VOICE_SAMPLE_QUEUE, type StoredOverlayRoast } from "@roastbot/shared";
import {
  createTestChannel,
  createTestEvent,
  startTestDatabase,
  type TestChannel,
  type TestDatabase
} from "@roastbot/testing";
import sharp from "sharp";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { WebSocket } from "@fastify/websocket";

import { buildApp } from "./app.js";
import type { ApiConfig } from "./config.js";
import { encryptValue } from "./security.js";
import { currentStep, generateTotpSecret, totpCode } from "./totp.js";

const KEY = "ab".repeat(32);
const OWNER_TWITCH_ID = "900000001";
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
    TWITCH_OWNER_IDS: OWNER_TWITCH_ID,
    SESSION_SECRET: "s".repeat(48),
    TOKEN_ENCRYPTION_KEY: KEY,
    AUDIO_SIGNING_SECRET: "a".repeat(48),
    AUDIO_DIR: audioDir,
    DONATIONALERTS_CLIENT_ID: "123",
    DONATIONALERTS_CLIENT_SECRET: "da-secret",
    TELEGRAM_BOT_TOKEN: "123:test-token",
    TELEGRAM_BOT_USERNAME: "roastbot_test_bot",
    TELEGRAM_WEBHOOK_SECRET: "w".repeat(24),
    ownerIds: new Set([OWNER_TWITCH_ID])
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
  await enrollMfa(owner);
  await db.sql`update global_settings set value='false'::jsonb where key='kill_switch'`;
});

/** Default cookies carry a fresh second-factor confirmation; pass `mfaAt: null` to omit it. */
const cookieFor = (
  channel: TestChannel,
  claims: { role?: "owner" | "user"; mfaAt?: number | null } = {}
) => {
  const mfaAt = claims.mfaAt === undefined ? Date.now() : claims.mfaAt;
  const token = app.jwt.sign({
    userId: channel.userId,
    channelId: channel.channelId,
    role: claims.role ?? "user",
    ...(mfaAt === null ? {} : { mfaAt })
  });
  return `roastbot_session=${token}`;
};

/** Stores an enabled TOTP secret directly, as if the user had finished enrollment. */
async function enrollMfa(channel: TestChannel) {
  const secret = generateTotpSecret();
  const encrypted = encryptValue(secret, KEY);
  await db.sql`update users set totp_secret_ciphertext=${encrypted.ciphertext},
    totp_secret_iv=${encrypted.iv}, totp_secret_tag=${encrypted.tag}, totp_enabled_at=now()
    where id=${channel.userId}`;
  return secret;
}

const sessionCookie = (response: { cookies: { name: string; value: string }[] }) => {
  const cookie = response.cookies.find((item) => item.name === "roastbot_session");
  if (!cookie) throw new Error("no session cookie");
  return `roastbot_session=${cookie.value}`;
};

async function call(
  method: "GET" | "POST" | "PATCH" | "PUT" | "DELETE",
  url: string,
  channel?: TestChannel | string,
  payload?: unknown
) {
  const cookie = typeof channel === "string" ? channel : channel && cookieFor(channel);
  return app.inject({
    method,
    url,
    headers: {
      ...(cookie ? { cookie } : {}),
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

async function publishOverlayEvent(channel: TestChannel, extra: Partial<StoredOverlayRoast> = {}) {
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
    sentAt: new Date().toISOString(),
    ...extra
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

  it("asks Twitch for every event scope and flags channels that logged in before", async () => {
    const login = await call("GET", "/auth/twitch");
    const scope = new URL(login.headers.location as string).searchParams.get("scope");
    expect(scope?.split(" ")).toEqual([...TWITCH_SCOPES]);

    await storeTokens(streamer);
    const session = (await call("GET", "/me/session", streamer)).json<{
      missingScopes: string[];
    }>();
    expect(session.missingScopes).toEqual(
      TWITCH_SCOPES.filter((item) => item !== "channel:read:redemptions")
    );
    expect(session).not.toHaveProperty("scopes");
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

  it("shows the channel's recent activity and Twitch's answer to its subscriptions", async () => {
    type Activity = { roasts: unknown[]; eventsub: unknown };
    const empty = (await call("GET", "/activity", streamer)).json<Activity>();
    expect(empty).toEqual({ roasts: [], eventsub: null });
    await call("POST", "/roasts/test", streamer, { viewerLogin: "tester", inputText: "привет" });
    await db.sql`insert into eventsub_state(channel_id,connected,subscriptions)
      values(${streamer.channelId},true,${db.sql.json({
        "channel.channel_points_custom_reward_redemption.add":
          "403 subscription missing proper authorization"
      })})`;
    const activity = (await call("GET", "/activity", streamer)).json<Activity>();
    expect(activity.roasts).toEqual([
      expect.objectContaining({ source: "dashboard_test", viewerLogin: "tester", status: "queued" })
    ]);
    expect(activity.eventsub).toMatchObject({
      connected: true,
      subscriptions: {
        "channel.channel_points_custom_reward_redemption.add":
          "403 subscription missing proper authorization"
      }
    });
    expect((await call("GET", "/activity", owner)).json<Activity>().roasts).toEqual([]);
  });

  it("reports working, paused and limit states", async () => {
    expect((await call("GET", "/status", streamer)).json()).toMatchObject({
      state: "working",
      plan: "free",
      commandAvailable: false,
      limit: 10,
      remaining: 10
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
      values(${streamer.channelId},${new Date().toISOString().slice(0, 7)},10)`;
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
  it("dresses a test as a real event and stops at the daily test allowance", async () => {
    const response = await call("POST", "/roasts/test", streamer, {
      kind: "raid",
      viewerLogin: "raider",
      inputText: "ignored",
      amount: 40
    });
    expect(response.statusCode).toBe(200);
    const [job] = await db.sql<{ data: Record<string, unknown> }[]>`
      select data from pgboss.job where name='roast.requested'
      and data->>'channelId'=${streamer.channelId}`;
    expect(job!.data).toMatchObject({
      source: "dashboard_test",
      viewerLogin: "raider",
      inputText: "",
      target: "viewer",
      eventSummary: "Рейд с канала raider: 40 зрителей"
    });
    const { roastId } = response.json<{ roastId: string }>();
    expect((await call("GET", `/roasts/${roastId}`, streamer)).json()).toMatchObject({
      testKind: "raid",
      channelLogin: streamer.login
    });
    // The owner opens any channel's roast through the admin endpoint.
    expect((await call("GET", `/admin/roasts/${roastId}`, owner)).statusCode).toBe(200);

    expect((await call("GET", "/status", streamer)).json()).toMatchObject({
      tests: { limit: 5, remaining: 5 },
      premium: { total: 2, remaining: 2 },
      branding: true
    });
    await db.sql`insert into test_usage_daily(channel_id,day,roasts)
      values(${streamer.channelId},${new Date().toISOString().slice(0, 10)},5)`;
    const limited = await call("POST", "/roasts/test", streamer, { viewerLogin: "tester" });
    expect(limited.statusCode).toBe(429);
    expect(limited.json()).toMatchObject({ error: { code: "test_limit_reached" } });
  });
});

describe("plan tiers in /admin", () => {
  it("lets the owner change the premium allowance, model and voice, but not the limit", async () => {
    const plans = (await call("GET", "/admin/plans", owner)).json<{ code: string }[]>();
    expect(plans).toContainEqual({
      code: "free",
      monthlyRoastLimit: 10,
      premiumRoasts: 2,
      economyModel: "claude-haiku-5-5",
      economyVoice: "yandex"
    });
    const body = { premiumRoasts: 3, economyModel: "claude-sonnet-5-5", economyVoice: "piper" };
    expect((await call("PUT", "/admin/plans/free", owner, body)).statusCode).toBe(200);
    expect(
      (await call("PUT", "/admin/plans/free", owner, { ...body, monthlyRoastLimit: 99 })).statusCode
    ).toBe(400);
    expect(
      (await call("PUT", "/admin/plans/free", owner, { ...body, economyVoice: "elevenlabs" }))
        .statusCode
    ).toBe(400);
    expect((await call("PUT", "/admin/plans/free", streamer, body)).statusCode).toBe(403);
    const [free] = await db.sql`select premium_roasts, economy_model, economy_voice
      from plans where code='free'`;
    expect(free).toEqual({
      premium_roasts: 3,
      economy_model: "claude-sonnet-5-5",
      economy_voice: "piper"
    });
    await call("PUT", "/admin/plans/free", owner, {
      premiumRoasts: 2,
      economyModel: "claude-haiku-5-5",
      economyVoice: "yandex"
    });
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
    const forged = await call("GET", "/admin/overview", cookieFor(streamer, { role: "owner" }));
    expect(forged.statusCode).toBe(403);
    const overview = await call("GET", "/admin/overview", owner);
    expect(overview.statusCode).toBe(200);
    expect(overview.json()).toMatchObject({ budget: 10, roastCap: 4000, killSwitch: false });
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
      expect.objectContaining({ id: streamer.userId, plan: "free", used: 0, limit: 10 })
    ]);
    await call("POST", `/admin/users/${streamer.userId}/gift`, owner, { amount: 5 });
    await call("POST", `/admin/users/${streamer.userId}/subscription`, owner, {
      plan: "basic",
      validUntil: null
    });
    expect((await call("GET", "/status", streamer)).json()).toMatchObject({
      limit: 300,
      gifted: 5,
      commandAvailable: true
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

/** Runs the OAuth callback with Twitch mocked and returns the issued session cookie. */
async function twitchLogin(user: { id: string; login: string }, extraCookie = "") {
  globalThis.fetch = vi.fn((url: string | URL | Request) =>
    Promise.resolve(
      (url instanceof Request ? url.url : url.toString()).includes("oauth2/token")
        ? Response.json({
            access_token: "access",
            refresh_token: "refresh",
            expires_in: 3600,
            scope: ["channel:read:redemptions"]
          })
        : Response.json({ data: [{ id: user.id, login: user.login, display_name: user.login }] })
    )
  );
  const response = await app.inject({
    method: "GET",
    url: "/auth/twitch/callback?code=code&state=state",
    headers: { cookie: `oauth_state=state${extraCookie ? `; ${extraCookie}` : ""}` }
  });
  expect(response.headers.location).toBe("https://app.test");
  return sessionCookie(response);
}

const randomTwitchId = () => `7${String(Math.floor(Math.random() * 1e8))}`;

describe("registration", () => {
  it("keeps new Twitch logins pending until the owner approves them", async () => {
    const id = randomTwitchId();
    const login = `newbie_${id}`;
    const cookie = await twitchLogin({ id, login });
    expect((await call("GET", "/me/session", cookie)).json()).toMatchObject({
      status: "pending",
      role: "user",
      overlayToken: null
    });
    const blocked = await call("GET", "/settings", cookie);
    expect(blocked.statusCode).toBe(403);
    expect(blocked.json()).toMatchObject({ error: { code: "pending_approval" } });
    expect((await call("POST", "/roasts/test", cookie, { viewerLogin: "x" })).statusCode).toBe(403);
    const [signup] = await db.sql<{ action: string; payload: unknown }[]>`
      select action, payload from audit_log where target=${login}`;
    expect(signup).toEqual({ action: "user.signup", payload: { status: "pending" } });

    const [listed] = (await call("GET", `/admin/users?search=${login}`, owner)).json<
      { id: string; status: string }[]
    >();
    expect(listed).toMatchObject({ status: "pending" });
    await call("POST", `/admin/users/${listed!.id}/activate`, owner);
    expect((await call("GET", "/settings", cookie)).statusCode).toBe(200);
    const again = await twitchLogin({ id, login });
    expect((await call("GET", "/me/session", again)).json()).toMatchObject({ status: "active" });
  });

  it("lets invited logins and the configured owner in without review", async () => {
    const id = randomTwitchId();
    const login = `invited_${id}`;
    const created = await call("POST", "/admin/invites", owner, {
      login: `@${login.toUpperCase()}`
    });
    expect(created.json()).toEqual({ login, approvedExisting: false });
    expect((await call("POST", "/admin/invites", owner, { login: "no spaces!" })).statusCode).toBe(
      400
    );
    const cookie = await twitchLogin({ id, login });
    const me = (await call("GET", "/me/session", cookie)).json<{ overlayToken: unknown }>();
    expect(me).toMatchObject({ status: "active" });
    expect(typeof me.overlayToken).toBe("string");
    const invites = (await call("GET", "/admin/invites", owner)).json<AnyInvite[]>();
    expect(invites.find((row) => row.login === login)).toMatchObject({ used_by_login: login });
    expect((await call("DELETE", `/admin/invites/${login}`, owner)).json()).toEqual({
      login,
      deleted: false
    });

    const ownerCookie = await twitchLogin({ id: OWNER_TWITCH_ID, login: `boss_${id}` });
    expect((await call("GET", "/me/session", ownerCookie)).json()).toMatchObject({
      status: "active",
      role: "owner",
      adminMfa: "setup"
    });
  });

  it("approves a waiting streamer as soon as the owner invites the login", async () => {
    const id = randomTwitchId();
    const login = `waiting_${id}`;
    const cookie = await twitchLogin({ id, login });
    expect((await call("GET", "/settings", cookie)).statusCode).toBe(403);
    expect((await call("POST", "/admin/invites", owner, { login })).json()).toEqual({
      login,
      approvedExisting: true
    });
    expect((await call("GET", "/settings", cookie)).statusCode).toBe(200);
  });
});

interface AnyInvite {
  login: string;
  used_by_login: string | null;
}

describe("two-factor authentication", () => {
  it("enrolls with an authenticator code, refuses replays and accepts recovery codes", async () => {
    const setup = await call("POST", "/me/mfa/setup", streamer);
    const { secret, otpauthUri } = setup.json<{ secret: string; otpauthUri: string }>();
    expect(otpauthUri).toContain(`secret=${secret}`);
    const wrong = await call("POST", "/me/mfa/enable", streamer, { code: "000000" });
    expect(wrong.json()).toMatchObject({ error: { code: "mfa_invalid" } });

    const step = currentStep();
    const code = totpCode(secret, step);
    const enabled = await call("POST", "/me/mfa/enable", streamer, { code });
    expect(enabled.statusCode).toBe(200);
    const { recoveryCodes } = enabled.json<{ recoveryCodes: string[] }>();
    expect(recoveryCodes).toHaveLength(8);
    expect((await call("GET", "/settings", sessionCookie(enabled))).statusCode).toBe(200);

    const fresh = cookieFor(streamer, { mfaAt: null });
    const gated = await call("GET", "/settings", fresh);
    expect(gated.statusCode).toBe(403);
    expect(gated.json()).toMatchObject({ error: { code: "mfa_required" } });
    expect((await call("GET", "/me/session", fresh)).json()).toMatchObject({
      mfaRequired: true,
      overlayToken: null
    });

    expect((await call("POST", "/me/mfa/verify", fresh, { code })).statusCode).toBe(400);
    const verified = await call("POST", "/me/mfa/verify", fresh, {
      code: totpCode(secret, step + 1)
    });
    expect(verified.json()).toMatchObject({ ok: true, via: "totp" });
    expect((await call("GET", "/settings", sessionCookie(verified))).statusCode).toBe(200);

    const recovery = recoveryCodes[0]!.toUpperCase();
    const recovered = await call("POST", "/me/mfa/verify", fresh, { code: recovery });
    expect(recovered.json()).toMatchObject({ via: "recovery", recoveryCodesLeft: 7 });
    expect((await call("POST", "/me/mfa/verify", fresh, { code: recovery })).statusCode).toBe(400);
  });

  it("locks the second factor after five wrong codes", async () => {
    const secret = await enrollMfa(streamer);
    const fresh = cookieFor(streamer, { mfaAt: null });
    for (let attempt = 0; attempt < 4; attempt += 1) {
      expect((await call("POST", "/me/mfa/verify", fresh, { code: "000000" })).statusCode).toBe(
        400
      );
    }
    const locked = await call("POST", "/me/mfa/verify", fresh, { code: "000000" });
    expect(locked.statusCode).toBe(429);
    const correct = await call("POST", "/me/mfa/verify", fresh, {
      code: totpCode(secret, currentStep())
    });
    expect(correct.json()).toMatchObject({ error: { code: "mfa_locked" } });
  });

  it("lets a streamer turn 2FA off with a valid code", async () => {
    const secret = await enrollMfa(streamer);
    const disabled = await call("POST", "/me/mfa/disable", streamer, {
      code: totpCode(secret, currentStep())
    });
    expect(disabled.json()).toEqual({ ok: true });
    expect((await call("GET", "/settings", cookieFor(streamer, { mfaAt: null }))).statusCode).toBe(
      200
    );
  });

  it("guards the back-office with the owner's second factor", async () => {
    const newcomer = await createTestChannel(db.sql, { role: "owner" });
    expect((await call("GET", "/admin/overview", newcomer)).json()).toMatchObject({
      error: { code: "mfa_setup_required" }
    });
    const stale = cookieFor(owner, { mfaAt: Date.now() - 13 * 60 * 60 * 1000 });
    for (const cookie of [cookieFor(owner, { mfaAt: null }), stale]) {
      const response = await call("GET", "/admin/overview", cookie);
      expect(response.statusCode).toBe(403);
      expect(response.json()).toMatchObject({ error: { code: "mfa_required" } });
    }
    expect((await call("GET", "/admin/overview", owner)).statusCode).toBe(200);
    expect((await call("POST", "/me/mfa/disable", owner, { code: "000000" })).json()).toMatchObject(
      { error: { code: "mfa_mandatory" } }
    );

    await enrollMfa(streamer);
    expect(
      (await call("POST", `/admin/users/${streamer.userId}/mfa/reset`, owner)).statusCode
    ).toBe(200);
    expect((await call("GET", "/settings", cookieFor(streamer, { mfaAt: null }))).statusCode).toBe(
      200
    );
    expect((await call("POST", `/admin/users/${owner.userId}/mfa/reset`, owner)).statusCode).toBe(
      400
    );
  });
});

describe("DonationAlerts integration", () => {
  const daState = (response: { cookies: { name: string; value: string }[] }) =>
    response.cookies.find((item) => item.name === "da_oauth_state")?.value ?? "";
  const daOk = () =>
    vi.fn((url: string | URL | Request) =>
      Promise.resolve(
        (url instanceof Request ? url.url : url.toString()).includes("/oauth/token")
          ? Response.json({
              access_token: "da-access",
              refresh_token: "da-refresh",
              expires_in: 3600
            })
          : Response.json({ data: { id: 777, name: "Щедрый канал" } })
      )
    );

  it("connects through OAuth, bound to the session that started it", async () => {
    expect((await call("GET", "/integrations/donationalerts", streamer)).json()).toEqual({
      configured: true,
      connected: false,
      name: null
    });
    const start = await call("GET", "/integrations/donationalerts/connect", streamer);
    const authorize = new URL(start.headers.location as string);
    expect(authorize.origin + authorize.pathname).toBe(
      "https://www.donationalerts.com/oauth/authorize"
    );
    expect(authorize.searchParams.get("client_id")).toBe("123");
    expect(authorize.searchParams.get("scope")).toBe("oauth-user-show oauth-donation-subscribe");
    expect(authorize.searchParams.get("redirect_uri")).toBe(
      "https://app.test/api/integrations/donationalerts/callback"
    );
    const state = authorize.searchParams.get("state")!;
    const cookie = `${cookieFor(streamer)}; da_oauth_state=${daState(start)}`;

    globalThis.fetch = daOk();
    const done = await call(
      "GET",
      `/integrations/donationalerts/callback?code=abc&state=${state}`,
      cookie
    );
    expect(done.headers.location).toBe("https://app.test/?donationalerts=connected");
    const [row] = await db.sql<
      { da_user_id: string; da_name: string; access_token_ciphertext: string }[]
    >`
      select da_user_id, da_name, access_token_ciphertext from donationalerts_accounts
      where channel_id=${streamer.channelId}`;
    expect(row).toMatchObject({ da_user_id: "777", da_name: "Щедрый канал" });
    expect(row!.access_token_ciphertext).not.toContain("da-access");
    expect((await call("GET", "/integrations/donationalerts", streamer)).json()).toMatchObject({
      connected: true,
      name: "Щедрый канал"
    });

    expect(
      (await call("POST", "/integrations/donationalerts/disconnect", streamer)).json()
    ).toEqual({
      connected: false
    });
    expect((await call("GET", "/integrations/donationalerts", streamer)).json()).toMatchObject({
      connected: false
    });
  });

  it("rejects a forged state, another user's flow and a missing session", async () => {
    const start = await call("GET", "/integrations/donationalerts/connect", streamer);
    const state = new URL(start.headers.location as string).searchParams.get("state")!;
    globalThis.fetch = daOk();
    const forged = await call(
      "GET",
      "/integrations/donationalerts/callback?code=abc&state=forged",
      `${cookieFor(streamer)}; da_oauth_state=${daState(start)}`
    );
    expect(forged.headers.location).toContain("donationalerts=invalid_state");
    // The streamer's flow finishing inside the owner's session must not link anything.
    const crossed = await call(
      "GET",
      `/integrations/donationalerts/callback?code=abc&state=${state}`,
      `${cookieFor(owner)}; da_oauth_state=${daState(start)}`
    );
    expect(crossed.headers.location).toContain("donationalerts=invalid_state");
    const anonymous = await app.inject({
      method: "GET",
      url: `/integrations/donationalerts/callback?code=abc&state=${state}`,
      headers: { cookie: `da_oauth_state=${daState(start)}` }
    });
    expect(anonymous.headers.location).toContain("donationalerts=login_required");
    const [count] = await db.sql<{ n: number }[]>`
      select count(*)::int n from donationalerts_accounts where channel_id in (${streamer.channelId}, ${owner.channelId})`;
    expect(count!.n).toBe(0);
  });
});

describe("landing demo", () => {
  const ask = (text: string, ip = "203.0.113.7") =>
    app.inject({ method: "POST", url: "/demo", payload: { text }, remoteAddress: ip });

  it("answers anonymous visitors three times a day per IP and only shows the answer to them", async () => {
    await db.sql`delete from demo_requests`;
    expect(
      (await app.inject({ method: "GET", url: "/demo", remoteAddress: "203.0.113.7" })).json()
    ).toEqual({ enabled: true, remaining: 3, perDay: 3 });
    const first = await ask("стример опять слил");
    expect(first.statusCode).toBe(200);
    const { id } = first.json<{ id: string }>();
    const [job] = await db.sql<{ data: { demoId: string } }[]>`
      select data from pgboss.job where name='demo.requested' and data->>'demoId'=${id}`;
    expect(job).toBeDefined();
    await ask("раз");
    await ask("два");
    const limited = await ask("три");
    expect(limited.statusCode).toBe(429);
    expect(limited.json()).toMatchObject({ error: { code: "demo_limit" } });
    expect((await ask("с другого адреса", "198.51.100.1")).statusCode).toBe(200);

    expect(
      (await app.inject({ method: "GET", url: `/demo/${id}`, remoteAddress: "203.0.113.7" })).json()
    ).toEqual({ status: "queued", text: null, audioUrl: null });
    expect(
      (await app.inject({ method: "GET", url: `/demo/${id}`, remoteAddress: "198.51.100.1" }))
        .statusCode
    ).toBe(404);
    // The IP is never stored as it is.
    const stored = await db.sql`select 1 from demo_requests where ip_hash like '%203.0.113%'`;
    expect(stored).toHaveLength(0);
  });

  it("is hidden when the owner sets the daily limit to zero", async () => {
    await db.sql`insert into global_settings(key,value) values('demo_daily_limit','0'::jsonb)
      on conflict(key) do update set value=excluded.value`;
    expect((await app.inject({ method: "GET", url: "/demo" })).json()).toMatchObject({
      enabled: false
    });
    expect((await ask("привет")).statusCode).toBe(404);
    await db.sql`update global_settings set value='30'::jsonb where key='demo_daily_limit'`;
  });
});

describe("invite links", () => {
  it("let a new streamer in without review and grant the plan once", async () => {
    const created = await call("POST", "/admin/invite-links", owner, {
      note: "promo",
      plan: "premium",
      planDays: 30,
      maxUses: 1
    });
    expect(created.statusCode).toBe(200);
    const { code } = created.json<{ code: string }>();
    expect((await call("GET", `/invite-links/${code}`)).json()).toEqual({
      plan: "premium",
      planDays: 30
    });
    expect((await call("POST", "/admin/invite-links", streamer, {})).statusCode).toBe(403);

    const id = randomTwitchId();
    const cookie = await twitchLogin({ id, login: `promo_${id}` }, `invite_link=${code}`);
    expect((await call("GET", "/me/session", cookie)).json()).toMatchObject({ status: "active" });
    expect((await call("GET", "/status", cookie)).json()).toMatchObject({
      plan: "premium",
      commandAvailable: true
    });

    // The only use is spent: the next newcomer waits for review as usual.
    const other = randomTwitchId();
    const late = await twitchLogin({ id: other, login: `late_${other}` }, `invite_link=${code}`);
    expect((await call("GET", "/me/session", late)).json()).toMatchObject({ status: "pending" });
    expect((await call("GET", `/invite-links/${code}`)).statusCode).toBe(404);
    const links = (await call("GET", "/admin/invite-links", owner)).json<
      { code: string; uses: number; usedBy: string[] }[]
    >();
    expect(links.find((link) => link.code === code)).toMatchObject({
      uses: 1,
      usedBy: [`promo_${id}`]
    });
  });
});

describe("favorites and opt-outs", () => {
  async function playedRoast(channel: TestChannel, text: string) {
    const eventId = await createTestEvent(db.sql, channel.channelId);
    const [roast] = await db.sql<{ id: string }[]>`
      insert into roasts(channel_id,event_id,source,viewer_login,input_text,output_text,status,
        tone,voice,toxicity)
      values(${channel.channelId},${eventId},'chat_command','secret_viewer','вход',${text},'done',
        'yandere','female',2) returning id`;
    return roast!.id;
  }

  it("shows a starred roast on the landing only after the owner approves it", async () => {
    const id = await playedRoast(streamer, "Опять ты, мой хороший.");
    expect(
      (await call("POST", `/roasts/${id}/favorite`, owner, { favorite: true })).statusCode
    ).toBe(404);
    expect(
      (await call("POST", `/roasts/${id}/favorite`, streamer, { favorite: true })).json()
    ).toEqual({ id, favorite: true });
    const showcase = async () => (await call("GET", "/showcase")).json<{ id: string }[]>();
    expect((await showcase()).some((roast) => roast.id === id)).toBe(false);
    expect(
      (await call("POST", `/admin/roasts/${id}/showcase`, owner, { approved: true })).statusCode
    ).toBe(200);
    const shown = (await showcase()).find((roast) => roast.id === id);
    expect(shown).toEqual({
      id,
      text: "Опять ты, мой хороший.",
      tone: "yandere",
      channel: streamer.login,
      characterName: null
    });
    // Taking the star back takes it off the landing page.
    await call("POST", `/roasts/${id}/favorite`, streamer, { favorite: false });
    expect((await showcase()).some((roast) => roast.id === id)).toBe(false);
  });

  it("lists viewers who opted out and lets the streamer clear one", async () => {
    await db.sql`insert into viewer_optouts(channel_id,viewer_login)
      values(${streamer.channelId},'shy_viewer')`;
    expect((await call("GET", "/optouts", streamer)).json()).toEqual([
      expect.objectContaining({ viewerLogin: "shy_viewer" })
    ]);
    expect((await call("GET", "/optouts", owner)).json()).toEqual([]);
    await call("DELETE", "/optouts/shy_viewer", streamer);
    expect((await call("GET", "/optouts", streamer)).json()).toEqual([]);
  });
});

describe("Telegram bot and Stars", () => {
  const SECRET = "w".repeat(24);
  const calls: { method: string; body: Record<string, unknown> }[] = [];
  const telegram = (results: Record<string, unknown> = {}) => {
    calls.length = 0;
    globalThis.fetch = vi.fn((url: string | URL | Request, init?: RequestInit) => {
      const method = (url instanceof Request ? url.url : url.toString()).split("/").pop()!;
      calls.push({
        method,
        body: JSON.parse((init?.body as string | undefined) ?? "{}") as Record<string, unknown>
      });
      return Promise.resolve(Response.json({ ok: true, result: results[method] ?? true }));
    });
  };
  const webhook = (update: unknown, secret = SECRET) =>
    app.inject({
      method: "POST",
      url: "/telegram/webhook",
      headers: { "content-type": "application/json", "x-telegram-bot-api-secret-token": secret },
      payload: JSON.stringify(update)
    });

  it("links the streamer's chat with a one-time code", async () => {
    telegram();
    const { url } = (await call("POST", "/integrations/telegram/link", streamer)).json<{
      url: string;
    }>();
    expect(url).toMatch(/^https:\/\/t\.me\/roastbot_test_bot\?start=[\w-]+$/u);
    const code = url.split("start=")[1]!;
    expect(
      (await webhook({ message: { chat: { id: 1 }, text: "/start x" } }, "nope")).statusCode
    ).toBe(403);
    const start = {
      message: {
        chat: { id: 555 },
        from: { id: 555, username: "streamer_tg" },
        text: `/start ${code}`
      }
    };
    expect((await webhook(start)).statusCode).toBe(200);
    expect(calls[0]).toMatchObject({ method: "sendMessage", body: { chat_id: 555 } });
    expect(String(calls[0]!.body.text)).toContain(`#${streamer.login}`);
    expect((await call("GET", "/integrations/telegram", streamer)).json()).toMatchObject({
      connected: true,
      username: "streamer_tg"
    });
    // The code works once.
    await webhook(start);
    expect(String(calls[1]!.body.text)).toContain("устарела");
  });

  it("shows the owner what Telegram says about the webhook and re-registers it", async () => {
    telegram({
      getWebhookInfo: {
        url: "https://app.test/api/telegram/webhook",
        pending_update_count: 2,
        last_error_message: "Connection timed out",
        last_error_date: 1_790_000_000
      }
    });
    const status = (await call("GET", "/admin/telegram", owner)).json<Record<string, unknown>>();
    expect(status).toMatchObject({
      configured: true,
      expected: "https://app.test/api/telegram/webhook",
      pending: 2,
      lastError: "Connection timed out",
      ok: false
    });
    expect((await call("GET", "/admin/telegram", streamer)).statusCode).toBe(403);
    await call("POST", "/admin/telegram/webhook", owner);
    expect(calls.map((item) => item.method)).toEqual([
      "getWebhookInfo",
      "setWebhook",
      "getWebhookInfo"
    ]);
    expect(calls[1]!.body).toMatchObject({
      url: "https://app.test/api/telegram/webhook",
      secret_token: "w".repeat(24)
    });
  });

  it("sells a 30-day Stars plan, books each payment once and refunds it", async () => {
    telegram({ createInvoiceLink: "https://t.me/$invoice" });
    const checkout = await call("POST", "/billing/checkout", streamer, { plan: "basic" });
    expect(checkout.json()).toEqual({ url: "https://t.me/$invoice" });
    const invoice = calls[0]!.body;
    expect(invoice).toMatchObject({
      currency: "XTR",
      prices: [{ amount: 170 }],
      subscription_period: 2_592_000,
      payload: `rb1:${streamer.channelId}:basic`
    });

    telegram();
    const precheck = (amount: number) =>
      webhook({
        pre_checkout_query: {
          id: "q1",
          from: { id: 777 },
          currency: "XTR",
          total_amount: amount,
          invoice_payload: invoice.payload
        }
      });
    await precheck(170);
    expect(calls[0]).toMatchObject({ method: "answerPreCheckoutQuery", body: { ok: true } });
    await precheck(1);
    expect(calls[1]).toMatchObject({ method: "answerPreCheckoutQuery", body: { ok: false } });

    const expires = Math.floor(Date.now() / 1000) + 30 * 86_400;
    const paid = {
      message: {
        chat: { id: 777 },
        from: { id: 777 },
        successful_payment: {
          currency: "XTR",
          total_amount: 170,
          invoice_payload: invoice.payload,
          telegram_payment_charge_id: `charge-${streamer.channelId}`,
          subscription_expiration_date: expires,
          is_recurring: true
        }
      }
    };
    await webhook(paid);
    await webhook(paid);
    const payments = await db.sql`select plan, stars from star_payments
      where channel_id=${streamer.channelId}`;
    expect(payments).toEqual([{ plan: "basic", stars: 170 }]);
    expect((await call("GET", "/status", streamer)).json()).toMatchObject({
      plan: "basic",
      commandAvailable: true
    });

    telegram();
    const refund = await call(
      "POST",
      `/admin/payments/${encodeURIComponent(`charge-${streamer.channelId}`)}/refund`,
      owner
    );
    expect(refund.statusCode).toBe(200);
    expect(calls.map((item) => item.method)).toEqual([
      "editUserStarSubscription",
      "refundStarPayment"
    ]);
    expect((await call("GET", "/status", streamer)).json()).toMatchObject({ plan: "free" });
  });
});

describe("premium characters", () => {
  const VOICE_ID = "Abcdefghij0123456789";
  // One of the voices the migrations offer.
  const OFFERED = "tnjzWy46l6XmxM2yWKnN";
  // A picture with EXIF the service must not pass on.
  const portrait = () =>
    sharp({ create: { width: 300, height: 700, channels: 4, background: "#ff5d9d80" } })
      .withExif({ IFD0: { Copyright: "secret-location" } })
      .png()
      .toBuffer();
  const upload = (channel: TestChannel, id: string, body: Buffer, type = "image/png") =>
    app.inject({
      method: "PUT",
      url: `/characters/${id}/image`,
      headers: { cookie: cookieFor(channel), "content-type": type },
      payload: body
    });
  const create = async (channel: TestChannel, name = "Кэт") => {
    const response = await call("POST", "/characters", channel, {
      name,
      archetype: "kuudere",
      voiceId: OFFERED
    });
    expect(response.statusCode).toBe(201);
    const { id } = response.json<{ id: string }>();
    expect((await upload(channel, id, await portrait())).statusCode).toBe(200);
    return id;
  };
  const characters = async (channel: TestChannel) =>
    (await call("GET", "/characters", channel)).json<{
      allowed: boolean;
      own: { id: string; status: string; imagePath: string | null }[];
      shop: { id: string; author: string }[];
      voices: { id: string; sampleReady: boolean }[];
    }>();

  it("is premium-only, three per channel, with names checked and pictures re-encoded", async () => {
    expect(
      (await call("POST", "/characters", streamer, { name: "Кэт", archetype: "kuudere" })).json()
    ).toMatchObject({ error: { code: "plan_required" } });
    const premium = await createTestChannel(db.sql, { plan: "premium" });
    for (const name of ["deg_oz", "К"]) {
      expect(
        (await call("POST", "/characters", premium, { name, archetype: "kuudere" })).statusCode
      ).toBe(400);
    }
    await db.sql`insert into global_settings(key,value) values('global_stop_words','["запретка"]')
      on conflict(key) do update set value=excluded.value`;
    expect(
      (await call("POST", "/characters", premium, { name: "Запретка", archetype: "dandere" }))
        .statusCode
    ).toBe(400);
    await db.sql`delete from global_settings where key='global_stop_words'`;
    // Once voices are offered, the streamer picks one: that is the point of her own character.
    expect(
      (await call("POST", "/characters", premium, { name: "Кэт", archetype: "kuudere" })).json()
    ).toMatchObject({ error: { message: "Выбери голос" } });

    const id = await create(premium);
    await create(premium, "Аня");
    await create(premium, "Мисс Кэт");
    expect(
      (
        await call("POST", "/characters", premium, {
          name: "Лишняя",
          archetype: "yandere",
          voiceId: OFFERED
        })
      ).json()
    ).toMatchObject({ error: { code: "character_limit" } });

    const [own] = (await characters(premium)).own;
    expect(own).toMatchObject({ id, status: "private" });
    const image = await app.inject({ method: "GET", url: own!.imagePath! });
    expect(image.headers["content-type"]).toBe("image/webp");
    expect((await sharp(image.rawPayload).metadata()).format).toBe("webp");
    expect(image.rawPayload.includes("secret-location")).toBe(false);
    expect((await upload(premium, id, Buffer.from("not a picture"))).statusCode).toBe(400);
    expect((await upload(premium, id, Buffer.from("hello"), "text/plain")).statusCode).toBe(415);
    // Another channel cannot touch it.
    expect((await upload(streamer, id, await portrait())).statusCode).toBe(404);
  });

  it("reaches the shop only after the owner approves it", async () => {
    const author = await createTestChannel(db.sql, { plan: "premium" });
    const buyer = await createTestChannel(db.sql, { plan: "premium" });
    const id = await create(author);
    // The author uses a private character right away; nobody else sees it.
    expect((await call("PUT", "/settings/character", author, { characterId: id })).statusCode).toBe(
      200
    );
    expect((await characters(buyer)).shop.some((item) => item.id === id)).toBe(false);
    expect((await call("PUT", "/settings/character", buyer, { characterId: id })).statusCode).toBe(
      404
    );

    expect((await call("POST", `/characters/${id}/publish`, author)).json()).toMatchObject({
      status: "pending"
    });
    expect((await characters(buyer)).shop.some((item) => item.id === id)).toBe(false);
    const queue = (await call("GET", "/admin/characters", owner)).json<{ id: string }[]>();
    expect(queue.some((item) => item.id === id)).toBe(true);
    expect(
      (await call("POST", `/admin/characters/${id}/review`, owner, { approve: true })).statusCode
    ).toBe(200);
    expect((await characters(buyer)).shop).toContainEqual(
      expect.objectContaining({ id, author: author.login })
    );

    // The buyer picks her under another name; the name is checked like the author's.
    expect(
      (await call("PUT", "/settings/character", buyer, { characterId: id, characterName: "x_1" }))
        .statusCode
    ).toBe(400);
    expect(
      (
        await call("PUT", "/settings/character", buyer, { characterId: id, characterName: "Мурка" })
      ).json()
    ).toEqual({ characterId: id, characterName: "Мурка" });
    // A free channel cannot pick her; clearing works on any plan.
    expect(
      (await call("PUT", "/settings/character", streamer, { characterId: id })).statusCode
    ).toBe(403);
    expect(
      (await call("PUT", "/settings/character", streamer, { characterId: null })).statusCode
    ).toBe(200);

    // A published character is locked; the owner can take it off the shop.
    expect(
      (
        await call("PATCH", `/characters/${id}`, author, { name: "Другая", archetype: "yandere" })
      ).json()
    ).toMatchObject({ error: { code: "character_published" } });
    expect((await upload(author, id, await portrait())).statusCode).toBe(409);
    await call("POST", `/admin/characters/${id}/review`, owner, { approve: false, note: "фон" });
    expect((await characters(buyer)).shop.some((item) => item.id === id)).toBe(false);
    expect((await characters(author)).own[0]).toMatchObject({ status: "rejected" });
    expect(
      (await call("POST", `/admin/characters/${id}/review`, streamer, { approve: true })).statusCode
    ).toBe(403);
  });

  it("lets the owner offer voices, queues their samples and hides switched-off ones", async () => {
    const added = await call("POST", "/admin/voices", owner, { id: VOICE_ID, label: "Звонкая" });
    expect(added.statusCode).toBe(201);
    expect(
      (await call("POST", "/admin/voices", owner, { id: VOICE_ID, label: "Ещё" })).statusCode
    ).toBe(409);
    const [job] = await db.sql<{ data: { voiceId: string } }[]>`
      select data from pgboss.job where name=${VOICE_SAMPLE_QUEUE} order by created_on desc limit 1`;
    expect(job?.data).toEqual({ voiceId: VOICE_ID });

    const premium = await createTestChannel(db.sql, { plan: "premium" });
    expect((await characters(premium)).voices).toContainEqual(
      expect.objectContaining({ id: VOICE_ID, sampleReady: false })
    );
    expect((await call("GET", `/voices/${VOICE_ID}/sample`)).statusCode).toBe(404);
    await db.sql`update voices set sample=${Buffer.from("RIFFsample")}, sample_status='ready'
      where id=${VOICE_ID}`;
    const sample = await call("GET", `/voices/${VOICE_ID}/sample`);
    expect(sample.headers["content-type"]).toBe("audio/wav");

    await call("PATCH", `/admin/voices/${VOICE_ID}`, owner, { enabled: false });
    expect((await characters(premium)).voices.some((voice) => voice.id === VOICE_ID)).toBe(false);
    expect(
      (
        await call("POST", "/characters", premium, {
          name: "Кэт",
          archetype: "himedere",
          voiceId: VOICE_ID
        })
      ).statusCode
    ).toBe(400);
    expect(
      (await call("POST", "/admin/voices", streamer, { id: VOICE_ID, label: "x" })).statusCode
    ).toBe(403);
    await call("DELETE", `/admin/voices/${VOICE_ID}`, owner);
  });

  it("gives the overlay the character's picture as a URL", async () => {
    const socket = await app.injectWS(`/overlay/${encodeURIComponent(streamer.overlayToken)}`);
    await nextMessage(socket, "overlay.ready");
    const pending = nextMessage(socket, "roast.play");
    const imagePath = `/characters/${randomUUID()}/image?v=0123456789abcdef`;
    await publishOverlayEvent(streamer, { character: { name: "Кэт", imagePath } });
    expect((await pending).character).toEqual({
      name: "Кэт",
      imageUrl: `https://app.test/api${imagePath}`
    });
    socket.terminate();
  });
});
