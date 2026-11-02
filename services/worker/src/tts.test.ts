import { describe, expect, it } from "vitest";

import type { WorkerConfig } from "./config.js";
import { cloudVoicesFor } from "./tts.js";

const config = {
  ELEVENLABS_API_KEY: "el",
  ELEVENLABS_VOICE_TSUNDERE: "mitsuki-el",
  ELEVENLABS_VOICE_YANDERE: "ai-el",
  INWORLD_API_KEY: "iw",
  INWORLD_VOICE_TSUNDERE: "mitsuki-iw",
  INWORLD_VOICE_YANDERE: "ai-iw"
} as WorkerConfig;

describe("cloudVoicesFor", () => {
  it("gives the built-in characters both voices, Inworld after ElevenLabs", () => {
    expect(cloudVoicesFor("yandere", config)).toEqual({ elevenlabs: "ai-el", inworld: "ai-iw" });
    expect(cloudVoicesFor("kuudere", config)).toEqual({});
  });

  it("goes on in Ai's Inworld voice for an own character with Ai's ElevenLabs voice", () => {
    expect(cloudVoicesFor("kuudere", config, { provider: "elevenlabs", id: "ai-el" })).toEqual({
      elevenlabs: "ai-el",
      inworld: "ai-iw"
    });
    // Any other ElevenLabs voice has no Inworld twin: Yandex comes next.
    expect(cloudVoicesFor("kuudere", config, { provider: "elevenlabs", id: "other" })).toEqual({
      elevenlabs: "other"
    });
  });

  it("speaks an own Inworld voice straight away, and nothing without a key", () => {
    expect(cloudVoicesFor("dandere", config, { provider: "inworld", id: "Ashley" })).toEqual({
      inworld: "Ashley"
    });
    expect(cloudVoicesFor("dandere", config, null)).toEqual({});
    expect(cloudVoicesFor("yandere", { ...config, ELEVENLABS_API_KEY: undefined })).toEqual({
      inworld: "ai-iw"
    });
  });
});
