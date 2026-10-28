import type { StoredOverlayRoast, TriggerSettings } from "@roastbot/shared";
import { relations, sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  check,
  char,
  customType,
  date,
  index,
  integer,
  jsonb,
  numeric,
  pgEnum,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid
} from "drizzle-orm/pg-core";

const bytea = customType<{ data: Buffer }>({ dataType: () => "bytea" });

const createdAt = () => timestamp("created_at", { withTimezone: true }).notNull().defaultNow();

export const userRoleEnum = pgEnum("user_role", ["owner", "user"]);
export const userStatusEnum = pgEnum("user_status", ["active", "suspended", "pending"]);
// The built-in characters' temperaments plus the archetypes a premium character may have.
export const toneEnum = pgEnum("tone", ["tsundere", "yandere", "kuudere", "dandere", "himedere"]);
export const voiceEnum = pgEnum("voice", ["male", "female"]);
export const planCodeEnum = pgEnum("plan_code", ["free", "basic", "premium"]);
export const subscriptionSourceEnum = pgEnum("subscription_source", [
  "manual",
  "invite",
  "telegram_stars"
]);
export const eventTypeEnum = pgEnum("event_type", [
  "chat_command",
  "reward",
  "dashboard_test",
  "chat_keyword",
  "cheer",
  "subscription",
  "gift_sub",
  "raid",
  "follow",
  "prediction",
  "ad_break",
  "donation"
]);
export const roastStatusEnum = pgEnum("roast_status", [
  "queued",
  "blocked_input",
  "blocked_output",
  "done",
  "failed",
  "skipped"
]);
export const cooldownScopeEnum = pgEnum("cooldown_scope", ["channel", "viewer"]);
export const overlayEventStatusEnum = pgEnum("overlay_event_status", [
  "pending",
  "delivered",
  "expired"
]);

export const users = pgTable(
  "users",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    twitchId: text("twitch_id").notNull(),
    login: text("login").notNull(),
    displayName: text("display_name").notNull(),
    role: userRoleEnum("role").notNull().default("user"),
    status: userStatusEnum("status").notNull().default("active"),
    totpSecretCiphertext: text("totp_secret_ciphertext"),
    totpSecretIv: text("totp_secret_iv"),
    totpSecretTag: text("totp_secret_tag"),
    totpEnabledAt: timestamp("totp_enabled_at", { withTimezone: true }),
    totpLastStep: bigint("totp_last_step", { mode: "number" }),
    mfaRecoveryHashes: text("mfa_recovery_hashes")
      .array()
      .notNull()
      .default(sql`ARRAY[]::text[]`),
    mfaFailedAttempts: integer("mfa_failed_attempts").notNull().default(0),
    mfaLockedUntil: timestamp("mfa_locked_until", { withTimezone: true }),
    createdAt: createdAt()
  },
  (table) => [
    uniqueIndex("users_twitch_id_uidx").on(table.twitchId),
    index("users_login_idx").on(table.login),
    index("users_status_idx").on(table.status)
  ]
);

export const channels = pgTable(
  "channels",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    twitchLogin: text("twitch_login").notNull(),
    overlayToken: text("overlay_token").notNull(),
    createdAt: createdAt()
  },
  (table) => [
    uniqueIndex("channels_overlay_token_uidx").on(table.overlayToken),
    uniqueIndex("channels_user_id_uidx").on(table.userId),
    index("channels_twitch_login_idx").on(table.twitchLogin)
  ]
);

export const settings = pgTable(
  "settings",
  {
    channelId: uuid("channel_id")
      .primaryKey()
      .references(() => channels.id, { onDelete: "cascade" }),
    tone: toneEnum("tone").notNull().default("tsundere"),
    voice: voiceEnum("voice").notNull().default("female"),
    toxicity: integer("toxicity").notNull().default(2),
    cooldownSec: integer("cooldown_sec").notNull().default(30),
    userCooldownSec: integer("user_cooldown_sec").notNull().default(60),
    // The column default predates most trigger fields; readers parse the value with
    // triggerSettingsSchema, which fills in everything missing.
    triggers: jsonb("triggers")
      .$type<TriggerSettings>()
      .notNull()
      .default(sql`'{"command": true, "rewardId": null}'::jsonb`),
    stopWords: text("stop_words")
      .array()
      .notNull()
      .default(sql`ARRAY[]::text[]`),
    enabled: boolean("enabled").notNull().default(true),
    // Premium: the channel's own or a shop character, and the name it answers to here.
    characterId: uuid("character_id").references(() => characters.id, { onDelete: "set null" }),
    characterName: text("character_name"),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow()
  },
  (table) => [
    check("settings_toxicity_check", sql`${table.toxicity} between 1 and 6`),
    check("settings_cooldown_sec_check", sql`${table.cooldownSec} between 0 and 3600`),
    check("settings_user_cooldown_sec_check", sql`${table.userCooldownSec} between 0 and 86400`)
  ]
);

export const plans = pgTable(
  "plans",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    code: planCodeEnum("code").notNull(),
    monthlyRoastLimit: integer("monthly_roast_limit").notNull(),
    monthlyTtsLimit: integer("monthly_tts_limit").notNull(),
    // Roasts a month on the global model and the best voice; null means all of them.
    premiumRoasts: integer("premium_roasts"),
    economyModel: text("economy_model").notNull().default("claude-haiku-5-5"),
    economyVoice: text("economy_voice").notNull().default("yandex"),
    // Telegram Stars price of 30 days; null means the plan is not for sale.
    starsPrice: integer("stars_price"),
    createdAt: createdAt()
  },
  (table) => [
    uniqueIndex("plans_code_uidx").on(table.code),
    check("plans_roast_limit_check", sql`${table.monthlyRoastLimit} >= 0`),
    check("plans_tts_limit_check", sql`${table.monthlyTtsLimit} >= 0`),
    check(
      "plans_premium_roasts_check",
      sql`${table.premiumRoasts} is null or ${table.premiumRoasts} >= 0`
    ),
    check("plans_economy_voice_check", sql`${table.economyVoice} in ('yandex', 'piper')`),
    check(
      "plans_stars_price_check",
      sql`${table.starsPrice} is null or ${table.starsPrice} between 1 and 10000`
    )
  ]
);

export const subscriptions = pgTable(
  "subscriptions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    planId: uuid("plan_id")
      .notNull()
      .references(() => plans.id),
    validUntil: timestamp("valid_until", { withTimezone: true }),
    source: subscriptionSourceEnum("source").notNull().default("manual"),
    createdAt: createdAt()
  },
  (table) => [
    index("subscriptions_user_valid_idx").on(table.userId, table.validUntil),
    index("subscriptions_plan_id_idx").on(table.planId)
  ]
);

export const twitchTokens = pgTable("twitch_tokens", {
  channelId: uuid("channel_id")
    .primaryKey()
    .references(() => channels.id, { onDelete: "cascade" }),
  accessTokenCiphertext: text("access_token_ciphertext").notNull(),
  refreshTokenCiphertext: text("refresh_token_ciphertext").notNull(),
  accessTokenIv: text("access_token_iv").notNull(),
  accessTokenTag: text("access_token_tag").notNull(),
  refreshTokenIv: text("refresh_token_iv").notNull(),
  refreshTokenTag: text("refresh_token_tag").notNull(),
  scopes: text("scopes")
    .array()
    .notNull()
    .default(sql`ARRAY[]::text[]`),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow()
});

export const donationAlertsAccounts = pgTable("donationalerts_accounts", {
  channelId: uuid("channel_id")
    .primaryKey()
    .references(() => channels.id, { onDelete: "cascade" }),
  daUserId: text("da_user_id").notNull(),
  daName: text("da_name").notNull(),
  accessTokenCiphertext: text("access_token_ciphertext").notNull(),
  accessTokenIv: text("access_token_iv").notNull(),
  accessTokenTag: text("access_token_tag").notNull(),
  refreshTokenCiphertext: text("refresh_token_ciphertext").notNull(),
  refreshTokenIv: text("refresh_token_iv").notNull(),
  refreshTokenTag: text("refresh_token_tag").notNull(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  connectedAt: timestamp("connected_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow()
});

// Twitch's answer to each EventSub subscription ("ok" or the error), shown in the panel.
export const eventSubState = pgTable("eventsub_state", {
  channelId: uuid("channel_id")
    .primaryKey()
    .references(() => channels.id, { onDelete: "cascade" }),
  connected: boolean("connected").notNull().default(false),
  subscriptions: jsonb("subscriptions").$type<Record<string, string>>().notNull().default({}),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow()
});

export const events = pgTable(
  "events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    channelId: uuid("channel_id")
      .notNull()
      .references(() => channels.id, { onDelete: "cascade" }),
    type: eventTypeEnum("type").notNull(),
    providerEventId: text("provider_event_id"),
    raw: jsonb("raw").$type<Record<string, unknown>>().notNull(),
    receivedAt: timestamp("received_at", { withTimezone: true }).notNull().defaultNow()
  },
  (table) => [
    index("events_channel_received_idx").on(table.channelId, table.receivedAt),
    uniqueIndex("events_provider_event_uidx")
      .on(table.channelId, table.providerEventId)
      .where(sql`${table.providerEventId} is not null`)
  ]
);

export const roasts = pgTable(
  "roasts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    channelId: uuid("channel_id")
      .notNull()
      .references(() => channels.id, { onDelete: "cascade" }),
    eventId: uuid("event_id")
      .notNull()
      .references(() => events.id, { onDelete: "restrict" }),
    source: eventTypeEnum("source").notNull(),
    viewerLogin: text("viewer_login"),
    inputText: text("input_text"),
    outputText: text("output_text"),
    status: roastStatusEnum("status").notNull().default("queued"),
    tone: toneEnum("tone").notNull(),
    voice: voiceEnum("voice").notNull(),
    toxicity: integer("toxicity").notNull(),
    tokensIn: integer("tokens_in").notNull().default(0),
    tokensOut: integer("tokens_out").notNull().default(0),
    ttsChars: integer("tts_chars").notNull().default(0),
    costUsd: numeric("cost_usd", { precision: 10, scale: 6 }).notNull().default("0"),
    latencyMs: integer("latency_ms"),
    error: text("error"),
    // Channel-points verdict; null for plain roasts.
    verdict: text("verdict"),
    // What the roast used: premium or economy tier, the generating model, the voice that spoke.
    tier: text("tier"),
    model: text("model"),
    voiceProvider: text("voice_provider"),
    // The streamer starred it; the owner approved it for the landing page.
    favoriteAt: timestamp("favorite_at", { withTimezone: true }),
    showcaseApprovedAt: timestamp("showcase_approved_at", { withTimezone: true }),
    moderationReviewedAt: timestamp("moderation_reviewed_at", { withTimezone: true }),
    characterId: uuid("character_id").references(() => characters.id, { onDelete: "set null" }),
    createdAt: createdAt()
  },
  (table) => [
    uniqueIndex("roasts_event_id_uidx").on(table.eventId),
    index("roasts_channel_created_idx").on(table.channelId, table.createdAt),
    index("roasts_status_created_idx").on(table.status, table.createdAt),
    check("roasts_toxicity_check", sql`${table.toxicity} between 1 and 6`),
    check(
      "roasts_counters_check",
      sql`${table.tokensIn} >= 0 and ${table.tokensOut} >= 0 and ${table.ttsChars} >= 0`
    ),
    check("roasts_latency_check", sql`${table.latencyMs} is null or ${table.latencyMs} >= 0`),
    check("roasts_cost_check", sql`${table.costUsd} >= 0`),
    check(
      "roasts_verdict_check",
      sql`${table.verdict} is null or ${table.verdict} in ('agree', 'mixed', 'refuse')`
    ),
    check(
      "roasts_tier_check",
      sql`${table.tier} is null or ${table.tier} in ('premium', 'economy')`
    )
  ]
);

export const usageMonthly = pgTable(
  "usage_monthly",
  {
    channelId: uuid("channel_id")
      .notNull()
      .references(() => channels.id, { onDelete: "cascade" }),
    month: char("month", { length: 7 }).notNull(),
    roasts: integer("roasts").notNull().default(0),
    tokensIn: integer("tokens_in").notNull().default(0),
    tokensOut: integer("tokens_out").notNull().default(0),
    ttsChars: integer("tts_chars").notNull().default(0),
    costUsd: numeric("cost_usd", { precision: 12, scale: 6 }).notNull().default("0"),
    // Roasts this month on the premium tier, counted against plans.premium_roasts.
    premiumRoasts: integer("premium_roasts").notNull().default(0),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow()
  },
  (table) => [
    primaryKey({ columns: [table.channelId, table.month] }),
    check("usage_monthly_premium_roasts_check", sql`${table.premiumRoasts} >= 0`),
    check("usage_monthly_month_check", sql`${table.month} ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'`),
    check(
      "usage_monthly_counters_check",
      sql`${table.roasts} >= 0 and ${table.tokensIn} >= 0 and ${table.tokensOut} >= 0 and ${table.ttsChars} >= 0 and ${table.costUsd} >= 0`
    )
  ]
);

// Dashboard tests and simulated events per channel and UTC day, apart from the monthly quota.
export const testUsageDaily = pgTable(
  "test_usage_daily",
  {
    channelId: uuid("channel_id")
      .notNull()
      .references(() => channels.id, { onDelete: "cascade" }),
    day: date("day").notNull(),
    roasts: integer("roasts").notNull().default(0)
  },
  (table) => [
    primaryKey({ name: "test_usage_daily_pk", columns: [table.channelId, table.day] }),
    check("test_usage_daily_roasts_check", sql`${table.roasts} >= 0`)
  ]
);

export const ttsUsageMonthly = pgTable(
  "tts_usage_monthly",
  {
    provider: text("provider").notNull(),
    month: char("month", { length: 7 }).notNull(),
    requests: integer("requests").notNull().default(0),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow()
  },
  (table) => [
    primaryKey({ columns: [table.provider, table.month] }),
    check("tts_usage_monthly_month_check", sql`${table.month} ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'`),
    check("tts_usage_monthly_requests_check", sql`${table.requests} >= 0`)
  ]
);

/** The owner's per-channel exceptions to the plan ("favourites"); null keeps the plan's value. */
export const channelOverrides = pgTable(
  "channel_overrides",
  {
    channelId: uuid("channel_id")
      .primaryKey()
      .references(() => channels.id, { onDelete: "cascade" }),
    unlimited: boolean("unlimited").notNull().default(false),
    zeroRegrets: boolean("zero_regrets").notNull().default(false),
    monthlyRoastLimit: integer("monthly_roast_limit"),
    premiumRoasts: integer("premium_roasts"),
    minCooldownSec: integer("min_cooldown_sec"),
    model: text("model"),
    chatModel: text("chat_model"),
    economyModel: text("economy_model"),
    economyVoice: text("economy_voice"),
    note: text("note"),
    updatedByUserId: uuid("updated_by_user_id").references(() => users.id, {
      onDelete: "set null"
    }),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow()
  },
  (table) => [
    check(
      "channel_overrides_limits_check",
      sql`coalesce(${table.monthlyRoastLimit}, 0) >= 0 and coalesce(${table.premiumRoasts}, 0) >= 0
        and coalesce(${table.minCooldownSec}, 0) >= 0`
    ),
    check("channel_overrides_voice_check", sql`${table.economyVoice} in ('yandex', 'piper')`)
  ]
);

export const giftedQuota = pgTable(
  "gifted_quota",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    channelId: uuid("channel_id")
      .notNull()
      .references(() => channels.id, { onDelete: "cascade" }),
    month: char("month", { length: 7 }).notNull(),
    amount: integer("amount").notNull(),
    used: integer("used").notNull().default(0),
    grantedByUserId: uuid("granted_by_user_id").references(() => users.id, {
      onDelete: "set null"
    }),
    reason: text("reason"),
    createdAt: createdAt()
  },
  (table) => [
    index("gifted_quota_channel_month_idx").on(table.channelId, table.month),
    check("gifted_quota_month_check", sql`${table.month} ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'`),
    check(
      "gifted_quota_amount_check",
      sql`${table.amount} > 0 and ${table.used} >= 0 and ${table.used} <= ${table.amount}`
    )
  ]
);

export const cooldownState = pgTable(
  "cooldown_state",
  {
    channelId: uuid("channel_id")
      .notNull()
      .references(() => channels.id, { onDelete: "cascade" }),
    scope: cooldownScopeEnum("scope").notNull(),
    subjectKey: text("subject_key").notNull(),
    nextAllowedAt: timestamp("next_allowed_at", { withTimezone: true }).notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow()
  },
  (table) => [
    primaryKey({ columns: [table.channelId, table.scope, table.subjectKey] }),
    index("cooldown_state_expiry_idx").on(table.nextAllowedAt),
    check(
      "cooldown_state_subject_check",
      sql`(${table.scope} = 'channel' and ${table.subjectKey} = '*') or (${table.scope} = 'viewer' and length(${table.subjectKey}) > 0)`
    )
  ]
);

export const overlayEvents = pgTable(
  "overlay_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    channelId: uuid("channel_id")
      .notNull()
      .references(() => channels.id, { onDelete: "cascade" }),
    roastId: uuid("roast_id")
      .notNull()
      .references(() => roasts.id, { onDelete: "cascade" }),
    payload: jsonb("payload").$type<StoredOverlayRoast>().notNull(),
    status: overlayEventStatusEnum("status").notNull().default("pending"),
    attempts: integer("attempts").notNull().default(0),
    availableAt: timestamp("available_at", { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    deliveredAt: timestamp("delivered_at", { withTimezone: true }),
    createdAt: createdAt()
  },
  (table) => [
    uniqueIndex("overlay_events_roast_id_uidx").on(table.roastId),
    index("overlay_events_dispatch_idx").on(table.channelId, table.status, table.availableAt),
    index("overlay_events_expires_idx").on(table.expiresAt),
    check("overlay_events_attempts_check", sql`${table.attempts} >= 0`),
    check("overlay_events_expiry_check", sql`${table.expiresAt} > ${table.createdAt}`)
  ]
);

export const auditLog = pgTable(
  "audit_log",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    actorUserId: uuid("actor_user_id").references(() => users.id, { onDelete: "set null" }),
    action: text("action").notNull(),
    target: text("target").notNull(),
    payload: jsonb("payload").$type<Record<string, unknown>>().notNull().default({}),
    createdAt: createdAt()
  },
  (table) => [
    index("audit_log_actor_created_idx").on(table.actorUserId, table.createdAt),
    index("audit_log_action_created_idx").on(table.action, table.createdAt)
  ]
);

export const invites = pgTable(
  "invites",
  {
    login: text("login").primaryKey(),
    createdByUserId: uuid("created_by_user_id").references(() => users.id, {
      onDelete: "set null"
    }),
    usedByUserId: uuid("used_by_user_id").references(() => users.id, { onDelete: "set null" }),
    usedAt: timestamp("used_at", { withTimezone: true }),
    createdAt: createdAt()
  },
  (table) => [check("invites_login_check", sql`${table.login} ~ '^[a-z0-9_]{3,25}$'`)]
);

// Landing demo answers; the IP only as an HMAC with the day. Texts are redacted after a day.
export const demoRequests = pgTable(
  "demo_requests",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    ipHash: text("ip_hash").notNull(),
    day: date("day").notNull(),
    inputText: text("input_text"),
    outputText: text("output_text"),
    status: text("status").notNull().default("queued"),
    error: text("error"),
    audioFile: text("audio_file"),
    costUsd: numeric("cost_usd", { precision: 10, scale: 6 }).notNull().default("0"),
    createdAt: createdAt()
  },
  (table) => [
    index("demo_requests_day_ip_idx").on(table.day, table.ipHash),
    index("demo_requests_created_idx").on(table.createdAt),
    check(
      "demo_requests_status_check",
      sql`${table.status} in ('queued', 'done', 'blocked', 'failed', 'skipped')`
    ),
    check("demo_requests_cost_check", sql`${table.costUsd} >= 0`)
  ]
);

export const inviteLinks = pgTable(
  "invite_links",
  {
    code: text("code").primaryKey(),
    note: text("note"),
    plan: planCodeEnum("plan"),
    planDays: integer("plan_days"),
    maxUses: integer("max_uses").notNull().default(1),
    uses: integer("uses").notNull().default(0),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    createdByUserId: uuid("created_by_user_id").references(() => users.id, {
      onDelete: "set null"
    }),
    createdAt: createdAt()
  },
  (table) => [
    check("invite_links_code_check", sql`${table.code} ~ '^[A-Za-z0-9_-]{8,64}$'`),
    check(
      "invite_links_uses_check",
      sql`${table.maxUses} > 0 and ${table.uses} >= 0 and ${table.uses} <= ${table.maxUses}`
    ),
    check(
      "invite_links_plan_check",
      sql`(${table.plan} is null and ${table.planDays} is null) or (${table.plan} is not null and ${table.planDays} > 0)`
    )
  ]
);

export const inviteLinkUses = pgTable(
  "invite_link_uses",
  {
    code: text("code")
      .notNull()
      .references(() => inviteLinks.code, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    usedAt: timestamp("used_at", { withTimezone: true }).notNull().defaultNow()
  },
  (table) => [primaryKey({ name: "invite_link_uses_pk", columns: [table.code, table.userId] })]
);

export const telegramAccounts = pgTable("telegram_accounts", {
  channelId: uuid("channel_id")
    .primaryKey()
    .references(() => channels.id, { onDelete: "cascade" }),
  chatId: bigint("chat_id", { mode: "number" }).notNull(),
  username: text("username"),
  linkedAt: timestamp("linked_at", { withTimezone: true }).notNull().defaultNow(),
  lastSummaryAt: timestamp("last_summary_at", { withTimezone: true })
});

export const telegramLinkTokens = pgTable("telegram_link_tokens", {
  tokenHash: text("token_hash").primaryKey(),
  channelId: uuid("channel_id")
    .notNull()
    .references(() => channels.id, { onDelete: "cascade" }),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull()
});

export const notificationsSent = pgTable(
  "notifications_sent",
  {
    channelId: uuid("channel_id")
      .notNull()
      .references(() => channels.id, { onDelete: "cascade" }),
    kind: text("kind").notNull(),
    period: text("period").notNull(),
    sentAt: timestamp("sent_at", { withTimezone: true }).notNull().defaultNow()
  },
  (table) => [
    primaryKey({
      name: "notifications_sent_pk",
      columns: [table.channelId, table.kind, table.period]
    })
  ]
);

export const viewerOptouts = pgTable(
  "viewer_optouts",
  {
    channelId: uuid("channel_id")
      .notNull()
      .references(() => channels.id, { onDelete: "cascade" }),
    viewerLogin: text("viewer_login").notNull(),
    createdAt: createdAt()
  },
  (table) => [
    primaryKey({ name: "viewer_optouts_pk", columns: [table.channelId, table.viewerLogin] })
  ]
);

export const starPayments = pgTable(
  "star_payments",
  {
    chargeId: text("charge_id").primaryKey(),
    channelId: uuid("channel_id").references(() => channels.id, { onDelete: "set null" }),
    plan: planCodeEnum("plan").notNull(),
    stars: integer("stars").notNull(),
    telegramUserId: bigint("telegram_user_id", { mode: "number" }).notNull(),
    recurring: boolean("recurring").notNull().default(false),
    validUntil: timestamp("valid_until", { withTimezone: true }).notNull(),
    subscriptionId: uuid("subscription_id").references(() => subscriptions.id, {
      onDelete: "set null"
    }),
    refundedAt: timestamp("refunded_at", { withTimezone: true }),
    createdAt: createdAt()
  },
  (table) => [
    index("star_payments_created_idx").on(table.createdAt),
    check("star_payments_stars_check", sql`${table.stars} > 0`)
  ]
);

// ElevenLabs voices the owner offers for premium characters, with a sample for the panel.
export const voices = pgTable(
  "voices",
  {
    id: text("id").primaryKey(),
    label: text("label").notNull(),
    description: text("description").notNull().default(""),
    enabled: boolean("enabled").notNull().default(true),
    sort: integer("sort").notNull().default(0),
    sample: bytea("sample"),
    sampleStatus: text("sample_status").notNull().default("pending"),
    createdAt: createdAt()
  },
  (table) => [
    check("voices_id_check", sql`${table.id} ~ '^[A-Za-z0-9]{10,40}$'`),
    check(
      "voices_sample_status_check",
      sql`${table.sampleStatus} in ('pending', 'ready', 'failed')`
    )
  ]
);

// A premium channel's own character. "published" ones (approved by the owner) are in the shop
// for every premium channel; the author uses theirs in any status.
export const characters = pgTable(
  "characters",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    authorChannelId: uuid("author_channel_id")
      .notNull()
      .references(() => channels.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    archetype: toneEnum("archetype").notNull(),
    voiceId: text("voice_id").references(() => voices.id, { onDelete: "set null" }),
    image: bytea("image"),
    imageHash: text("image_hash"),
    status: text("status").notNull().default("private"),
    reviewNote: text("review_note"),
    publishedAt: timestamp("published_at", { withTimezone: true }),
    createdAt: createdAt(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow()
  },
  (table) => [
    index("characters_author_idx").on(table.authorChannelId),
    index("characters_status_idx").on(table.status, table.publishedAt),
    check(
      "characters_status_check",
      sql`${table.status} in ('private', 'pending', 'published', 'rejected')`
    ),
    check("characters_image_check", sql`(${table.image} is null) = (${table.imageHash} is null)`)
  ]
);

// Stubs synthesized once per ElevenLabs voice ("elevenlabs:<voice id>") and phrase.
export const stubAudio = pgTable(
  "stub_audio",
  {
    voiceKey: text("voice_key").notNull(),
    text: text("text").notNull(),
    audio: bytea("audio").notNull(),
    createdAt: createdAt()
  },
  (table) => [primaryKey({ name: "stub_audio_pk", columns: [table.voiceKey, table.text] })]
);

export const globalSettings = pgTable("global_settings", {
  key: text("key").primaryKey(),
  value: jsonb("value").$type<unknown>().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow()
});

export const usersRelations = relations(users, ({ many }) => ({
  channels: many(channels),
  subscriptions: many(subscriptions),
  grantedQuota: many(giftedQuota),
  auditEntries: many(auditLog)
}));

export const channelsRelations = relations(channels, ({ one, many }) => ({
  user: one(users, { fields: [channels.userId], references: [users.id] }),
  settings: one(settings),
  twitchToken: one(twitchTokens),
  events: many(events),
  roasts: many(roasts),
  usage: many(usageMonthly),
  giftedQuota: many(giftedQuota),
  cooldowns: many(cooldownState),
  overlayEvents: many(overlayEvents)
}));

export const settingsRelations = relations(settings, ({ one }) => ({
  channel: one(channels, { fields: [settings.channelId], references: [channels.id] })
}));

export const plansRelations = relations(plans, ({ many }) => ({
  subscriptions: many(subscriptions)
}));

export const subscriptionsRelations = relations(subscriptions, ({ one }) => ({
  user: one(users, { fields: [subscriptions.userId], references: [users.id] }),
  plan: one(plans, { fields: [subscriptions.planId], references: [plans.id] })
}));

export const eventsRelations = relations(events, ({ one }) => ({
  channel: one(channels, { fields: [events.channelId], references: [channels.id] }),
  roast: one(roasts)
}));

export const roastsRelations = relations(roasts, ({ one }) => ({
  channel: one(channels, { fields: [roasts.channelId], references: [channels.id] }),
  event: one(events, { fields: [roasts.eventId], references: [events.id] }),
  overlayEvent: one(overlayEvents)
}));
