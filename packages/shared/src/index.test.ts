import { describe, expect, it } from "vitest";

import {
  DEFAULT_TRIGGERS,
  channelSettingsSchema,
  overlayServerEventSchema,
  roastRequestedJobSchema,
  triggerSettingsSchema
} from "./index.js";

describe("channelSettingsSchema", () => {
  it("applies safe defaults", () => {
    expect(channelSettingsSchema.parse({})).toEqual({
      tone: "tsundere",
      voice: "female",
      toxicity: 2,
      cooldownSec: 30,
      userCooldownSec: 60,
      triggers: DEFAULT_TRIGGERS,
      stopWords: [],
      enabled: true
    });
    // Every new trigger is off by default: an upgrade never starts roasting on its own.
    expect(DEFAULT_TRIGGERS).toMatchObject({
      command: true,
      rewardId: null,
      keywords: [],
      targetMode: "auto",
      events: { cheer: { enabled: false }, raid: { enabled: false }, follow: { enabled: false } }
    });
  });

  it("completes trigger rows saved before the new fields existed", () => {
    const legacy = triggerSettingsSchema.parse({ command: false, rewardId: "r1" });
    expect(legacy).toMatchObject({ command: false, rewardId: "r1", targetMode: "auto" });
    expect(legacy.events.subscription).toEqual({ enabled: false });
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
