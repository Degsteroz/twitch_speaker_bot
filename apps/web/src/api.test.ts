import { describe, expect, it } from "vitest";

import { normalizeSettings, overlayUrl } from "./api.js";

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
      triggers: { command: true, rewardId: null },
      stopWords: ["бан"],
      enabled: true
    });
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
