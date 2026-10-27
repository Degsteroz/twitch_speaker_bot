import { describe, expect, it } from "vitest";

import {
  DEFAULT_DONATION_DELAY_SECONDS,
  DEFAULT_TRIGGERS,
  effectiveCooldown,
  MAX_DONATION_DELAY_SECONDS,
  OVERLAY_EVENT_TTL_SECONDS,
  channelSettingsSchema,
  characterNameSchema,
  donationDelaySeconds,
  overlayServerEventSchema,
  parseStarsPayload,
  roastRequestedJobSchema,
  starsPayload,
  storedOverlayRoastSchema,
  triggerSettingsSchema
} from "./index.js";

describe("channelSettingsSchema", () => {
  it("applies safe defaults", () => {
    expect(channelSettingsSchema.parse({})).toEqual({
      tone: "tsundere",
      voice: "female",
      toxicity: 2,
      cooldownSec: 60,
      userCooldownSec: 120,
      triggers: DEFAULT_TRIGGERS,
      stopWords: [],
      enabled: true
    });
    // Every new trigger is off by default: an upgrade never starts roasting on its own.
    expect(DEFAULT_TRIGGERS).toMatchObject({
      command: true,
      rewardId: null,
      keywords: [],
      nameMention: false,
      targetMode: "auto",
      events: { cheer: { enabled: false }, raid: { enabled: false }, follow: { enabled: false } }
    });
  });

  it("completes trigger rows saved before the new fields existed", () => {
    const legacy = triggerSettingsSchema.parse({ command: false, rewardId: "r1" });
    expect(legacy).toMatchObject({ command: false, rewardId: "r1", targetMode: "auto" });
    expect(legacy.events.subscription).toEqual({ enabled: false });
    expect(legacy.ignoredUsers).toEqual([]);
    expect(legacy.events.donation.delaySec).toBe(DEFAULT_DONATION_DELAY_SECONDS);
  });

  it("replaces the old keyword chance with a frequency and keeps the command name", () => {
    const legacy = triggerSettingsSchema.parse({ keywordChancePercent: 100 });
    expect(legacy).not.toHaveProperty("keywordChancePercent");
    expect(legacy.chatFrequency).toBe("normal");
    expect(legacy.commandName).toBe("!роаст");
    expect(triggerSettingsSchema.parse({ commandName: " !Мицуки " }).commandName).toBe("!мицуки");
    for (const bad of ["роаст", "!", "!a", "!два слова", "!song", "!роаст-стоп"]) {
      expect(triggerSettingsSchema.safeParse({ commandName: bad }).success, bad).toBe(false);
    }
  });

  it("never lets a pause go below the plan minimum", () => {
    expect(effectiveCooldown(0, "basic")).toBe(60);
    expect(effectiveCooldown(0, "premium")).toBe(40);
    expect(effectiveCooldown(0, null)).toBe(60);
    expect(effectiveCooldown(300, "premium")).toBe(300);
  });

  it("stores ignored users as plain lowercase logins and rejects anything else", () => {
    expect(
      triggerSettingsSchema.parse({ ignoredUsers: [" @Moo_Bot ", "nightbot"] }).ignoredUsers
    ).toEqual(["moo_bot", "nightbot"]);
    expect(() => triggerSettingsSchema.parse({ ignoredUsers: ["два слова"] })).toThrow();
  });

  it("accepts character names that can be said and matched in chat", () => {
    expect(characterNameSchema.parse("  Мисс   Кэт ")).toBe("Мисс Кэт");
    expect(characterNameSchema.parse("Анна-Мария")).toBe("Анна-Мария");
    for (const bad of ["A", "deg_oz", "Кэт99", "<name>", "-Кэт", "Очень длинное имя героини"]) {
      expect(characterNameSchema.safeParse(bad).success, bad).toBe(false);
    }
  });

  it("stores a character picture as a path and gives the overlay a URL", () => {
    const stored = {
      version: 1,
      type: "roast.play",
      eventId: "00000000-0000-4000-8000-000000000001",
      roastId: "00000000-0000-4000-8000-000000000002",
      viewerLogin: "viewer",
      text: "Привет",
      tone: "tsundere",
      audioFile: "00000000-0000-4000-8000-000000000003.wav",
      expiresAt: "2026-10-26T00:00:00.000Z",
      sentAt: "2026-10-26T00:00:00.000Z"
    };
    const imagePath = "/characters/00000000-0000-4000-8000-000000000004/image?v=0123456789abcdef";
    expect(
      storedOverlayRoastSchema.parse({ ...stored, character: { name: "Кэт", imagePath } }).character
    ).toEqual({ name: "Кэт", imagePath });
    expect(() =>
      storedOverlayRoastSchema.parse({
        ...stored,
        character: { name: "Кэт", imagePath: "https://evil.example/x.png" }
      })
    ).toThrow();
  });

  it("holds a donation roast for the alert plus the reading time, within the overlay TTL", () => {
    expect(donationDelaySeconds("", 8)).toBe(8);
    expect(donationDelaySeconds("а".repeat(140), 8)).toBe(18);
    expect(donationDelaySeconds("а".repeat(5_000), 8)).toBe(MAX_DONATION_DELAY_SECONDS);
    expect(MAX_DONATION_DELAY_SECONDS).toBeLessThan(OVERLAY_EVENT_TTL_SECONDS);
  });

  it("drops the old reward and target fields instead of rejecting the row", () => {
    const old = triggerSettingsSchema.parse({
      rewardMode: "verdict",
      streamerLoyaltyPercent: 80,
      streamerTargetPercent: 50
    });
    expect(old.targetMode).toBe("auto");
    expect(old).not.toHaveProperty("rewardMode");
    expect(old).not.toHaveProperty("streamerTargetPercent");
    expect(() => triggerSettingsSchema.parse({ targetMode: "both" })).toThrow();
  });

  it("rejects unsupported toxicity and unknown fields", () => {
    expect(() => channelSettingsSchema.parse({ toxicity: 6 })).toThrow();
    expect(() => channelSettingsSchema.parse({ unsafe: true })).toThrow();
  });
});

describe("wire contracts", () => {
  it("rejects a job with an invalid source", () => {
    const result = roastRequestedJobSchema.safeParse({
      jobVersion: 1,
      eventId: crypto.randomUUID(),
      channelId: crypto.randomUUID(),
      source: "unknown",
      viewerLogin: "viewer",
      inputText: "hello",
      requestedAt: new Date().toISOString()
    });
    expect(result.success).toBe(false);
  });

  it("parses a versioned overlay event", () => {
    const result = overlayServerEventSchema.parse({
      version: 1,
      type: "roast.play",
      eventId: crypto.randomUUID(),
      roastId: crypto.randomUUID(),
      viewerLogin: "viewer",
      text: "Безопасный роаст",
      audioUrl: "https://example.test/audio.wav",
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      sentAt: new Date().toISOString()
    });
    expect(result.type).toBe("roast.play");
  });
});

describe("Telegram Stars payload", () => {
  it("round-trips a channel and a paid plan and rejects anything else", () => {
    const channelId = "0b7c1c1e-4f0a-4c55-9a8e-1d2f3a4b5c6d";
    expect(parseStarsPayload(starsPayload(channelId, "basic"))).toEqual({
      channelId,
      plan: "basic"
    });
    expect(parseStarsPayload(starsPayload(channelId, "free"))).toBeNull();
    expect(parseStarsPayload("rb1:not-a-uuid:basic")).toBeNull();
  });
});
