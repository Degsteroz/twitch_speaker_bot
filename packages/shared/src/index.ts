import { z } from "zod";

export const APP_NAME = "RoastBot";
export const DEFAULT_CHANNEL_MONTHLY_ROASTS = 10;
// `!роаст` is a paid feature: on the free plan the command is ignored.
export const COMMAND_PLANS: ReadonlySet<string> = new Set(["basic", "premium"]);
export const DEFAULT_CHANNEL_COOLDOWN_SECONDS = 30;
export const DEFAULT_USER_COOLDOWN_SECONDS = 60;
export const DEFAULT_GLOBAL_MONTHLY_ROAST_CAP = 4_000;
export const MAX_ROAST_CHARACTERS = 200;
export const OVERLAY_EVENT_TTL_SECONDS = 120;
export const AUDIO_URL_TTL_SECONDS = 60;
export const DEFAULT_MONTHLY_BUDGET_USD = 5;

// Yandex SpeechKit hard cap. API v3 `general` voices bill 0.1626 ₽ with VAT per request of up to
// 250 characters (pricing page, 2026-10); the cap converts roubles into a request count.
export const DEFAULT_YANDEX_TTS_MONTHLY_LIMIT_RUB = 300;
export const YANDEX_TTS_RUB_PER_REQUEST = 0.1626;
export const YANDEX_TTS_CHARS_PER_REQUEST = 250;
export const yandexTtsRequestLimit = (limitRub: number) =>
  Math.max(0, Math.floor(limitRub / YANDEX_TTS_RUB_PER_REQUEST));
export const yandexTtsRequestsFor = (text: string) =>
  Math.max(1, Math.ceil(Array.from(text).length / YANDEX_TTS_CHARS_PER_REQUEST));
/** Yandex Cloud bills by calendar month in Moscow time; the cap resets on the same boundary. */
export const yandexBillingMonth = (date: Date) =>
  new Intl.DateTimeFormat("sv-SE", { timeZone: "Europe/Moscow", year: "numeric", month: "2-digit" })
    .format(date)
    .slice(0, 7);
export const DEFAULT_ANTHROPIC_MODEL = "claude-haiku-5-5";
export const BLOCKED_OUTPUT_FALLBACK = "Даже мне за такое стыдно";
export const ROAST_REQUESTED_QUEUE = "roast.requested";
// A roast older than the overlay TTL is useless on stream, so jobs are never retried or kept long.
// notify=true wakes the worker through LISTEN/NOTIFY instead of its 2-second poll.
export const ROAST_REQUESTED_QUEUE_OPTIONS = Object.freeze({
  notify: true,
  retryLimit: 0,
  expireInSeconds: 60,
  retentionSeconds: OVERLAY_EVENT_TTL_SECONDS
});

export const toneSchema = z.enum(["tsundere", "yandere"]);
export const voiceSchema = z.enum(["male", "female"]);
export const toxicitySchema = z.union([
  z.literal(1),
  z.literal(2),
  z.literal(3),
  z.literal(4),
  z.literal(5)
]);
export const roastSourceSchema = z.enum([
  "chat_command",
  "chat_keyword",
  "reward",
  "dashboard_test",
  "cheer",
  "subscription",
  "gift_sub",
  "raid",
  "follow",
  "prediction",
  "ad_break",
  "donation"
]);
// Sources where chat could flood the bot: they obey channel and viewer cooldowns. Paid or rare
// events (bits, subs, raids, ads, predictions, donations) always play, within the quota.
export const COOLDOWN_SOURCES: ReadonlySet<RoastSource> = new Set<RoastSource>([
  "chat_command",
  "chat_keyword",
  "reward",
  "follow"
]);
/** Who the roast is aimed at: the viewer behind the trigger or the streamer. */
/** The two characters by name; the tone is their temperament. */
export const CHARACTER_NAMES = Object.freeze({ tsundere: "Мицуки", yandere: "Аи" } as const);
export const roastTargetSchema = z.enum(["viewer", "streamer"]);
/** The bot's stance on a channel-points message: agree with it, half-agree, or push back. */
export const verdictSchema = z.enum(["agree", "mixed", "refuse"]);

// Twitch scopes requested at login. Every EventSub trigger needs its own; a channel that logged
// in before a scope was added is asked to log in again.
export const TWITCH_SCOPES = Object.freeze([
  "channel:read:redemptions",
  "bits:read",
  "channel:read:subscriptions",
  "moderator:read:followers",
  "channel:read:predictions",
  "channel:read:ads"
] as const);
export const roastStatusSchema = z.enum([
  "queued",
  "blocked_input",
  "blocked_output",
  "done",
  "failed",
  "skipped"
]);

const percentSchema = z.number().int().min(0).max(100);

export const DEFAULT_EVENT_TRIGGERS = Object.freeze({
  cheer: { enabled: false, minBits: 100 },
  subscription: { enabled: false },
  giftSub: { enabled: false, minCount: 1 },
  raid: { enabled: false, minViewers: 5 },
  follow: { enabled: false, chancePercent: 20 },
  prediction: { enabled: false },
  adBreak: { enabled: false },
  donation: { enabled: false, minAmount: 100 }
});

const toggle = z.object({ enabled: z.boolean().default(false) }).strict();
export const eventTriggersSchema = z
  .object({
    cheer: z
      .object({
        enabled: z.boolean().default(false),
        minBits: z.number().int().min(1).max(1_000_000).default(100)
      })
      .strict()
      .default({ ...DEFAULT_EVENT_TRIGGERS.cheer }),
    subscription: toggle.default({ ...DEFAULT_EVENT_TRIGGERS.subscription }),
    giftSub: z
      .object({
        enabled: z.boolean().default(false),
        minCount: z.number().int().min(1).max(1_000).default(1)
      })
      .strict()
      .default({ ...DEFAULT_EVENT_TRIGGERS.giftSub }),
    raid: z
      .object({
        enabled: z.boolean().default(false),
        minViewers: z.number().int().min(0).max(1_000_000).default(5)
      })
      .strict()
      .default({ ...DEFAULT_EVENT_TRIGGERS.raid }),
    follow: z
      .object({ enabled: z.boolean().default(false), chancePercent: percentSchema.default(20) })
      .strict()
      .default({ ...DEFAULT_EVENT_TRIGGERS.follow }),
    prediction: toggle.default({ ...DEFAULT_EVENT_TRIGGERS.prediction }),
    adBreak: toggle.default({ ...DEFAULT_EVENT_TRIGGERS.adBreak }),
    // DonationAlerts; the threshold is in the donation's own currency.
    donation: z
      .object({
        enabled: z.boolean().default(false),
        minAmount: z.number().min(0).max(10_000_000).default(100)
      })
      .strict()
      .default({ ...DEFAULT_EVENT_TRIGGERS.donation })
  })
  .strict();

// DonationAlerts OAuth: profile for the user id, and the real-time donation channel.
export const DONATIONALERTS_SCOPES = Object.freeze([
  "oauth-user-show",
  "oauth-donation-subscribe"
] as const);

// Who gets roasted, for every trigger: the author (viewer, donor, raider…), the streamer, or the
// character decides from what the message and the event say.
export const targetModeSchema = z.enum(["author", "streamer", "auto"]);

// Fields of older settings rows; the target switch replaced all three.
const LEGACY_TRIGGER_KEYS = ["rewardMode", "streamerLoyaltyPercent", "streamerTargetPercent"];
function dropLegacyTriggers(value: unknown): unknown {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return value;
  const row = { ...(value as Record<string, unknown>) };
  for (const key of LEGACY_TRIGGER_KEYS) delete row[key];
  return row;
}

const triggerSettingsObject = z
  .object({
    command: z.boolean().default(true),
    rewardId: z.string().min(1).nullable().default(null),
    // Chat messages containing one of these words (word start, any case) may trigger a roast.
    keywords: z.array(z.string().trim().min(1).max(40)).max(50).default([]),
    keywordChancePercent: percentSchema.default(25),
    targetMode: targetModeSchema.default("auto"),
    events: eventTriggersSchema.default(eventTriggersSchema.parse({}))
  })
  .strict();

export const triggerSettingsSchema = z.preprocess(dropLegacyTriggers, triggerSettingsObject);

export const DEFAULT_TRIGGERS = triggerSettingsSchema.parse({});

export const channelSettingsSchema = z
  .object({
    tone: toneSchema.default("tsundere"),
    voice: voiceSchema.default("female"),
    toxicity: toxicitySchema.default(2),
    cooldownSec: z.number().int().min(0).max(3_600).default(DEFAULT_CHANNEL_COOLDOWN_SECONDS),
    userCooldownSec: z.number().int().min(0).max(86_400).default(DEFAULT_USER_COOLDOWN_SECONDS),
    triggers: triggerSettingsSchema.default(DEFAULT_TRIGGERS),
    stopWords: z.array(z.string().trim().min(1).max(100)).max(500).default([]),
    enabled: z.boolean().default(true)
  })
  .strict();

export const roastRequestedJobSchema = z
  .object({
    jobVersion: z.literal(1),
    eventId: z.string().uuid(),
    channelId: z.string().uuid(),
    source: roastSourceSchema,
    viewerId: z.string().min(1).max(128).optional(),
    viewerLogin: z.string().min(1).max(64),
    inputText: z.string().max(2_000),
    // "streamer" when there is no author to roast (anonymous gift, ad break, the streamer's own
    // message); otherwise "viewer", and the channel's targetMode decides in the worker.
    target: roastTargetSchema.default("viewer"),
    // What happened, in our own words ("Рейд с канала x: 40 зрителей"); viewer text stays in
    // inputText. Built by the twitch service from typed event fields.
    eventSummary: z.string().max(500).optional(),
    requestedAt: z.string().datetime()
  })
  .strict();

export const roastCompletedJobSchema = z
  .object({
    jobVersion: z.literal(1),
    roastId: z.string().uuid(),
    channelId: z.string().uuid(),
    status: roastStatusSchema,
    completedAt: z.string().datetime()
  })
  .strict();

export const apiErrorSchema = z
  .object({
    code: z.string().min(1),
    message: z.string().min(1),
    requestId: z.string().optional(),
    details: z.record(z.string(), z.unknown()).optional()
  })
  .strict();

export const apiErrorResponseSchema = z.object({ error: apiErrorSchema }).strict();

export const settingsResponseSchema = z
  .object({
    channelId: z.string().uuid(),
    settings: channelSettingsSchema,
    updatedAt: z.string().datetime()
  })
  .strict();

export const updateSettingsRequestSchema = channelSettingsSchema.partial().strict();

export const quotaResponseSchema = z
  .object({
    month: z.string().regex(/^\d{4}-\d{2}$/u),
    used: z.number().int().nonnegative(),
    limit: z.number().int().nonnegative(),
    gifted: z.number().int().nonnegative(),
    remaining: z.number().int().nonnegative(),
    globalLimitReached: z.boolean()
  })
  .strict();

export const testRoastRequestSchema = z
  .object({
    inputText: z.string().trim().max(2_000).default(""),
    viewerLogin: z.string().trim().min(1).max(64).default("test_viewer")
  })
  .strict();

export const testRoastResponseSchema = z
  .object({
    roastId: z.string().uuid(),
    status: z.literal("queued")
  })
  .strict();

export const overlayReadyEventSchema = z
  .object({
    version: z.literal(1),
    type: z.literal("overlay.ready"),
    eventId: z.string().uuid(),
    sentAt: z.string().datetime()
  })
  .strict();

export const overlayRoastEventSchema = z
  .object({
    version: z.literal(1),
    type: z.literal("roast.play"),
    eventId: z.string().uuid(),
    roastId: z.string().uuid(),
    viewerLogin: z.string().min(1).max(64),
    text: z.string().min(1).max(MAX_ROAST_CHARACTERS),
    // Picks the character shown next to the text. Optional: outbox rows written before it existed
    // still validate and play without a character.
    tone: toneSchema.optional(),
    // Channel-points verdict, shown as a badge next to the text.
    verdict: verdictSchema.optional(),
    audioUrl: z.string().url(),
    expiresAt: z.string().datetime(),
    sentAt: z.string().datetime()
  })
  .strict();

// Outbox payload persisted by the worker. The API swaps audioFile for a freshly signed audioUrl
// at delivery time, so the 60-second URL lifetime starts when the overlay actually receives it.
export const storedOverlayRoastSchema = overlayRoastEventSchema
  .omit({ audioUrl: true })
  .extend({ audioFile: z.string().regex(/^[0-9a-f-]{36}\.wav$/u) })
  .strict();

export const overlayPingEventSchema = z
  .object({
    version: z.literal(1),
    type: z.literal("overlay.ping"),
    eventId: z.string().uuid(),
    sentAt: z.string().datetime()
  })
  .strict();

export const overlayServerEventSchema = z.discriminatedUnion("type", [
  overlayReadyEventSchema,
  overlayRoastEventSchema,
  overlayPingEventSchema
]);

export const overlayClientEventSchema = z.discriminatedUnion("type", [
  z
    .object({
      version: z.literal(1),
      type: z.literal("overlay.ack"),
      eventId: z.string().uuid(),
      receivedAt: z.string().datetime()
    })
    .strict(),
  z
    .object({
      version: z.literal(1),
      type: z.literal("overlay.pong"),
      eventId: z.string().uuid(),
      sentAt: z.string().datetime()
    })
    .strict()
]);

export type Tone = z.infer<typeof toneSchema>;
export type Voice = z.infer<typeof voiceSchema>;
export type Toxicity = z.infer<typeof toxicitySchema>;
export type RoastSource = z.infer<typeof roastSourceSchema>;
export type RoastStatus = z.infer<typeof roastStatusSchema>;
export type TriggerSettings = z.infer<typeof triggerSettingsSchema>;
export type EventTriggers = z.infer<typeof eventTriggersSchema>;
export type RoastTarget = z.infer<typeof roastTargetSchema>;
export type Verdict = z.infer<typeof verdictSchema>;
export type TargetMode = z.infer<typeof targetModeSchema>;
export type ChannelSettings = z.infer<typeof channelSettingsSchema>;
export type RoastRequestedJob = z.infer<typeof roastRequestedJobSchema>;
export type RoastCompletedJob = z.infer<typeof roastCompletedJobSchema>;
export type ApiError = z.infer<typeof apiErrorSchema>;
export type SettingsResponse = z.infer<typeof settingsResponseSchema>;
export type UpdateSettingsRequest = z.infer<typeof updateSettingsRequestSchema>;
export type QuotaResponse = z.infer<typeof quotaResponseSchema>;
export type StoredOverlayRoast = z.infer<typeof storedOverlayRoastSchema>;
export type OverlayServerEvent = z.infer<typeof overlayServerEventSchema>;
export type OverlayClientEvent = z.infer<typeof overlayClientEventSchema>;
