import { randomUUID } from "node:crypto";

import { createDatabase } from "@roastbot/db";
import {
  COMMAND_PLANS,
  COOLDOWN_SOURCES,
  ROAST_REQUESTED_QUEUE,
  ROAST_REQUESTED_QUEUE_OPTIONS,
  triggerSettingsSchema,
  type TriggerSettings
} from "@roastbot/shared";
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
  reconnectDelayMs
} from "./core.js";
import { DonationAlertsConnection, type DonationAlertsAccount } from "./donationalerts.js";
import {
  chatTrigger,
  donationRoast,
  eventRoast,
  subscriptionSpecs,
  type SubscriptionSpec
} from "./triggers.js";

const config = z
  .object({
    DATABASE_URL: z.string().min(1),
    TWITCH_CLIENT_ID: z.string().min(1),
    TWITCH_CLIENT_SECRET: z.string().min(1),
    TOKEN_ENCRYPTION_KEY: z.string().regex(/^[a-fA-F0-9]{64}$/u),
    // Optional: without both, connected DonationAlerts accounts are not listened to.
    DONATIONALERTS_CLIENT_ID: z.string().optional(),
    DONATIONALERTS_CLIENT_SECRET: z.string().optional()
  })
  .parse(process.env);

const database = createDatabase(config.DATABASE_URL, { applicationName: "roastbot-twitch" });
const sql = database.client;
const boss = new PgBoss(config.DATABASE_URL);
boss.on("error", (error) => console.error("pg-boss:", error));
await boss.start();
await boss.createQueue(ROAST_REQUESTED_QUEUE, { ...ROAST_REQUESTED_QUEUE_OPTIONS });

interface ChannelRow {
  id: string;
  twitchId: string;
  twitchLogin: string;
  triggers: unknown;
  scopes: string[];
  planCode: string | null;
  accessCiphertext: string;
  accessIv: string;
  accessTag: string;
  refreshCiphertext: string;
  refreshIv: string;
  refreshTag: string;
  expiresAt: Date;
}

interface Channel extends Omit<ChannelRow, "triggers"> {
  triggers: TriggerSettings;
  /** EventSub subscriptions this channel needs; empty means no EventSub connection. */
  specs: SubscriptionSpec[];
}

async function activeChannels(): Promise<Channel[]> {
  const rows = await sql<ChannelRow[]>`
    select c.id,c.twitch_login "twitchLogin",u.twitch_id "twitchId",s.triggers,t.scopes,
      t.access_token_ciphertext "accessCiphertext",
      t.access_token_iv "accessIv",t.access_token_tag "accessTag",
      t.refresh_token_ciphertext "refreshCiphertext",t.refresh_token_iv "refreshIv",
      t.refresh_token_tag "refreshTag",t.expires_at "expiresAt",p.code "planCode"
    from channels c join users u on u.id=c.user_id join settings s on s.channel_id=c.id
    join twitch_tokens t on t.channel_id=c.id
    left join lateral (
      select sub.plan_id from subscriptions sub
      where sub.user_id=u.id and (sub.valid_until is null or sub.valid_until>now())
      order by sub.created_at desc limit 1
    ) sub on true
    left join plans p on p.id=sub.plan_id
    where u.status='active' and s.enabled=true`;
  return rows.flatMap((row) => {
    // Rows saved before newer trigger fields existed are completed with defaults here.
    const parsed = triggerSettingsSchema.safeParse(row.triggers ?? {});
    if (!parsed.success) {
      console.error(`Invalid trigger settings for ${row.twitchLogin}; channel skipped`);
      return [];
    }
    const triggers = parsed.data;
    return [{ ...row, triggers, specs: subscriptionSpecs({ ...row, triggers }, row.scopes) }];
  });
}

const specsKey = (channel: Channel) => JSON.stringify(channel.specs);

const chat = new tmi.Client({ connection: { reconnect: true, secure: true } });
const eventSubs = new Map<string, EventSubConnection>();
const donationFeeds = new Map<string, DonationAlertsConnection>();
const timers: { reconciliation?: NodeJS.Timeout } = {};

// Registered before connecting to IRC so a stop during startup still shuts down cleanly.
async function shutdown() {
  clearInterval(timers.reconciliation);
  for (const connection of eventSubs.values()) connection.stop();
  for (const feed of donationFeeds.values()) feed.stop();
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
  if (!channel) return;
  const viewerLogin = tags.username ?? "viewer";
  const roast = chatTrigger(
    {
      message,
      username: viewerLogin,
      displayName: tags["display-name"] ?? viewerLogin,
      isBroadcaster: tags["user-id"] === channel.twitchId
    },
    channel.triggers,
    { commandAllowed: COMMAND_PLANS.has(channel.planCode ?? "") }
  );
  if (!roast) return;
  void (async () => {
    // Cheap pre-check: chat spam during a cooldown never reaches the queue.
    if (COOLDOWN_SOURCES.has(roast.source) && (await isOnCooldown(sql, channel.id, viewerLogin))) {
      return;
    }
    await enqueueEvent(sql, boss, {
      channelId: channel.id,
      source: roast.source,
      providerEventId: tags.id ?? `irc:${channel.id}:${randomUUID()}`,
      ...(tags["user-id"] ? { viewerId: tags["user-id"] } : {}),
      viewerLogin,
      inputText: roast.inputText,
      target: roast.target,
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

  get key(): string {
    return specsKey(this.channel);
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
      if (subscribeOnWelcome) {
        for (const spec of this.channel.specs) await this.subscribe(session.id, spec);
      }
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
    if (type !== "notification") return;
    const subscriptionType = z
      .object({ subscription_type: z.string() })
      .parse(message.metadata).subscription_type;
    const event = z
      .record(z.string(), z.unknown())
      .parse((message.payload as { event?: unknown }).event);
    const roast = eventRoast(
      subscriptionType,
      event,
      this.channel.triggers,
      this.channel.twitchLogin
    );
    if (!roast) return;
    await enqueueEvent(sql, boss, {
      channelId: this.channel.id,
      source: roast.source,
      providerEventId: message.metadata.message_id,
      ...(roast.viewerId ? { viewerId: roast.viewerId } : {}),
      viewerLogin: roast.viewerLogin,
      inputText: roast.inputText,
      target: roast.target,
      ...(roast.eventSummary ? { eventSummary: roast.eventSummary } : {}),
      raw: JSON.parse(raw) as JSONValue
    });
  }

  private async subscribe(
    sessionId: string,
    spec: SubscriptionSpec,
    retryUnauthorized = true
  ): Promise<void> {
    const token = await accessToken(this.channel);
    const response = await fetch("https://api.twitch.tv/helix/eventsub/subscriptions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Client-Id": config.TWITCH_CLIENT_ID,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        type: spec.type,
        version: spec.version,
        condition: spec.condition,
        transport: { method: "websocket", session_id: sessionId }
      })
    });
    if (response.status === 401 && retryUnauthorized) {
      this.channel.expiresAt = new Date(0);
      await this.subscribe(sessionId, spec, false);
      return;
    }
    // One rejected event type (e.g. a scope revoked on Twitch's side) must not take down the
    // others on this connection.
    if (!response.ok) {
      console.error(
        `EventSub ${this.channel.twitchLogin}: ${spec.type} rejected (${String(response.status)})`
      );
    }
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
    if (!channel.specs.length) {
      if (current) {
        current.stop();
        eventSubs.delete(channel.id);
      }
      continue;
    }
    if (current && current.key === specsKey(channel)) current.update(channel);
    else {
      // Subscriptions are created on session welcome, so a changed set needs a new session.
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
  await reconcileDonations(channels);
}

// ---- DonationAlerts ------------------------------------------------------------------------

async function reconcileDonations(channels: Channel[]): Promise<void> {
  const { DONATIONALERTS_CLIENT_ID: clientId, DONATIONALERTS_CLIENT_SECRET: clientSecret } = config;
  const wanted = channels.filter((channel) => channel.triggers.events.donation.enabled);
  const accounts =
    clientId && clientSecret && wanted.length
      ? await sql<DonationAlertsAccount[]>`
          select channel_id "channelId", da_user_id "daUserId",
            access_token_ciphertext "accessCiphertext", access_token_iv "accessIv",
            access_token_tag "accessTag", refresh_token_ciphertext "refreshCiphertext",
            refresh_token_iv "refreshIv", refresh_token_tag "refreshTag", expires_at "expiresAt"
          from donationalerts_accounts where channel_id in ${sql(wanted.map((item) => item.id))}`
      : [];
  for (const [channelId, feed] of donationFeeds) {
    const account = accounts.find((item) => item.channelId === channelId);
    if (!account || account.daUserId !== feed.daUserId) {
      feed.stop();
      donationFeeds.delete(channelId);
    }
  }
  if (!clientId || !clientSecret) return;
  for (const account of accounts) {
    if (donationFeeds.has(account.channelId)) continue;
    const feed = new DonationAlertsConnection(account, {
      clientId,
      clientSecret,
      encryptionKey: config.TOKEN_ENCRYPTION_KEY,
      saveTokens: async (channelId, tokens) => {
        await sql`update donationalerts_accounts set
          access_token_ciphertext=${tokens.accessCiphertext}, access_token_iv=${tokens.accessIv},
          access_token_tag=${tokens.accessTag}, refresh_token_ciphertext=${tokens.refreshCiphertext},
          refresh_token_iv=${tokens.refreshIv}, refresh_token_tag=${tokens.refreshTag},
          expires_at=now()+${tokens.expiresInSeconds}*interval '1 second', updated_at=now()
          where channel_id=${channelId}`;
      },
      onDonation: async (donation) => {
        // Settings may have changed since the feed started; read the live channel.
        const channel = [...channelByLogin.values()].find((item) => item.id === account.channelId);
        if (!channel) return;
        const roast = donationRoast(donation, channel.triggers, channel.twitchLogin);
        if (!roast) return;
        await enqueueEvent(sql, boss, {
          channelId: channel.id,
          source: roast.source,
          providerEventId: `da:${typeof donation.id === "number" || typeof donation.id === "string" ? String(donation.id) : randomUUID()}`,
          viewerLogin: roast.viewerLogin,
          inputText: roast.inputText,
          target: roast.target,
          ...(roast.eventSummary ? { eventSummary: roast.eventSummary } : {}),
          raw: donation as JSONValue
        });
      },
      log: (message, error) => console.error(message, error ?? "")
    });
    donationFeeds.set(account.channelId, feed);
    feed.start();
  }
}

// One reconcile at a time: a settings change during a run queues exactly one more run, so a
// burst of saves never joins a channel twice or opens two EventSub sessions.
let running: Promise<void> | undefined;
let again = false;
function scheduleReconcile(): void {
  if (running) {
    again = true;
    return;
  }
  running = reconcile()
    .catch(console.error)
    .finally(() => {
      running = undefined;
      if (again) {
        again = false;
        scheduleReconcile();
      }
    });
}

await reconcile();
// The database notifies on settings, approvals, new scopes and DonationAlerts links
// (migration 0008); the poll stays as a safety net for a missed notification.
await sql.listen("channels_changed", scheduleReconcile);
timers.reconciliation = setInterval(scheduleReconcile, 60_000);
