import { z } from "zod";

export const APP_NAME = "RoastBot";
export const DEFAULT_CHANNEL_MONTHLY_ROASTS = 100;
export const DEFAULT_CHANNEL_COOLDOWN_SECONDS = 30;
export const DEFAULT_USER_COOLDOWN_SECONDS = 60;
export const DEFAULT_GLOBAL_MONTHLY_ROAST_CAP = 4_000;
export const MAX_ROAST_CHARACTERS = 200;
export const OVERLAY_EVENT_TTL_SECONDS = 120;
export const AUDIO_URL_TTL_SECONDS = 60;
export const DEFAULT_MONTHLY_BUDGET_USD = 5;
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
export const roastSourceSchema = z.enum(["chat_command", "reward", "dashboard_test"]);
export const roastStatusSchema = z.enum([
  "queued",
  "blocked_input",
  "blocked_output",
  "done",
  "failed",
  "skipped"
]);

export const triggerSettingsSchema = z
  .object({
    command: z.boolean().default(true),
    rewardId: z.string().min(1).nullable().default(null)
  })
  .strict();

export const channelSettingsSchema = z
  .object({
    tone: toneSchema.default("tsundere"),
    voice: voiceSchema.default("female"),
    toxicity: toxicitySchema.default(2),
    cooldownSec: z.number().int().min(0).max(3_600).default(DEFAULT_CHANNEL_COOLDOWN_SECONDS),
    userCooldownSec: z.number().int().min(0).max(86_400).default(DEFAULT_USER_COOLDOWN_SECONDS),
    triggers: triggerSettingsSchema.default({ command: true, rewardId: null }),
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
