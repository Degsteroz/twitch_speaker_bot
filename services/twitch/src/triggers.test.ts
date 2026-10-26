import { DEFAULT_TRIGGERS, triggerSettingsSchema, type TriggerSettings } from "@roastbot/shared";
import { describe, expect, it } from "vitest";

import {
  chatTrigger,
  donationRoast,
  eventRoast,
  extractDonations,
  matchKeyword,
  optOutCommand,
  subscriptionSpecs
} from "./triggers.js";

const triggers = (patch: Record<string, unknown> = {}): TriggerSettings =>
  triggerSettingsSchema.parse({ ...DEFAULT_TRIGGERS, ...patch });
const withEvents = (events: Record<string, unknown>) =>
  triggers({ events: { ...DEFAULT_TRIGGERS.events, ...events } });
const always = () => 0;
const never = () => 0.999;
const chat = (message: string, extra: Partial<Parameters<typeof chatTrigger>[0]> = {}) => ({
  message,
  username: "viewer",
  displayName: "Viewer",
  isBroadcaster: false,
  ...extra
});

describe("chat triggers", () => {
  it("matches keywords at a word start, ignoring case and ё", () => {
    expect(matchKeyword("Опять СЛИЛСЯ на рейде", ["слил"])).toBe("слил");
    expect(matchKeyword("ещё раз", ["еще"])).toBe("еще");
    expect(matchKeyword("переслил", ["слил"])).toBeNull();
    expect(matchKeyword("(слил)", ["слил"])).toBe("слил");
  });

  it("answers !роаст only on a paid plan and keywords with their chance", () => {
    const settings = triggers({ keywords: ["слил"], keywordChancePercent: 50 });
    const paid = { commandAllowed: true, random: never };
    expect(chatTrigger(chat("!роаст мой aim"), settings, paid)).toEqual({
      source: "chat_command",
      inputText: "мой aim",
      target: "viewer"
    });
    expect(chatTrigger(chat("!роаст мой aim"), settings, { random: always })).toBeNull();
    expect(chatTrigger(chat("!роаст"), triggers({ command: false }), paid)).toBeNull();
    expect(chatTrigger(chat("опять слил"), settings, { random: always })).toEqual({
      source: "chat_keyword",
      inputText: "опять слил",
      target: "viewer"
    });
    expect(chatTrigger(chat("опять слил"), settings, { random: never })).toBeNull();
    expect(chatTrigger(chat("просто привет"), settings, { random: always })).toBeNull();
  });

  it("ignores bots and other commands", () => {
    const settings = triggers({ keywords: ["слил"], keywordChancePercent: 100 });
    const options = { commandAllowed: true, random: always };
    expect(chatTrigger(chat("слил", { username: "Nightbot" }), settings, options)).toBeNull();
    expect(chatTrigger(chat("!слил"), settings, options)).toBeNull();
  });

  it("answers the premium character's name like a keyword, only when the streamer turned it on", () => {
    const options = { random: always, characterName: "Мисс Кэт" };
    const on = triggers({ nameMention: true, keywordChancePercent: 50 });
    expect(chatTrigger(chat("мисс кэт, привет"), on, options)).toEqual({
      source: "chat_keyword",
      inputText: "мисс кэт, привет",
      target: "viewer"
    });
    expect(chatTrigger(chat("мисс кэт, привет"), on, { ...options, random: never })).toBeNull();
    expect(
      chatTrigger(chat("мисс кэт"), triggers({ keywordChancePercent: 50 }), options)
    ).toBeNull();
    expect(chatTrigger(chat("мисс кэт"), on, { random: always })).toBeNull();
  });

  it("ignores the channel's own list of bots and spammers, whatever the case", () => {
    const settings = triggers({
      keywords: ["слил"],
      keywordChancePercent: 100,
      ignoredUsers: ["my_bot"]
    });
    const options = { commandAllowed: true, random: always };
    expect(chatTrigger(chat("слил", { username: "My_Bot" }), settings, options)).toBeNull();
    expect(chatTrigger(chat("!роаст слил", { username: "my_bot" }), settings, options)).toBeNull();
    expect(chatTrigger(chat("слил"), settings, options)?.source).toBe("chat_keyword");
  });

  it("roasts the streamer for their own message: there is no other author", () => {
    const settings = triggers({ keywords: ["слил"], keywordChancePercent: 100 });
    const options = { commandAllowed: true, random: never };
    expect(chatTrigger(chat("опять слил", { isBroadcaster: true }), settings, options)).toEqual({
      source: "chat_keyword",
      inputText: "опять слил",
      target: "streamer"
    });
    expect(
      chatTrigger(chat("!роаст мой aim", { isBroadcaster: true }), settings, options)?.target
    ).toBe("streamer");
  });
});

describe("EventSub subscriptions", () => {
  const all = [
    "channel:read:redemptions",
    "bits:read",
    "channel:read:subscriptions",
    "moderator:read:followers",
    "channel:read:predictions",
    "channel:read:ads"
  ];
  const enabled = withEvents({
    cheer: { enabled: true, minBits: 100 },
    subscription: { enabled: true },
    giftSub: { enabled: true, minCount: 1 },
    raid: { enabled: true, minViewers: 5 },
    follow: { enabled: true, chancePercent: 20 },
    prediction: { enabled: true },
    adBreak: { enabled: true }
  });

  it("subscribes to every enabled event and the reward", () => {
    const specs = subscriptionSpecs(
      { twitchId: "42", triggers: { ...enabled, rewardId: "r1" } },
      all
    );
    expect(specs.map((spec) => spec.type)).toEqual([
      "channel.channel_points_custom_reward_redemption.add",
      "channel.cheer",
      "channel.subscribe",
      "channel.subscription.message",
      "channel.subscription.gift",
      "channel.raid",
      "channel.follow",
      "channel.prediction.end",
      "channel.ad_break.begin"
    ]);
    expect(specs.find((spec) => spec.type === "channel.follow")).toMatchObject({
      version: "2",
      condition: { broadcaster_user_id: "42", moderator_user_id: "42" }
    });
    expect(specs.find((spec) => spec.type === "channel.raid")?.condition).toEqual({
      to_broadcaster_user_id: "42"
    });
  });

  it("skips events whose scope the streamer has not granted, and disabled ones", () => {
    const specs = subscriptionSpecs({ twitchId: "42", triggers: enabled }, [
      "channel:read:redemptions"
    ]);
    // Raids need no scope, so they survive an old login.
    expect(specs.map((spec) => spec.type)).toEqual(["channel.raid"]);
    expect(subscriptionSpecs({ twitchId: "42", triggers: triggers() }, all)).toEqual([]);
  });
});

describe("events to roasts", () => {
  const settings = withEvents({
    cheer: { enabled: true, minBits: 100 },
    giftSub: { enabled: true, minCount: 5 },
    raid: { enabled: true, minViewers: 10 },
    follow: { enabled: true, chancePercent: 20 }
  });

  it("roasts cheers above the threshold, without the cheermotes", () => {
    expect(
      eventRoast(
        "channel.cheer",
        {
          user_login: "fan",
          user_id: "7",
          bits: 500,
          message: "Cheer500 вот тебе",
          is_anonymous: false
        },
        settings,
        "streamer"
      )
    ).toMatchObject({
      source: "cheer",
      viewerLogin: "fan",
      viewerId: "7",
      inputText: "вот тебе",
      eventSummary: "Зритель отправил 500 битсов",
      target: "viewer"
    });
    expect(eventRoast("channel.cheer", { user_login: "fan", bits: 50 }, settings, "s")).toBeNull();
    expect(
      eventRoast("channel.cheer", { bits: 500, is_anonymous: true, message: "" }, settings, "boss")
    ).toMatchObject({ viewerLogin: "boss", target: "streamer" });
  });

  it("handles subs, resubs and gifts without roasting each gift recipient", () => {
    expect(
      eventRoast("channel.subscribe", { user_login: "a", is_gift: true }, settings, "s")
    ).toBeNull();
    expect(
      eventRoast("channel.subscribe", { user_login: "a", is_gift: false }, settings, "s")
    ).toMatchObject({ source: "subscription", eventSummary: "Новая подписка на канал" });
    expect(
      eventRoast(
        "channel.subscription.message",
        { user_login: "a", cumulative_months: 12, message: { text: "год терплю" } },
        settings,
        "s"
      )
    ).toMatchObject({ inputText: "год терплю", eventSummary: "Продлил подписку: всего 12 мес." });
    expect(
      eventRoast("channel.subscription.gift", { user_login: "g", total: 3 }, settings, "s")
    ).toBeNull();
    expect(
      eventRoast("channel.subscription.gift", { user_login: "g", total: 10 }, settings, "s")
    ).toMatchObject({ source: "gift_sub", viewerLogin: "g", eventSummary: "Подарил 10 подписок" });
  });

  it("greets raiders above the threshold and rolls the follow chance", () => {
    expect(
      eventRoast(
        "channel.raid",
        { from_broadcaster_user_login: "other", from_broadcaster_user_id: "9", viewers: 40 },
        settings,
        "s"
      )
    ).toMatchObject({
      source: "raid",
      viewerLogin: "other",
      viewerId: "9",
      eventSummary: "Рейд с канала other: 40 зрителей"
    });
    expect(
      eventRoast("channel.raid", { from_broadcaster_user_login: "o", viewers: 3 }, settings, "s")
    ).toBeNull();
    expect(eventRoast("channel.follow", { user_login: "f" }, settings, "s", always)).toMatchObject({
      source: "follow"
    });
    expect(eventRoast("channel.follow", { user_login: "f" }, settings, "s", never)).toBeNull();
  });

  it("roasts the biggest loser of a resolved prediction, or the streamer", () => {
    const prediction = {
      status: "resolved",
      title: "Победит ли?",
      winning_outcome_id: "w",
      outcomes: [
        { id: "w", title: "Да", users: 3, top_predictors: [] },
        {
          id: "l",
          title: "Нет",
          users: 8,
          top_predictors: [
            { user_login: "small", user_id: "1", channel_points_used: 10 },
            { user_login: "big", user_id: "2", channel_points_used: 5000 }
          ]
        }
      ]
    };
    const viewerSide = withEvents({ prediction: { enabled: true } });
    expect(eventRoast("channel.prediction.end", prediction, viewerSide, "boss")).toMatchObject({
      viewerLogin: "big",
      target: "viewer",
      eventSummary: "Прогноз «Победит ли?» завершён: победил исход «Да», проиграли 8 зрителей"
    });
    const nobodyBet = {
      ...prediction,
      outcomes: prediction.outcomes.map((outcome) => ({ ...outcome, top_predictors: [] }))
    };
    expect(eventRoast("channel.prediction.end", nobodyBet, viewerSide, "boss")).toMatchObject({
      viewerLogin: "boss",
      target: "streamer"
    });
    expect(
      eventRoast(
        "channel.prediction.end",
        { ...prediction, status: "canceled" },
        viewerSide,
        "boss"
      )
    ).toBeNull();
  });

  it("roasts the streamer for an ad break and the viewer for a reward", () => {
    expect(
      eventRoast("channel.ad_break.begin", { duration_seconds: 90 }, settings, "boss")
    ).toMatchObject({
      source: "ad_break",
      viewerLogin: "boss",
      target: "streamer",
      eventSummary: "Стример запустил рекламу на 90 секунд"
    });
    const reward = { ...settings, rewardId: "r1" };
    expect(
      eventRoast(
        "channel.channel_points_custom_reward_redemption.add",
        { user_login: "v", reward: { id: "r1" }, user_input: "стример не умеет стрелять" },
        reward,
        "boss"
      )
    ).toMatchObject({ source: "reward", inputText: "стример не умеет стрелять", target: "viewer" });
    expect(
      eventRoast(
        "channel.channel_points_custom_reward_redemption.add",
        { user_login: "v", reward: { id: "other" } },
        reward,
        "boss"
      )
    ).toBeNull();
  });
});

describe("DonationAlerts", () => {
  const on = withEvents({ donation: { enabled: true, minAmount: 100 } });

  it("roasts donations above the threshold, anonymous ones at the streamer", () => {
    expect(
      donationRoast(
        {
          id: 1,
          username: "Щедрый",
          message: "на новую мышку",
          message_type: "text",
          amount: 500,
          currency: "RUB"
        },
        on,
        "boss"
      )
    ).toEqual({
      source: "donation",
      viewerLogin: "Щедрый",
      inputText: "на новую мышку",
      eventSummary: "Донат 500 RUB",
      target: "viewer"
    });
    expect(donationRoast({ username: "a", amount: 50, currency: "RUB" }, on, "boss")).toBeNull();
    expect(
      donationRoast({ username: "", amount: 300, currency: "RUB", message: "" }, on, "boss")
    ).toMatchObject({
      viewerLogin: "boss",
      target: "streamer",
      eventSummary: "Анонимный донат 300 RUB"
    });
    expect(
      donationRoast(
        {
          username: "a",
          amount: 300,
          currency: "RUB",
          message_type: "audio",
          message: "https://x/a.mp3"
        },
        on,
        "boss"
      )?.inputText
    ).toBe("");
    expect(donationRoast({ username: "a", amount: 900 }, triggers(), "boss")).toBeNull();
  });

  it("pulls donations out of Centrifugo frames for our channel only", () => {
    const push = (channel: string, id: number) =>
      JSON.stringify({ result: { channel, data: { seq: id, data: { id, amount: 100 } } } });
    const frame = [
      JSON.stringify({ id: 1, result: { client: "uuid" } }),
      push("$alerts:donation_7", 11),
      push("$alerts:donation_8", 12),
      "not json",
      push("$alerts:donation_7", 13)
    ].join("\n");
    expect(extractDonations(frame, "$alerts:donation_7").map((item) => item.id)).toEqual([11, 13]);
  });
});

describe("optOutCommand", () => {
  it("recognises the viewer's stop and start in either spelling", () => {
    expect(optOutCommand("!роаст-стоп")).toBe("stop");
    expect(optOutCommand("  !Roast-Stop пожалуйста")).toBe("stop");
    expect(optOutCommand("!роаст-старт")).toBe("start");
    expect(optOutCommand("!роаст стоп")).toBeNull();
    expect(optOutCommand("стоп")).toBeNull();
  });
});
