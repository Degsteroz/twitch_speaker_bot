import { describe, expect, it } from "vitest";

import {
  DEFAULT_TRIGGERS,
  normalizeSettings,
  normalizeTriggers,
  overlayUrl,
  quotaMinutes,
  roastsPerMinute
} from "./api.js";

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
    expect(triggers).toMatchObject({
      command: false,
      commandName: "!роаст",
      rewardId: "r1",
      chatFrequency: "normal"
    });
    expect(triggers.events.raid).toEqual({ enabled: true, minViewers: 5 });
    expect(triggers.events.cheer).toEqual({ enabled: false, minBits: 100 });
  });

  it("drops the old reward and target fields so a save is not rejected", () => {
    const triggers = normalizeTriggers({
      keywordChancePercent: 100,
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

describe("quota estimate", () => {
  const base = DEFAULT_TRIGGERS;

  it("is empty when nothing can trigger a roast", () => {
    expect(roastsPerMinute({ ...base, command: true }, 30, false)).toBe(0);
    expect(quotaMinutes(10, 0)).toBeNull();
  });

  it("answers every Nth chat word and caps chat by the channel pause but not paid events", () => {
    const busy = {
      ...base,
      keywords: ["гг", "слил", "лаг", "кринж", "изи", "бот", "ещё"],
      chatFrequency: "often" as const
    };
    // Six words × 0.5 a minute = 3 hits a minute, every 6th answered: 0.5 a minute.
    expect(roastsPerMinute(busy, 0, false)).toBeCloseTo(0.5);
    expect(roastsPerMinute({ ...busy, chatFrequency: "rare" }, 0, false)).toBeCloseTo(0.25);
    // A 60-second pause allows one a minute: chat plus the command hit it.
    expect(roastsPerMinute({ ...busy, command: true }, 60, true)).toBe(1);
    const withRaids = {
      ...busy,
      command: true,
      events: { ...busy.events, raid: { enabled: true, minViewers: 5 } }
    };
    expect(roastsPerMinute(withRaids, 60, true)).toBeCloseTo(1.01);
    expect(quotaMinutes(10, 2)).toBe(5);
  });
});
