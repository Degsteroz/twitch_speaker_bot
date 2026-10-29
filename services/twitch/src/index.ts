import { randomUUID } from "node:crypto";

import { createDatabase } from "@roastbot/db";
import {
  COMMAND_PLANS,
  CUSTOM_CHARACTER_PLANS,
  donationDelaySeconds,
  KEYWORD_EVERY,
  REWARD_EVERY,
  ROAST_REQUESTED_QUEUE,
  ROAST_REQUESTED_QUEUE_OPTIONS,
  STREAMER_JOB_PRIORITY,
  TELEGRAM_NOTIFY_QUEUE
} from "@roastbot/shared";
import { PgBoss } from "pg-boss";
import tmi from "tmi.js";
import type { JSONValue } from "postgres";

import { activeChannels, channelApi, specsKey, type Channel } from "./channels.js";
import { loadConfig } from "./config.js";
import { enqueueEvent, isOnCooldown } from "./core.js";
import { DonationAlertsConnection, type DonationAlertsAccount } from "./donationalerts.js";
import { EventSubConnection, type EventSubHooks } from "./eventsub.js";
import { JOIN_INTERVAL_MS, JoinQueue } from "./join-queue.js";
import { EveryNth, chatTrigger, donationRoast, eventRoast, optOutCommand } from "./triggers.js";

const config = loadConfig();
const database = createDatabase(config.DATABASE_URL, { applicationName: "roastbot-twitch" });
const sql = database.client;
const boss = new PgBoss(config.DATABASE_URL);
boss.on("error", (error) => console.error("pg-boss:", error));
await boss.start();
await boss.createQueue(ROAST_REQUESTED_QUEUE, { ...ROAST_REQUESTED_QUEUE_OPTIONS });
await boss.createQueue(TELEGRAM_NOTIFY_QUEUE);

const { accessToken, withGame } = channelApi(sql, config);

// tmi rejoins every joined channel after a reconnect at this pace; our own joins share the budget.
const chat = new tmi.Client({
  options: { joinInterval: JOIN_INTERVAL_MS },
  connection: { reconnect: true, secure: true }
});
const joins = new JoinQueue({
  join: (login) => chat.join(login),
  joined: (login) => chat.getChannels().includes(`#${login}`),
  log: (message, error) => console.error(message, error)
});
const eventSubs = new Map<string, EventSubConnection>();
const donationFeeds = new Map<string, DonationAlertsConnection>();
const timers: { reconciliation?: NodeJS.Timeout } = {};

// Registered before connecting to IRC so a stop during startup still shuts down cleanly.
async function shutdown() {
  clearInterval(timers.reconciliation);
  joins.stop();
  for (const connection of eventSubs.values()) connection.stop();
  for (const feed of donationFeeds.values()) feed.stop();
  await chat.disconnect().catch(() => undefined);
  await boss.stop();
  await database.close();
}
process.once("SIGINT", () => void shutdown().finally(() => process.exit(0)));
process.once("SIGTERM", () => void shutdown().finally(() => process.exit(0)));
const channelByLogin = new Map<string, Channel>();
// How often chat words and rewards are answered, per channel (KEYWORD_EVERY, REWARD_EVERY).
// In memory: a restart only makes the next hit due a little early.
const keywordGate = new EveryNth();
const rewardGate = new EveryNth();
chat.on("message", (channelName, tags, message, self) => {
  if (self) return;
  const channel = channelByLogin.get(channelName.replace(/^#/u, "").toLowerCase());
  if (!channel) return;
  const viewerLogin = tags.username ?? "viewer";
  const optOut = optOutCommand(message);
  if (optOut) {
    // The viewer's own wish about themselves; the streamer sees the list in the panel.
    void (
      optOut === "stop"
        ? sql`insert into viewer_optouts(channel_id,viewer_login) values(${channel.id},${viewerLogin})
          on conflict do nothing`
        : sql`delete from viewer_optouts where channel_id=${channel.id} and viewer_login=${viewerLogin}`
    ).catch(console.error);
    return;
  }
  const isBroadcaster = tags["user-id"] === channel.twitchId;
  const roast = chatTrigger(
    {
      message,
      username: viewerLogin,
      displayName: tags["display-name"] ?? viewerLogin,
      isBroadcaster
    },
    channel.triggers,
    {
      commandAllowed: channel.unlimited || COMMAND_PLANS.has(channel.planCode ?? ""),
      ...(channel.characterName &&
      (channel.unlimited || CUSTOM_CHARACTER_PLANS.has(channel.planCode ?? ""))
        ? { characterName: channel.characterName }
        : {})
    }
  );
  if (!roast) return;
  void (async () => {
    // Only every Nth message with a trigger word is answered; the others stay silent. An
    // unlimited channel answers every one.
    if (roast.source === "chat_keyword" && !channel.unlimited) {
      if (!keywordGate.due(channel.id, KEYWORD_EVERY[channel.triggers.chatFrequency])) return;
      // A plain word on a pause is dropped and stays due; a call by name still reaches the worker,
      // which answers it with a stub so the viewer knows the bot heard them.
      if (!roast.named && (await isOnCooldown(sql, channel.id, viewerLogin))) return;
      keywordGate.reset(channel.id);
    }
    await enqueueEvent(sql, boss, {
      channelId: channel.id,
      source: roast.source,
      providerEventId: tags.id ?? `irc:${channel.id}:${randomUUID()}`,
      ...(tags["user-id"] ? { viewerId: tags["user-id"] } : {}),
      viewerLogin,
      inputText: roast.inputText,
      target: roast.target,
      ...(roast.named ? { named: true } : {}),
      ...(isBroadcaster ? { priority: STREAMER_JOB_PRIORITY } : {}),
      ...(await withGame(channel)),
      raw: { tags, message }
    });
  })().catch(console.error);
});
// After a reconnect tmi rejoins everything that was joined; ours wait until it is done.
chat.on("connected", () => joins.pause(channelByLogin.size * JOIN_INTERVAL_MS));
await chat.connect();

const eventSubHooks: EventSubHooks = {
  wsUrl: config.TWITCH_EVENTSUB_WS_URL,
  subscriptionsUrl: config.TWITCH_EVENTSUB_SUBSCRIPTIONS_URL,
  clientId: config.TWITCH_CLIENT_ID,
  accessToken,
  subscribed: async (channel, results) => {
    await saveEventSubState(channel.id, true, results);
    await notifyRejected(channel, results);
  },
  disconnected: (channel) => saveEventSubState(channel.id, false),
  notification: async (channel, { subscriptionType, event, messageId, raw }) => {
    const roast = eventRoast(subscriptionType, event, channel.triggers, channel.twitchLogin);
    if (!roast) return;
    // Every Nth reward gets a roast, the others a short "no" (REWARD_DECLINED_STUB).
    let declined = false;
    if (roast.source === "reward" && !channel.unlimited) {
      declined = !rewardGate.due(channel.id, REWARD_EVERY[channel.triggers.chatFrequency]);
      if (!declined) rewardGate.reset(channel.id);
    }
    await enqueueEvent(sql, boss, {
      channelId: channel.id,
      source: roast.source,
      providerEventId: messageId,
      ...(roast.viewerId ? { viewerId: roast.viewerId } : {}),
      viewerLogin: roast.viewerLogin,
      inputText: roast.inputText,
      target: roast.target,
      ...(roast.eventSummary ? { eventSummary: roast.eventSummary } : {}),
      ...(declined ? { declined } : {}),
      // The streamer redeeming their own reward is the streamer's request too.
      ...(roast.viewerId === channel.twitchId ? { priority: STREAMER_JOB_PRIORITY } : {}),
      ...(await withGame(channel)),
      raw: JSON.parse(raw) as JSONValue
    });
  }
};

/** Tells the streamer's Telegram once a day per type that Twitch refused a subscription. */
async function notifyRejected(channel: Channel, results: Record<string, string>): Promise<void> {
  const day = new Date().toISOString().slice(0, 10);
  for (const [type, result] of Object.entries(results)) {
    if (result === "ok") continue;
    await boss
      .send(TELEGRAM_NOTIFY_QUEUE, {
        channelId: channel.id,
        kind: `eventsub:${type}`,
        period: day,
        text: `Twitch не принял подписку на ${type} (${result}). Награды и события могут не приходить: перезайдите в панель RoastBot через Twitch.`
      })
      .catch(console.error);
  }
}

async function saveEventSubState(
  channelId: string,
  connected: boolean,
  subscriptions?: Record<string, string>
): Promise<void> {
  if (subscriptions) {
    await sql`insert into eventsub_state(channel_id,connected,subscriptions)
      values(${channelId},${connected},${sql.json(subscriptions)})
      on conflict(channel_id) do update set connected=excluded.connected,
        subscriptions=excluded.subscriptions, updated_at=now()`;
  } else {
    await sql`update eventsub_state set connected=${connected}, updated_at=now()
      where channel_id=${channelId}`;
  }
}

async function reconcile(): Promise<void> {
  const channels = await activeChannels(sql);
  const desired = new Set(channels.map((channel) => channel.twitchLogin.toLowerCase()));
  for (const login of [...channelByLogin.keys()]) {
    if (!desired.has(login)) {
      channelByLogin.delete(login);
      joins.forget(login);
      // A failed PART only leaves a channel whose messages nobody reads any more.
      chat.part(login).catch((error: unknown) => console.error(`IRC part ${login}:`, error));
    }
  }
  for (const channel of channels) {
    const login = channel.twitchLogin.toLowerCase();
    channelByLogin.set(login, channel);
    // JOINs go out at Twitch's pace in the background, so a thousand channels never hold up the
    // EventSub sessions below; one that fails is asked for again on the next reconcile.
    joins.want(login);
    const current = eventSubs.get(channel.id);
    if (!channel.specs.length) {
      if (current) {
        current.stop();
        eventSubs.delete(channel.id);
        await sql`delete from eventsub_state where channel_id=${channel.id}`;
      }
      continue;
    }
    if (current && current.key === specsKey(channel)) current.update(channel);
    else {
      // Subscriptions are created on session welcome, so a changed set needs a new session.
      current?.stop();
      const connection = new EventSubConnection(channel, eventSubHooks);
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
          ...(await withGame(channel)),
          // DonationAlerts plays its alert and reads the message first; answer after it.
          delaySeconds: donationDelaySeconds(
            roast.inputText,
            channel.triggers.events.donation.delaySec
          ),
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
