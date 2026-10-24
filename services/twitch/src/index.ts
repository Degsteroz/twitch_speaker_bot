import { randomUUID } from "node:crypto";

import { createDatabase } from "@roastbot/db";
import { ROAST_REQUESTED_QUEUE, ROAST_REQUESTED_QUEUE_OPTIONS } from "@roastbot/shared";
import { PgBoss } from "pg-boss";
import tmi from "tmi.js";
import type { JSONValue } from "postgres";
import WebSocket from "ws";
import { z } from "zod";

import {
  decryptToken,
  encryptToken,
  enqueueEvent,
  isOnCooldown,
  parseRoastCommand,
  reconnectDelayMs
} from "./core.js";

const config = z
  .object({
    DATABASE_URL: z.string().min(1),
    TWITCH_CLIENT_ID: z.string().min(1),
    TWITCH_CLIENT_SECRET: z.string().min(1),
    TOKEN_ENCRYPTION_KEY: z.string().regex(/^[a-fA-F0-9]{64}$/u)
  })
  .parse(process.env);

const database = createDatabase(config.DATABASE_URL, { applicationName: "roastbot-twitch" });
const sql = database.client;
const boss = new PgBoss(config.DATABASE_URL);
boss.on("error", (error) => console.error("pg-boss:", error));
await boss.start();
await boss.createQueue(ROAST_REQUESTED_QUEUE, { ...ROAST_REQUESTED_QUEUE_OPTIONS });

interface Channel {
  id: string;
  twitchId: string;
  twitchLogin: string;
  commandEnabled: boolean;
  rewardId: string | null;
  accessCiphertext: string;
  accessIv: string;
  accessTag: string;
  refreshCiphertext: string;
  refreshIv: string;
  refreshTag: string;
  expiresAt: Date;
}

async function activeChannels(): Promise<Channel[]> {
  return sql<Channel[]>`
    select c.id,c.twitch_login "twitchLogin",u.twitch_id "twitchId",
      coalesce((s.triggers->>'command')::boolean,true) "commandEnabled",
      s.triggers->>'rewardId' "rewardId",t.access_token_ciphertext "accessCiphertext",
      t.access_token_iv "accessIv",t.access_token_tag "accessTag",
      t.refresh_token_ciphertext "refreshCiphertext",t.refresh_token_iv "refreshIv",
      t.refresh_token_tag "refreshTag",t.expires_at "expiresAt"
    from channels c join users u on u.id=c.user_id join settings s on s.channel_id=c.id
    join twitch_tokens t on t.channel_id=c.id
    where u.status='active' and s.enabled=true`;
}

const chat = new tmi.Client({ connection: { reconnect: true, secure: true } });
const eventSubs = new Map<string, EventSubConnection>();
const timers: { reconciliation?: NodeJS.Timeout } = {};

// Registered before connecting to IRC so a stop during startup still shuts down cleanly.
async function shutdown() {
  clearInterval(timers.reconciliation);
  for (const connection of eventSubs.values()) connection.stop();
  await chat.disconnect().catch(() => undefined);
  await boss.stop();
  await database.close();
}
process.once("SIGINT", () => void shutdown().finally(() => process.exit(0)));
process.once("SIGTERM", () => void shutdown().finally(() => process.exit(0)));
const channelByLogin = new Map<string, Channel>();
chat.on("message", (channelName, tags, message, self) => {
  if (self) return;
  const channel = channelByLogin.get(channelName.replace(/^#/u, "").toLowerCase());
  if (!channel?.commandEnabled) return;
  const inputText = parseRoastCommand(message, tags["display-name"] ?? tags.username ?? "viewer");
  if (inputText === null) return;
  const viewerLogin = tags.username ?? "viewer";
  void (async () => {
    if (await isOnCooldown(sql, channel.id, viewerLogin)) return;
    await enqueueEvent(sql, boss, {
      channelId: channel.id,
      source: "chat_command",
      providerEventId: tags.id ?? `irc:${channel.id}:${randomUUID()}`,
      ...(tags["user-id"] ? { viewerId: tags["user-id"] } : {}),
      viewerLogin,
      inputText,
      raw: { tags, message }
    });
  })().catch(console.error);
});
await chat.connect();

async function accessToken(channel: Channel): Promise<string> {
  if (channel.expiresAt.getTime() > Date.now() + 120_000) {
    return decryptToken(
      {
        ciphertext: channel.accessCiphertext,
        iv: channel.accessIv,
        tag: channel.accessTag
      },
      config.TOKEN_ENCRYPTION_KEY
    );
  }
  const refresh = decryptToken(
    {
      ciphertext: channel.refreshCiphertext,
      iv: channel.refreshIv,
      tag: channel.refreshTag
    },
    config.TOKEN_ENCRYPTION_KEY
  );
  const response = await fetch("https://id.twitch.tv/oauth2/token", {
    method: "POST",
    body: new URLSearchParams({
      client_id: config.TWITCH_CLIENT_ID,
      client_secret: config.TWITCH_CLIENT_SECRET,
      grant_type: "refresh_token",
      refresh_token: refresh
    })
  });
  if (!response.ok) throw new Error(`token_refresh_${response.status}`);
  const token = z
    .object({
      access_token: z.string(),
      refresh_token: z.string(),
      expires_in: z.number(),
      scope: z.array(z.string())
    })
    .parse(await response.json());
  const encryptedAccess = encryptToken(token.access_token, config.TOKEN_ENCRYPTION_KEY);
  const encryptedRefresh = encryptToken(token.refresh_token, config.TOKEN_ENCRYPTION_KEY);
  await sql`update twitch_tokens set access_token_ciphertext=${encryptedAccess.ciphertext},
    access_token_iv=${encryptedAccess.iv},access_token_tag=${encryptedAccess.tag},
    refresh_token_ciphertext=${encryptedRefresh.ciphertext},refresh_token_iv=${encryptedRefresh.iv},
    refresh_token_tag=${encryptedRefresh.tag},expires_at=now()+${token.expires_in}*interval '1 second',
    scopes=${token.scope},updated_at=now() where channel_id=${channel.id}`;
  channel.accessCiphertext = encryptedAccess.ciphertext;
  channel.accessIv = encryptedAccess.iv;
  channel.accessTag = encryptedAccess.tag;
  channel.refreshCiphertext = encryptedRefresh.ciphertext;
  channel.refreshIv = encryptedRefresh.iv;
  channel.refreshTag = encryptedRefresh.tag;
  channel.expiresAt = new Date(Date.now() + token.expires_in * 1000);
  return token.access_token;
}

class EventSubConnection {
  private socket?: WebSocket;
  private watchdog?: NodeJS.Timeout;
  private stopped = false;
  private keepaliveSeconds = 10;
  private failures = 0;
  private reconnectTimer?: NodeJS.Timeout;

  constructor(private channel: Channel) {}

  get rewardId(): string | null {
    return this.channel.rewardId;
  }

  start(url = "wss://eventsub.wss.twitch.tv/ws", subscribeOnWelcome = true): void {
    if (this.stopped) return;
    const socket = new WebSocket(url);
    this.socket = socket;
    socket.on(
      "message",
      (data) =>
        void this.onMessage(
          Array.isArray(data)
            ? Buffer.concat(data).toString("utf8")
            : Buffer.from(data instanceof ArrayBuffer ? new Uint8Array(data) : data).toString(
                "utf8"
              ),
          subscribeOnWelcome
        ).catch((error) => {
          console.error(`EventSub ${this.channel.twitchLogin}:`, error);
          socket.close();
        })
    );
    socket.on("close", () => {
      if (this.socket !== socket || this.stopped) return;
      const delay = reconnectDelayMs(this.failures++);
      this.reconnectTimer = setTimeout(() => this.start(), delay);
    });
    socket.on("error", (error) => console.error(`EventSub ${this.channel.twitchLogin}:`, error));
  }

  update(channel: Channel): void {
    this.channel = channel;
  }

  stop(): void {
    this.stopped = true;
    if (this.watchdog) clearTimeout(this.watchdog);
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.socket?.close();
  }

  private armWatchdog(seconds: number): void {
    if (this.watchdog) clearTimeout(this.watchdog);
    this.watchdog = setTimeout(() => this.socket?.terminate(), (seconds + 10) * 1000);
  }

  private async onMessage(raw: string, subscribeOnWelcome: boolean): Promise<void> {
    const message = z
      .object({
        metadata: z.object({ message_type: z.string(), message_id: z.string() }),
        payload: z.record(z.string(), z.unknown())
      })
      .passthrough()
      .parse(JSON.parse(raw));
    const type = message.metadata.message_type;
    if (type === "session_welcome") {
      const session = z
        .object({ id: z.string(), keepalive_timeout_seconds: z.number() })
        .parse((message.payload as { session?: unknown }).session);
      this.keepaliveSeconds = session.keepalive_timeout_seconds;
      this.armWatchdog(this.keepaliveSeconds);
      if (subscribeOnWelcome && this.channel.rewardId) await this.subscribe(session.id);
      this.failures = 0;
      return;
    }
    if (type === "session_keepalive") {
      this.armWatchdog(this.keepaliveSeconds);
      return;
    }
    if (type === "session_reconnect") {
      const reconnect = z
        .object({ reconnect_url: z.string().url() })
        .parse((message.payload as { session?: unknown }).session);
      const previous = this.socket;
      this.start(reconnect.reconnect_url, false);
      setTimeout(() => previous?.close(), 1_000);
      return;
    }
    if (type === "revocation") {
      console.error(`EventSub subscription revoked for ${this.channel.twitchLogin}`);
      this.socket?.close();
      return;
    }
    if (type !== "notification" || !this.channel.rewardId) return;
    const event = z
      .object({
        id: z.string(),
        broadcaster_user_id: z.string(),
        user_id: z.string().optional(),
        user_login: z.string(),
        user_input: z.string().default(""),
        reward: z.object({ id: z.string() })
      })
      .parse((message.payload as { event?: unknown }).event);
    if (event.reward.id !== this.channel.rewardId) return;
    await enqueueEvent(sql, boss, {
      channelId: this.channel.id,
      source: "reward",
      providerEventId: message.metadata.message_id,
      ...(event.user_id ? { viewerId: event.user_id } : {}),
      viewerLogin: event.user_login,
      inputText: event.user_input.trim() || event.user_login,
      raw: JSON.parse(raw) as JSONValue
    });
  }

  private async subscribe(sessionId: string, retryUnauthorized = true): Promise<void> {
    const token = await accessToken(this.channel);
    const response = await fetch("https://api.twitch.tv/helix/eventsub/subscriptions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Client-Id": config.TWITCH_CLIENT_ID,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        type: "channel.channel_points_custom_reward_redemption.add",
        version: "1",
        condition: { broadcaster_user_id: this.channel.twitchId, reward_id: this.channel.rewardId },
        transport: { method: "websocket", session_id: sessionId }
      })
    });
    if (response.status === 401 && retryUnauthorized) {
      this.channel.expiresAt = new Date(0);
      await this.subscribe(sessionId, false);
      return;
    }
    if (!response.ok) throw new Error(`eventsub_subscribe_${response.status}`);
  }
}

async function reconcile(): Promise<void> {
  const channels = await activeChannels();
  const desired = new Set(channels.map((channel) => channel.twitchLogin.toLowerCase()));
  for (const joined of channelByLogin.keys()) {
    if (!desired.has(joined)) {
      await chat.part(joined);
      channelByLogin.delete(joined);
    }
  }
  for (const channel of channels) {
    const login = channel.twitchLogin.toLowerCase();
    if (!channelByLogin.has(login)) await chat.join(login);
    channelByLogin.set(login, channel);
    const current = eventSubs.get(channel.id);
    if (!channel.rewardId) {
      if (current) {
        current.stop();
        eventSubs.delete(channel.id);
      }
      continue;
    }
    if (current && current.rewardId === channel.rewardId) current.update(channel);
    else {
      // The EventSub subscription condition pins reward_id, so a new reward needs a new session.
      current?.stop();
      const connection = new EventSubConnection(channel);
      eventSubs.set(channel.id, connection);
      connection.start();
    }
  }
  for (const [id, connection] of eventSubs) {
    if (!channels.some((channel) => channel.id === id)) {
      connection.stop();
      eventSubs.delete(id);
    }
  }
}

await reconcile();
timers.reconciliation = setInterval(() => void reconcile().catch(console.error), 60_000);
