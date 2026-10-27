import { z } from "zod";

export const APP_NAME = "RoastBot";
export const DEFAULT_CHANNEL_MONTHLY_ROASTS = 10;
// `!роаст` is a paid feature: on the free plan the command is ignored.
export const COMMAND_PLANS: ReadonlySet<string> = new Set(["basic", "premium"]);
// Free channels advertise the service: the overlay shows its address under the roast card.
export const BRANDED_PLANS: ReadonlySet<string> = new Set(["free"]);
// Dashboard tests and the event simulator have their own daily allowance per channel (UTC day)
// and never spend the monthly quota: a streamer must be able to try the bot before going live.
export const DASHBOARD_TEST_DAILY_LIMIT = 5;
export const DEFAULT_CHANNEL_COOLDOWN_SECONDS = 60;
export const DEFAULT_USER_COOLDOWN_SECONDS = 120;
// Chat, rewards and follows cost money on every answer: a channel cannot set its pauses below
// these, whatever is stored (streamers set 0 and burned a month of quota in an hour).
export const PREMIUM_MIN_COOLDOWN_SECONDS = 40;
export const MIN_COOLDOWN_SECONDS = 60;
export const minCooldownSeconds = (planCode: string | null | undefined) =>
  planCode === "premium" ? PREMIUM_MIN_COOLDOWN_SECONDS : MIN_COOLDOWN_SECONDS;
/** The pause that applies: the stored one, never below the plan's minimum. */
export const effectiveCooldown = (seconds: number, planCode: string | null | undefined) =>
  Math.max(seconds, minCooldownSeconds(planCode));
// One viewer gets at most this many real answers to chat and rewards per window; past it they
// get stubs. Paid events never count and are never limited.
export const VIEWER_ROAST_LIMIT = 3;
export const VIEWER_ROAST_WINDOW_MINUTES = 30;
export const DEFAULT_GLOBAL_MONTHLY_ROAST_CAP = 4_000;
export const MAX_ROAST_CHARACTERS = 200;
export const OVERLAY_EVENT_TTL_SECONDS = 120;
export const AUDIO_URL_TTL_SECONDS = 60;
export const DEFAULT_MONTHLY_BUDGET_USD = 10;

// Yandex SpeechKit hard cap. API v3 `general` voices bill 0.1626 ₽ with VAT per request of up to
// 250 characters (pricing page, 2026-10); the cap converts roubles into a request count.
// ElevenLabs Starter includes 75,000 characters a month; stay under it so the plan never bills
// overage. The owner changes it in /admin.
export const DEFAULT_ELEVENLABS_MONTHLY_CHAR_LIMIT = 70_000;
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
// Sonnet writes the roast (it has to understand what the viewer meant) and checks the reply. Chat
// keywords are background chatter nobody paid for: Haiku answers them (global "chat_model").
export const DEFAULT_ANTHROPIC_MODEL = "claude-sonnet-5-5";
export const DEFAULT_CLASSIFIER_MODEL = "claude-sonnet-5-5";
export const DEFAULT_CHAT_MODEL = "claude-haiku-5-5";
// Plans with a premium allowance (free) write the rest of the month's roasts with this model and
// a simpler voice; the owner changes both per plan in /admin. The classifier never changes.
export const DEFAULT_ECONOMY_MODEL = "claude-haiku-5-5";
export const FREE_PREMIUM_ROASTS = 2;
export const BLOCKED_OUTPUT_FALLBACK = "Даже мне за такое стыдно";
// Twitch's "talking, no game" category says nothing about the stream: it is not passed on.
export const JUST_CHATTING = "Just Chatting";
/** The category worth telling the model, or undefined. */
export const gameContext = (name: string | null | undefined) => {
  const game = name?.trim().slice(0, 100);
  return game && game !== JUST_CHATTING ? game : undefined;
};
export const ROAST_REQUESTED_QUEUE = "roast.requested";
// A roast older than the overlay TTL is useless on stream, so jobs are never retried or kept long.
// notify=true wakes the worker through LISTEN/NOTIFY instead of its 2-second poll.
export const ROAST_REQUESTED_QUEUE_OPTIONS = Object.freeze({
  notify: true,
  retryLimit: 0,
  expireInSeconds: 60,
  retentionSeconds: OVERLAY_EVENT_TTL_SECONDS
});

// Landing demo: anyone may try Ai without logging in, a few times a day. The per-IP and service
// caps are checked by the API before a job is queued; the worker still checks the budget.
export const DEMO_REQUESTED_QUEUE = "demo.requested";
export const DEMO_REQUESTED_QUEUE_OPTIONS = Object.freeze({
  notify: true,
  retryLimit: 0,
  expireInSeconds: 60,
  retentionSeconds: 600
});
export const DEMO_PER_IP_DAILY = 3;
export const DEFAULT_DEMO_DAILY_LIMIT = 30;
export const DEMO_MAX_CHARACTERS = 200;
export const demoRequestSchema = z
  .object({ text: z.string().trim().min(1).max(DEMO_MAX_CHARACTERS) })
  .strict();
export const demoJobSchema = z.object({ demoId: z.string().uuid() }).strict();
export const demoStatusSchema = z.enum(["queued", "done", "blocked", "failed", "skipped"]);
export type DemoStatus = z.infer<typeof demoStatusSchema>;

export const toneSchema = z.enum(["tsundere", "yandere"]);

// ---- Premium characters ----------------------------------------------------------------------
// A premium channel builds its own heroine: a name, a temperament, an ElevenLabs voice and a
// picture. The owner approves the ones the author offers to the shop; then every premium channel
// may pick them. Built-in Mitsuki and Ai stay for everyone else and as the fallback.
export const archetypeSchema = z.enum(["tsundere", "yandere", "kuudere", "dandere", "himedere"]);
export const ARCHETYPE_TEXT = Object.freeze({
  tsundere: { title: "Цундэрэ", desc: "колюче, а потом выдаёт, что ей не всё равно" },
  yandere: { title: "Яндэрэ", desc: "мило, ласково и слегка пугающе" },
  kuudere: { title: "Кудэрэ", desc: "ледяное спокойствие, сухие приговоры без эмоций" },
  dandere: { title: "Дандэрэ", desc: "тихая и стеснительная, но колет точнее всех" },
  himedere: { title: "Химэдэрэ", desc: "надменная принцесса, чат — её подданные" }
} as const);
/** The overlay has two card themes; a custom character borrows the closer one. */
export const ARCHETYPE_THEME = Object.freeze({
  tsundere: "tsundere",
  yandere: "yandere",
  kuudere: "tsundere",
  dandere: "yandere",
  himedere: "tsundere"
} as const);
// Prerecorded answers to a viewer who called during a pause or past their limit: no model, no
// check, the audio is synthesized once per voice and kept in stub_audio.
export const STUB_PHRASES: Readonly<Record<z.infer<typeof archetypeSchema>, readonly string[]>> =
  Object.freeze({
    tsundere: [
      "Опять ты? Встань в очередь, я тут не только для тебя!",
      "Б-бака! Я не обязана отвечать тебе каждую минуту!",
      "Подожди, я ещё от прошлого раза не остыла."
    ],
    yandere: [
      "Терпение, милый… я никуда от тебя не денусь.",
      "Ты был у меня совсем недавно. Я всё помню.",
      "Подожди чуть-чуть. Ожидание делает нашу встречу слаще."
    ],
    kuudere: [
      "Очередь. Жди.",
      "Ты уже спрашивал. Ответ тот же: позже.",
      "Слишком часто. Неинтересно."
    ],
    dandere: [
      "П-подожди немного… я ещё не готова…",
      "Эм… можно чуть позже? Мне неловко так часто…",
      "Ой… опять ты… дай мне минутку, пожалуйста."
    ],
    himedere: [
      "Принцесса не принимает так часто. Жди аудиенции.",
      "Ты уже удостоился моего внимания. Знай меру.",
      "В очередь, простолюдин. Я занята."
    ]
  });
// A reward the frequency or a pause turned down.
export const REWARD_DECLINED_STUB = "Мммммм, нет!";
export const CUSTOM_CHARACTER_PLANS: ReadonlySet<string> = new Set(["premium"]);
// Pictures live in the database on a small server: a few own characters per channel, small files.
export const MAX_OWN_CHARACTERS = 3;
export const MAX_CHARACTER_UPLOAD_BYTES = 4 * 1024 * 1024;
export const MAX_CHARACTER_IMAGE_BYTES = 400 * 1024;
// Letters, spaces and hyphens: the name is said aloud and matched in chat.
export const characterNameSchema = z
  .string()
  .trim()
  .transform((name) => name.replace(/\s+/gu, " "))
  .pipe(z.string().regex(/^\p{L}[\p{L} -]{1,19}$/u, "Имя: 2–20 букв, можно пробел и дефис"));
export const characterStatusSchema = z.enum(["private", "pending", "published", "rejected"]);
export const elevenLabsVoiceIdSchema = z.string().regex(/^[A-Za-z0-9]{10,40}$/u);
export const characterInputSchema = z
  .object({
    name: characterNameSchema,
    archetype: archetypeSchema,
    voiceId: elevenLabsVoiceIdSchema.nullable().default(null)
  })
  .strict();
export const selectCharacterSchema = z
  .object({
    characterId: z.string().uuid().nullable(),
    // The name the character answers to on this channel; null keeps her own.
    characterName: characterNameSchema.nullable().default(null)
  })
  .strict();
// The worker records one sample per voice so streamers can hear it before choosing.
export const VOICE_SAMPLE_QUEUE = "voice.sample";
export const voiceSampleJobSchema = z.object({ voiceId: elevenLabsVoiceIdSchema }).strict();
export const VOICE_SAMPLE_TEXT =
  "Ну привет. Я буду отвечать твоему чату. Надеюсь, ты к этому готов.";
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
// Sources counted against VIEWER_ROAST_LIMIT.
export const VIEWER_LIMITED_SOURCES: ReadonlySet<RoastSource> = new Set<RoastSource>([
  "chat_command",
  "chat_keyword",
  "reward"
]);
// A viewer who called the bot directly and hit a pause or their limit hears a short prerecorded
// stub instead of silence, so nobody thinks the bot is down. Keywords stay silent: nobody called.
export const STUB_SOURCES: ReadonlySet<RoastSource> = new Set<RoastSource>([
  "chat_command",
  "reward"
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
/** Premium: the global model and the best voice. Economy: the plan's cheaper model and voice. */
export const roastTierSchema = z.enum(["premium", "economy"]);
export const voiceProviderSchema = z.enum(["elevenlabs", "yandex", "piper"]);
/** The best voice an economy roast may use; the next ones still take over on failure. */
export const economyVoiceSchema = z.enum(["yandex", "piper"]);
export const roastStatusSchema = z.enum([
  "queued",
  "blocked_input",
  "blocked_output",
  "done",
  "failed",
  "skipped"
]);

const percentSchema = z.number().int().min(0).max(100);

// DonationAlerts plays its own alert and reads the message aloud; the character answers after it.
// The pause covers the alert; reading time of the message is added on top (donationDelaySeconds).
export const DEFAULT_DONATION_DELAY_SECONDS = 8;
export const MAX_DONATION_DELAY_SECONDS = 60;
// Russian TTS reads roughly this many characters a second.
const DONATION_READ_CHARS_PER_SECOND = 14;
/** Seconds to hold the roast so the donation alert finishes first; within the overlay TTL. */
export const donationDelaySeconds = (message: string, pauseSec: number) =>
  Math.min(
    MAX_DONATION_DELAY_SECONDS,
    Math.max(0, pauseSec) +
      Math.ceil(Array.from(message.trim()).length / DONATION_READ_CHARS_PER_SECOND)
  );

export const DEFAULT_EVENT_TRIGGERS = Object.freeze({
  cheer: { enabled: false, minBits: 100 },
  subscription: { enabled: false },
  giftSub: { enabled: false, minCount: 1 },
  raid: { enabled: false, minViewers: 5 },
  follow: { enabled: false, chancePercent: 20 },
  prediction: { enabled: false },
  adBreak: { enabled: false },
  donation: { enabled: false, minAmount: 100, delaySec: DEFAULT_DONATION_DELAY_SECONDS }
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
        minAmount: z.number().min(0).max(10_000_000).default(100),
        delaySec: z
          .number()
          .int()
          .min(0)
          .max(MAX_DONATION_DELAY_SECONDS)
          .default(DEFAULT_DONATION_DELAY_SECONDS)
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
const LEGACY_TRIGGER_KEYS = [
  "rewardMode",
  "streamerLoyaltyPercent",
  "streamerTargetPercent",
  // A percentage chance; chatFrequency replaced it.
  "keywordChancePercent"
];
function dropLegacyTriggers(value: unknown): unknown {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return value;
  const row = { ...(value as Record<string, unknown>) };
  for (const key of LEGACY_TRIGGER_KEYS) delete row[key];
  return row;
}

// How often the character answers chat words and rewards. Chat: every Nth message with a trigger
// word; rewards: every Nth redemption, the others hear REWARD_DECLINED_STUB.
export const chatFrequencySchema = z.enum(["rare", "normal", "often"]);
export type ChatFrequency = z.infer<typeof chatFrequencySchema>;
export const KEYWORD_EVERY: Readonly<Record<ChatFrequency, number>> = {
  rare: 12,
  normal: 9,
  often: 6
};
export const REWARD_EVERY: Readonly<Record<ChatFrequency, number>> = {
  rare: 3,
  normal: 2,
  often: 1
};

export const DEFAULT_COMMAND = "!роаст";
// Commands of popular chat bots: a roast command must not answer them too.
export const RESERVED_COMMANDS: ReadonlySet<string> = new Set([
  "!song",
  "!sr",
  "!uptime",
  "!followage",
  "!commands",
  "!discord",
  "!points",
  "!top",
  "!help",
  "!роаст-стоп",
  "!роаст-старт",
  "!roast-stop",
  "!roast-start"
]);
export const commandSchema = z
  .string()
  .trim()
  .transform((command) => command.toLocaleLowerCase("ru-RU"))
  .pipe(
    z
      .string()
      .regex(/^![\p{L}\p{N}_-]{2,20}$/u)
      .refine((command) => !RESERVED_COMMANDS.has(command), "reserved_command")
  );

export const MAX_IGNORED_USERS = 100;
// Twitch logins are 1–25 letters, digits and "_"; "@nick" and any case are accepted and stored
// lowercase.
const twitchLoginSchema = z
  .string()
  .trim()
  .transform((login) => login.replace(/^@/u, "").toLowerCase())
  .pipe(z.string().regex(/^[a-z0-9_]{1,25}$/u));

const triggerSettingsObject = z
  .object({
    command: z.boolean().default(true),
    commandName: commandSchema.default(DEFAULT_COMMAND),
    rewardId: z.string().min(1).nullable().default(null),
    // Chat messages containing one of these words (word start, any case) may trigger a roast.
    keywords: z.array(z.string().trim().min(1).max(40)).max(50).default([]),
    chatFrequency: chatFrequencySchema.default("normal"),
    // Premium character: a chat message with her name triggers a roast like a keyword.
    nameMention: z.boolean().default(false),
    // The streamer's own chat bots and spammers: their messages never trigger a roast.
    ignoredUsers: z.array(twitchLoginSchema).max(MAX_IGNORED_USERS).default([]),
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
    // The channel's current Twitch category, for context; never "Just Chatting" (see JUST_CHATTING).
    game: z.string().min(1).max(100).optional(),
    // A reward the frequency passed over: the character answers with REWARD_DECLINED_STUB.
    declined: z.literal(true).optional(),
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

// What the dashboard simulator pretends happened. "plain" is the classic test message.
export const simulatedEventSchema = z.enum([
  "plain",
  "reward",
  "keyword",
  "donation",
  "raid",
  "prediction",
  "cheer",
  "subscription",
  "follow"
]);

export const testRoastRequestSchema = z
  .object({
    inputText: z.string().trim().max(2_000).default(""),
    viewerLogin: z.string().trim().min(1).max(64).default("test_viewer"),
    kind: simulatedEventSchema.default("plain"),
    // Donation sum, raid viewers, bits or prediction losers, depending on the kind.
    amount: z.number().int().min(0).max(1_000_000).optional()
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
    // A premium character: her name and picture instead of the built-in one; tone is the theme.
    character: z
      .object({ name: z.string().min(1).max(20), imageUrl: z.string().url() })
      .strict()
      .optional(),
    // Channel-points verdict, shown as a badge next to the text.
    verdict: verdictSchema.optional(),
    // Free plan: the overlay shows the service address under the card.
    branding: z.boolean().optional(),
    audioUrl: z.string().url(),
    expiresAt: z.string().datetime(),
    sentAt: z.string().datetime()
  })
  .strict();

// Outbox payload persisted by the worker. The API swaps audioFile for a freshly signed audioUrl
// at delivery time, so the 60-second URL lifetime starts when the overlay actually receives it.
export const storedOverlayRoastSchema = overlayRoastEventSchema
  .omit({ audioUrl: true, character: true })
  .extend({
    audioFile: z.string().regex(/^[0-9a-f-]{36}\.wav$/u),
    // The API turns the path into a URL at delivery time, like the audio.
    character: z
      .object({
        name: z.string().min(1).max(20),
        imagePath: z.string().regex(/^\/characters\/[0-9a-f-]{36}\/image\?v=[0-9a-f]{16}$/u)
      })
      .strict()
      .optional()
  })
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
export type Archetype = z.infer<typeof archetypeSchema>;
export type CharacterStatus = z.infer<typeof characterStatusSchema>;
export type CharacterInput = z.infer<typeof characterInputSchema>;
export type Voice = z.infer<typeof voiceSchema>;
export type Toxicity = z.infer<typeof toxicitySchema>;
export type RoastSource = z.infer<typeof roastSourceSchema>;
export type RoastStatus = z.infer<typeof roastStatusSchema>;
export type TriggerSettings = z.infer<typeof triggerSettingsSchema>;
export type EventTriggers = z.infer<typeof eventTriggersSchema>;
export type RoastTarget = z.infer<typeof roastTargetSchema>;
export type Verdict = z.infer<typeof verdictSchema>;
export type RoastTier = z.infer<typeof roastTierSchema>;
export type VoiceProvider = z.infer<typeof voiceProviderSchema>;
export type EconomyVoice = z.infer<typeof economyVoiceSchema>;
export type SimulatedEvent = z.infer<typeof simulatedEventSchema>;
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

// ---- growth and payments ----------------------------------------------------------------------

// Viewers may ask the bot to leave them alone: chat triggers from them are skipped, paid events
// still play but roast the streamer. "!роаст-старт" undoes it.
export const OPTOUT_SKIPPED_SOURCES: ReadonlySet<RoastSource> = new Set<RoastSource>([
  "chat_command",
  "chat_keyword",
  "follow"
]);

// Notifications to the streamer's Telegram: sent by the worker, queued by other services.
export const TELEGRAM_NOTIFY_QUEUE = "telegram.notify";
export const telegramNotifyJobSchema = z
  .object({
    channelId: z.string().uuid(),
    // Sent once per kind and period: "eventsub:channel.cheer" + "2026-10-26".
    kind: z.string().min(1).max(100),
    period: z.string().min(1).max(20),
    text: z.string().min(1).max(1_000)
  })
  .strict();
export type TelegramNotifyJob = z.infer<typeof telegramNotifyJobSchema>;

// Telegram Stars subscriptions renew every 30 days; it is the only period Telegram allows.
export const STARS_SUBSCRIPTION_SECONDS = 2_592_000;
/** Invoice payload: which channel buys which plan. Telegram returns it on payment. */
export const starsPayload = (channelId: string, plan: string) => `rb1:${channelId}:${plan}`;
export function parseStarsPayload(payload: string): { channelId: string; plan: string } | null {
  const match = /^rb1:([0-9a-f-]{36}):(basic|premium)$/u.exec(payload);
  return match ? { channelId: match[1]!, plan: match[2]! } : null;
}

/** One Telegram Bot API call; throws with Telegram's description when it says no. */
export async function telegramCall<T>(
  token: string,
  method: string,
  body: Record<string, unknown>,
  fetcher: typeof globalThis.fetch = globalThis.fetch
): Promise<T> {
  const response = await fetcher(`https://api.telegram.org/bot${token}/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(5_000)
  });
  const result = (await response.json().catch(() => ({}))) as {
    ok?: boolean;
    result?: T;
    description?: string;
  };
  if (!result.ok) throw new Error(`telegram_${method}: ${result.description ?? response.status}`);
  return result.result as T;
}
