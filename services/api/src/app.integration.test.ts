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
    const forged = await call("GET", "/admin/overview", cookieFor(streamer, { role: "owner" }));
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

/** Runs the OAuth callback with Twitch mocked and returns the issued session cookie. */
async function twitchLogin(user: { id: string; login: string }) {
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
    headers: { cookie: "oauth_state=state" }
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
