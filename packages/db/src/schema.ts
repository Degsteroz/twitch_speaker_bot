import type { StoredOverlayRoast, TriggerSettings } from "@roastbot/shared";
import { relations, sql } from "drizzle-orm";
import {
  boolean,
  check,
  char,
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

const createdAt = () => timestamp("created_at", { withTimezone: true }).notNull().defaultNow();

export const userRoleEnum = pgEnum("user_role", ["owner", "user"]);
export const userStatusEnum = pgEnum("user_status", ["active", "suspended"]);
export const toneEnum = pgEnum("tone", ["tsundere", "yandere"]);
export const voiceEnum = pgEnum("voice", ["male", "female"]);
export const planCodeEnum = pgEnum("plan_code", ["free", "basic", "premium"]);
export const subscriptionSourceEnum = pgEnum("subscription_source", ["manual"]);
export const eventTypeEnum = pgEnum("event_type", ["chat_command", "reward", "dashboard_test"]);
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
    triggers: jsonb("triggers")
      .$type<TriggerSettings>()
      .notNull()
      .default({ command: true, rewardId: null }),
    stopWords: text("stop_words")
      .array()
      .notNull()
      .default(sql`ARRAY[]::text[]`),
    enabled: boolean("enabled").notNull().default(true),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow()
  },
  (table) => [
    check("settings_toxicity_check", sql`${table.toxicity} between 1 and 5`),
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
    createdAt: createdAt()
  },
  (table) => [
    uniqueIndex("plans_code_uidx").on(table.code),
    check("plans_roast_limit_check", sql`${table.monthlyRoastLimit} >= 0`),
    check("plans_tts_limit_check", sql`${table.monthlyTtsLimit} >= 0`)
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
    moderationReviewedAt: timestamp("moderation_reviewed_at", { withTimezone: true }),
    createdAt: createdAt()
  },
  (table) => [
    uniqueIndex("roasts_event_id_uidx").on(table.eventId),
    index("roasts_channel_created_idx").on(table.channelId, table.createdAt),
    index("roasts_status_created_idx").on(table.status, table.createdAt),
    check("roasts_toxicity_check", sql`${table.toxicity} between 1 and 5`),
    check(
      "roasts_counters_check",
      sql`${table.tokensIn} >= 0 and ${table.tokensOut} >= 0 and ${table.ttsChars} >= 0`
    ),
    check("roasts_latency_check", sql`${table.latencyMs} is null or ${table.latencyMs} >= 0`),
    check("roasts_cost_check", sql`${table.costUsd} >= 0`)
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
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow()
  },
  (table) => [
    primaryKey({ columns: [table.channelId, table.month] }),
    check("usage_monthly_month_check", sql`${table.month} ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'`),
    check(
      "usage_monthly_counters_check",
      sql`${table.roasts} >= 0 and ${table.tokensIn} >= 0 and ${table.tokensOut} >= 0 and ${table.ttsChars} >= 0 and ${table.costUsd} >= 0`
    )
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
