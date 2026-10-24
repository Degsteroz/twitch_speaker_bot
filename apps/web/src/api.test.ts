import { describe, expect, it } from "vitest";

import { DEFAULT_TRIGGERS, normalizeSettings, normalizeTriggers, overlayUrl } from "./api.js";

describe("normalizeSettings", () => {
  it("maps the API snake_case settings contract", () => {
    expect(
      normalizeSettings({
        tone: "tsundere",
        voice: "female",
        toxicity: 3,
        cooldown_sec: 20,
        user_cooldown_sec: 60,
        triggers: { command: true, rewardId: null },
        stop_words: ["бан"],
        enabled: true
      })
    ).toEqual({
      tone: "tsundere",
      voice: "female",
      toxicity: 3,
      cooldownSec: 20,
      userCooldownSec: 60,
      triggers: DEFAULT_TRIGGERS,
      stopWords: ["бан"],
      enabled: true
    });
  });

  it("completes triggers saved before the newer fields existed", () => {
    const triggers = normalizeTriggers({
      command: false,
      rewardId: "r1",
      events: { raid: { enabled: true } }
    });
    expect(triggers).toMatchObject({ command: false, rewardId: "r1", keywordChancePercent: 25 });
    expect(triggers.events.raid).toEqual({ enabled: true, minViewers: 5 });
    expect(triggers.events.cheer).toEqual({ enabled: false, minBits: 100 });
  });

  it("drops the old reward and target fields so a save is not rejected", () => {
    const triggers = normalizeTriggers({
      rewardMode: "verdict",
      streamerLoyaltyPercent: 80,
      streamerTargetPercent: 50
    });
    expect(triggers.targetMode).toBe("auto");
    expect(Object.keys(triggers).sort()).toEqual(Object.keys(DEFAULT_TRIGGERS).sort());
  });
});

describe("overlayUrl", () => {
  it("is absolute even when the build uses a relative overlay path", () => {
    expect(overlayUrl("a+b/c", "https://app.example.com", "/overlay")).toBe(
      "https://app.example.com/overlay/?token=a%2Bb%2Fc"
    );
  });

  it("keeps an absolute overlay origin", () => {
    expect(overlayUrl("t", "https://app.example.com", "https://cdn.example.com/obs/")).toBe(
      "https://cdn.example.com/obs/?token=t"
    );
  });
});
