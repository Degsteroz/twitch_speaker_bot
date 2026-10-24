import type { RoastSource, RoastTarget, TriggerSettings } from "@roastbot/shared";

import { parseRoastCommand } from "./core.js";

// Chat bots answer commands and post alerts; roasting them would only feed a loop.
export const KNOWN_BOTS: ReadonlySet<string> = new Set([
  "nightbot",
  "streamelements",
  "moobot",
  "fossabot",
  "wizebot",
  "streamlabs",
  "soundalerts",
  "sery_bot"
]);

const fold = (text: string) => text.toLocaleLowerCase("ru-RU").replaceAll("ё", "е");
const escapeRegExp = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");

/** The first keyword that starts a word of the message ("слил" matches "слился"), or null. */
export function matchKeyword(message: string, keywords: readonly string[]): string | null {
  const text = fold(message);
  for (const keyword of keywords) {
    const needle = fold(keyword.trim());
    if (!needle) continue;
    if (new RegExp(`(?:^|[^\\p{L}\\p{N}])${escapeRegExp(needle)}`, "u").test(text)) return keyword;
  }
  return null;
}

/** The message talks about the streamer: "стример" in any form, or the channel login. */
export function aboutStreamer(message: string, streamerLogin = ""): boolean {
  const text = fold(message);
  const login = fold(streamerLogin.trim());
  if (/(?:^|[^\p{L}\p{N}])стример/u.test(text)) return true;
  return login.length > 0 && new RegExp(`(?:^|[^\\p{L}\\p{N}_])@?${escapeRegExp(login)}(?![\\p{L}\\p{N}_])`, "u").test(text);
}

/** `random` is in [0, 1): below the percentage means "yes". */
export const rollPercent = (percent: number, random: number) => random * 100 < percent;

export const pickTarget = (streamerPercent: number, random: number): RoastTarget =>
  rollPercent(streamerPercent, random) ? "streamer" : "viewer";

export interface ChatMessage {
  message: string;
  username: string;
  displayName: string;
  isBroadcaster: boolean;
  /** The channel login, to notice "@streamer" in the message. */
  streamerLogin?: string;
}

export interface ChatRoast {
  source: Extract<RoastSource, "chat_command" | "chat_keyword">;
  inputText: string;
  target: RoastTarget;
}

/**
 * Decides whether a chat message triggers a roast. `!роаст` works when enabled; otherwise other
 * commands and known bots are ignored, and a keyword fires with `keywordChancePercent`. The
 * target is then the streamer with `streamerTargetPercent`; the streamer's own message always
 * roasts the streamer (there is nobody else to pick, and it is how a streamer tests the bot alone).
 */
export function chatTrigger(
  chat: ChatMessage,
  triggers: TriggerSettings,
  random: () => number = Math.random
): ChatRoast | null {
  if (KNOWN_BOTS.has(chat.username.toLowerCase())) return null;
  const target = (text: string): RoastTarget => {
    if (chat.isBroadcaster) return "streamer";
    // "скажи стримеру, что он мажет" is about the streamer: a coin flip would answer the
    // viewer instead. A channel that chose "only the chatter" (0%) keeps its streamer safe.
    if (triggers.streamerTargetPercent > 0 && aboutStreamer(text, chat.streamerLogin)) {
      return "streamer";
    }
    return pickTarget(triggers.streamerTargetPercent, random());
  };
  if (triggers.command) {
    const inputText = parseRoastCommand(chat.message, chat.displayName);
    if (inputText !== null) return { source: "chat_command", inputText, target: target(inputText) };
  }
  if (chat.message.trimStart().startsWith("!")) return null;
  if (!triggers.keywords.length || !matchKeyword(chat.message, triggers.keywords)) return null;
  if (!rollPercent(triggers.keywordChancePercent, random())) return null;
  return { source: "chat_keyword", inputText: chat.message, target: target(chat.message) };
}

// ---- EventSub --------------------------------------------------------------------------------

export interface SubscriptionSpec {
  type: string;
  version: string;
  condition: Record<string, string>;
}

/**
 * EventSub subscriptions for one channel: the channel-points reward plus every enabled event the
 * streamer granted a scope for. Events without their scope are skipped (the panel asks the
 * streamer to log in again) instead of failing the whole connection.
 */
export function subscriptionSpecs(
  channel: { twitchId: string; triggers: TriggerSettings },
  scopes: readonly string[]
): SubscriptionSpec[] {
  const { twitchId: id, triggers } = channel;
  const granted = new Set(scopes);
  const events = triggers.events;
  const broadcaster = { broadcaster_user_id: id };
  const specs: SubscriptionSpec[] = [];
  const add = (scope: string | null, spec: SubscriptionSpec) => {
    if (scope === null || granted.has(scope)) specs.push(spec);
  };
  if (triggers.rewardId) {
    add("channel:read:redemptions", {
      type: "channel.channel_points_custom_reward_redemption.add",
      version: "1",
      condition: { broadcaster_user_id: id, reward_id: triggers.rewardId }
    });
  }
  if (events.cheer.enabled) {
    add("bits:read", { type: "channel.cheer", version: "1", condition: broadcaster });
  }
  if (events.subscription.enabled) {
    add("channel:read:subscriptions", {
      type: "channel.subscribe",
      version: "1",
      condition: broadcaster
    });
    add("channel:read:subscriptions", {
      type: "channel.subscription.message",
      version: "1",
      condition: broadcaster
    });
  }
  if (events.giftSub.enabled) {
    add("channel:read:subscriptions", {
      type: "channel.subscription.gift",
      version: "1",
      condition: broadcaster
    });
  }
  if (events.raid.enabled) {
    add(null, { type: "channel.raid", version: "1", condition: { to_broadcaster_user_id: id } });
  }
  if (events.follow.enabled) {
    add("moderator:read:followers", {
      type: "channel.follow",
      version: "2",
      condition: { broadcaster_user_id: id, moderator_user_id: id }
    });
  }
  if (events.prediction.enabled) {
    add("channel:read:predictions", {
      type: "channel.prediction.end",
      version: "1",
      condition: broadcaster
    });
  }
  if (events.adBreak.enabled) {
    add("channel:read:ads", {
      type: "channel.ad_break.begin",
      version: "1",
      condition: broadcaster
    });
  }
  return specs;
}

export interface EventRoast {
  source: RoastSource;
  viewerLogin: string;
  viewerId?: string;
  inputText: string;
  /** Our own wording of what happened; viewer text stays in inputText. */
  eventSummary?: string;
  target: RoastTarget;
}

type Event = Record<string, unknown>;
const str = (value: unknown) => (typeof value === "string" ? value : "");
const num = (value: unknown) => (typeof value === "number" && Number.isFinite(value) ? value : 0);
const viewerId = (event: Event) => (str(event.user_id) ? { viewerId: str(event.user_id) } : {});
// "Cheer100 Cheer50 привет" → "привет": cheermotes are amounts, not words.
const stripCheermotes = (text: string) =>
  text
    .replace(/(?:^|\s)[a-z]+\d+(?=\s|$)/giu, " ")
    .replace(/\s+/gu, " ")
    .trim();

/**
 * Turns an EventSub notification into a roast request, or null when the channel's thresholds
 * and chances say to stay quiet. `streamer` is the channel login, used when nobody else fits.
 */
export function eventRoast(
  subscriptionType: string,
  event: Event,
  triggers: TriggerSettings,
  streamer: string,
  random: () => number = Math.random
): EventRoast | null {
  const events = triggers.events;
  const login = str(event.user_login);
  switch (subscriptionType) {
    case "channel.channel_points_custom_reward_redemption.add": {
      const reward = event.reward as Event | undefined;
      if (!triggers.rewardId || str(reward?.id) !== triggers.rewardId || !login) return null;
      const message = str(event.user_input).trim();
      // With rewardMode "verdict" the worker judges the message and picks the target itself.
      return {
        source: "reward",
        viewerLogin: login,
        ...viewerId(event),
        inputText: message || login,
        target:
          triggers.rewardMode === "roast" || !message
            ? "viewer"
            : pickTarget(triggers.streamerTargetPercent, random())
      };
    }
    case "channel.cheer": {
      const bits = num(event.bits);
      if (bits < events.cheer.minBits) return null;
      const anonymous = event.is_anonymous === true || !login;
      return {
        source: "cheer",
        viewerLogin: anonymous ? streamer : login,
        ...(anonymous ? {} : viewerId(event)),
        inputText: stripCheermotes(str(event.message)),
        eventSummary: `${anonymous ? "Анонимный зритель отправил" : "Зритель отправил"} ${String(bits)} битсов`,
        target: anonymous ? "streamer" : "viewer"
      };
    }
    case "channel.subscribe": {
      // Gifted subs also arrive here, one per recipient; the gifter is roasted once instead.
      if (event.is_gift === true || !login) return null;
      return {
        source: "subscription",
        viewerLogin: login,
        ...viewerId(event),
        inputText: "",
        eventSummary: "Новая подписка на канал",
        target: "viewer"
      };
    }
    case "channel.subscription.message": {
      if (!login) return null;
      const months = num(event.cumulative_months);
      const message = event.message as Event | undefined;
      return {
        source: "subscription",
        viewerLogin: login,
        ...viewerId(event),
        inputText: str(message?.text),
        eventSummary: `Продлил подписку: всего ${String(months)} мес.`,
        target: "viewer"
      };
    }
    case "channel.subscription.gift": {
      const total = num(event.total);
      if (total < events.giftSub.minCount) return null;
      const anonymous = event.is_anonymous === true || !login;
      return {
        source: "gift_sub",
        viewerLogin: anonymous ? streamer : login,
        ...(anonymous ? {} : viewerId(event)),
        inputText: "",
        eventSummary: `${anonymous ? "Аноним подарил" : "Подарил"} ${String(total)} подписок`,
        target: anonymous ? "streamer" : "viewer"
      };
    }
    case "channel.raid": {
      const viewers = num(event.viewers);
      const raider = str(event.from_broadcaster_user_login);
      if (!raider || viewers < events.raid.minViewers) return null;
      return {
        source: "raid",
        viewerLogin: raider,
        ...(str(event.from_broadcaster_user_id)
          ? { viewerId: str(event.from_broadcaster_user_id) }
          : {}),
        inputText: "",
        eventSummary: `Рейд с канала ${raider}: ${String(viewers)} зрителей`,
        target: "viewer"
      };
    }
    case "channel.follow": {
      if (!login || !rollPercent(events.follow.chancePercent, random())) return null;
      return {
        source: "follow",
        viewerLogin: login,
        ...viewerId(event),
        inputText: "",
        eventSummary: "Новый фолловер",
        target: "viewer"
      };
    }
    case "channel.prediction.end": {
      if (str(event.status) !== "resolved") return null;
      const outcomes = Array.isArray(event.outcomes) ? (event.outcomes as Event[]) : [];
      const winner = outcomes.find((outcome) => outcome.id === event.winning_outcome_id);
      const losers = outcomes.filter((outcome) => outcome !== winner);
      // The biggest loser: the top predictor of a losing outcome who put in the most points.
      const loser = losers
        .flatMap((outcome) =>
          Array.isArray(outcome.top_predictors) ? (outcome.top_predictors as Event[]) : []
        )
        .sort((a, b) => num(b.channel_points_used) - num(a.channel_points_used))[0];
      const target =
        loser && str(loser.user_login)
          ? pickTarget(triggers.streamerTargetPercent, random())
          : "streamer";
      const lostUsers = losers.reduce((sum, outcome) => sum + num(outcome.users), 0);
      return {
        source: "prediction",
        viewerLogin: target === "viewer" && loser ? str(loser.user_login) : streamer,
        ...(target === "viewer" && loser && str(loser.user_id)
          ? { viewerId: str(loser.user_id) }
          : {}),
        inputText: "",
        eventSummary: `Прогноз «${str(event.title)}» завершён: победил исход «${str(winner?.title)}», проиграли ${String(lostUsers)} зрителей`,
        target
      };
    }
    case "channel.ad_break.begin": {
      return {
        source: "ad_break",
        viewerLogin: streamer,
        inputText: "",
        eventSummary: `Стример запустил рекламу на ${String(num(event.duration_seconds))} секунд`,
        target: "streamer"
      };
    }
    default:
      return null;
  }
}

// ---- DonationAlerts --------------------------------------------------------------------------

/** A DonationAlerts donation as a roast request, or null below the threshold or when off. */
export function donationRoast(
  donation: Event,
  triggers: TriggerSettings,
  streamer: string
): EventRoast | null {
  const settings = triggers.events.donation;
  const amount = num(donation.amount);
  if (!settings.enabled || amount < settings.minAmount) return null;
  // DonationAlerts names are free text, not logins; an empty one is an anonymous donation.
  const name = str(donation.username).trim().slice(0, 64);
  const currency = str(donation.currency).slice(0, 8);
  return {
    source: "donation",
    viewerLogin: name || streamer,
    // Audio messages carry a file, not words.
    inputText: str(donation.message_type) === "audio" ? "" : str(donation.message),
    eventSummary: `${name ? "Донат" : "Анонимный донат"} ${String(amount)} ${currency}`.trim(),
    target: name ? "viewer" : "streamer"
  };
}

/**
 * Donations from one Centrifugo frame. A frame may hold several JSON replies, one per line;
 * a donation is a push on our channel: `{"result":{"channel":…,"data":{"data":{…}}}}`.
 */
export function extractDonations(frame: string, channel: string): Event[] {
  const donations: Event[] = [];
  for (const line of frame.split("\n")) {
    if (!line.trim()) continue;
    let reply: unknown;
    try {
      reply = JSON.parse(line);
    } catch {
      continue;
    }
    const result = (reply as { result?: { channel?: unknown; data?: { data?: unknown } } }).result;
    const donation = result?.data?.data;
    if (result?.channel === channel && typeof donation === "object" && donation !== null) {
      donations.push(donation as Event);
    }
  }
  return donations;
}
