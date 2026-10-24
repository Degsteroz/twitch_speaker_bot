import { yandexTtsRequestsFor, type Tone } from "@roastbot/shared";

import type { WorkerConfig } from "./config.js";

// Each character has its own Yandex SpeechKit voice; picked by ear from samples (2026-10).
export const CHARACTER_VOICES: Readonly<Record<Tone, { voice: string; role: string }>> = {
  tsundere: { voice: "julia", role: "strict" },
  yandere: { voice: "jane", role: "good" }
};

// 0.1626 ₽ with VAT per request is about $0.00133 without VAT (pricing page, 2026-10); rounded up
// so the dollar budget guard errs on the safe side. The rouble cap is enforced separately.
export const YANDEX_USD_PER_REQUEST = 0.0015;
const YANDEX_URL = "https://tts.api.cloud.yandex.net/tts/v3/utteranceSynthesis";
// A roast that waits longer than this for the cloud voice is better served by the local one.
const YANDEX_TIMEOUT_MS = 3_500;
const PIPER_TIMEOUT_MS = 15_000;

// ElevenLabs bills $0.08 per 1,000 characters on v4/v3/multilingual v2 (pricing page, 2026-10).
export const ELEVENLABS_USD_PER_CHARACTER = 0.08 / 1_000;
const ELEVENLABS_URL = "https://api.elevenlabs.io/v1/text-to-speech";
// WAV like the other voices; 44.1 kHz WAV needs the Pro plan, 24 kHz does not.
const ELEVENLABS_FORMAT = "wav_24000";
// The expressive models take longer than SpeechKit; past this the next voice takes over.
const ELEVENLABS_TIMEOUT_MS = 6_000;

export interface Speech {
  audio: Uint8Array;
  provider: "elevenlabs" | "yandex" | "piper";
  costUsd: number;
  /** Why the cloud voice was skipped, if it was. */
  fallbackReason?: string;
}

/** Reserves billable requests against the monthly cap; false means the cap is reached. */
export type ReserveRequests = (requests: number) => Promise<boolean>;

/** Monthly caps per paid voice: Yandex counts requests, ElevenLabs counts characters. */
export interface VoiceReservations {
  yandex: ReserveRequests;
  elevenlabs: ReserveRequests;
}

/** The ElevenLabs voice for this character, when the owner configured one. */
function elevenLabsVoice(tone: Tone, config: WorkerConfig): string | undefined {
  return tone === "yandere" ? config.ELEVENLABS_VOICE_YANDERE : config.ELEVENLABS_VOICE_TSUNDERE;
}

async function synthesizeElevenLabs(
  text: string,
  voiceId: string,
  config: WorkerConfig,
  fetcher: typeof globalThis.fetch
): Promise<Uint8Array> {
  const url = `${ELEVENLABS_URL}/${encodeURIComponent(voiceId)}?output_format=${ELEVENLABS_FORMAT}`;
  const response = await fetcher(url, {
    method: "POST",
    headers: { "xi-api-key": config.ELEVENLABS_API_KEY!, "Content-Type": "application/json" },
    body: JSON.stringify({ text, model_id: config.ELEVENLABS_MODEL }),
    signal: AbortSignal.timeout(ELEVENLABS_TIMEOUT_MS)
  });
  if (!response.ok) throw new Error(`elevenlabs_tts_${response.status}`);
  const audio = new Uint8Array(await response.arrayBuffer());
  if (!audio.length) throw new Error("elevenlabs_tts_empty");
  return audio;
}

async function synthesizeYandex(
  text: string,
  tone: Tone,
  apiKey: string,
  fetcher: typeof globalThis.fetch
): Promise<Uint8Array> {
  const { voice, role } = CHARACTER_VOICES[tone];
  const response = await fetcher(YANDEX_URL, {
    method: "POST",
    headers: { Authorization: `Api-Key ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({ text, hints: [{ voice }, { role }] }),
    signal: AbortSignal.timeout(YANDEX_TIMEOUT_MS)
  });
  if (!response.ok) throw new Error(`yandex_tts_${response.status}`);
  // The body is one JSON object per line, each carrying a base64 piece of one WAV file.
  const chunks = (await response.text())
    .split("\n")
    .filter(Boolean)
    .map((line) => (JSON.parse(line) as { result?: { audioChunk?: { data?: string } } }).result)
    .flatMap((result) =>
      result?.audioChunk?.data ? [Buffer.from(result.audioChunk.data, "base64")] : []
    );
  if (!chunks.length) throw new Error("yandex_tts_empty");
  return new Uint8Array(Buffer.concat(chunks));
}

async function synthesizePiper(
  text: string,
  config: WorkerConfig,
  fetcher: typeof globalThis.fetch
): Promise<Uint8Array> {
  // Piper has one Russian female voice; both characters are female.
  const response = await fetcher(`${config.TTS_URL}/synth`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ text, voice: "female" }),
    signal: AbortSignal.timeout(PIPER_TIMEOUT_MS)
  });
  if (!response.ok) throw new Error(`tts_failed_${response.status}`);
  return new Uint8Array(await response.arrayBuffer());
}

/**
 * The best voice the owner pays for, within its monthly cap: ElevenLabs (when a key and a voice for
 * this character are set), then Yandex SpeechKit, then the local Piper. Any failure or slow answer
 * moves on to the next one: an outage of a cloud voice must not silence the stream. Usage is
 * reserved before each call, so failed and timed-out attempts count toward the caps.
 */
export async function speak(
  text: string,
  tone: Tone,
  config: WorkerConfig,
  fetcher: typeof globalThis.fetch,
  reserve: VoiceReservations,
  log: (message: string) => void = console.warn
): Promise<Speech> {
  let fallbackReason = "no_cloud_voice";
  const voiceId = config.ELEVENLABS_API_KEY ? elevenLabsVoice(tone, config) : undefined;
  if (voiceId) {
    const characters = Array.from(text).length;
    if (await reserve.elevenlabs(characters)) {
      try {
        const audio = await synthesizeElevenLabs(text, voiceId, config, fetcher);
        return {
          audio,
          provider: "elevenlabs",
          costUsd: characters * ELEVENLABS_USD_PER_CHARACTER
        };
      } catch (error) {
        fallbackReason = error instanceof Error ? error.message : "elevenlabs_tts_error";
        log(`ElevenLabs TTS failed, trying the next voice: ${fallbackReason}`);
      }
    } else {
      fallbackReason = "elevenlabs_tts_monthly_limit";
    }
  }
  if (config.YANDEX_TTS_API_KEY) {
    const requests = yandexTtsRequestsFor(text);
    if (await reserve.yandex(requests)) {
      try {
        const audio = await synthesizeYandex(text, tone, config.YANDEX_TTS_API_KEY, fetcher);
        return { audio, provider: "yandex", costUsd: requests * YANDEX_USD_PER_REQUEST };
      } catch (error) {
        fallbackReason = error instanceof Error ? error.message : "yandex_tts_error";
        log(`Yandex TTS failed, falling back to Piper: ${fallbackReason}`);
      }
    } else {
      fallbackReason = "yandex_tts_monthly_limit";
    }
  }
  return {
    audio: await synthesizePiper(text, config, fetcher),
    provider: "piper",
    costUsd: 0,
    fallbackReason
  };
}
