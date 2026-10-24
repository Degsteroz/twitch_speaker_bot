import { describe, expect, it } from "vitest";

import {
  channelSettingsSchema,
  overlayServerEventSchema,
  roastRequestedJobSchema
} from "./index.js";

describe("channelSettingsSchema", () => {
  it("applies safe defaults", () => {
    expect(channelSettingsSchema.parse({})).toEqual({
      tone: "tsundere",
      voice: "female",
      toxicity: 2,
      cooldownSec: 30,
      userCooldownSec: 60,
      triggers: { command: true, rewardId: null },
      stopWords: [],
      enabled: true
    });
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
