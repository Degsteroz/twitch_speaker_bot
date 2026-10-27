import { yandexTtsRequestsFor, type Archetype, type VoiceProvider } from "@roastbot/shared";

import type { WorkerConfig } from "./config.js";

// Each archetype has its own Yandex SpeechKit voice: the voice after the ElevenLabs cap, on
// economy roasts and when ElevenLabs fails. Mitsuki and Ai were picked by ear from samples
// (2026-10); the other three from the SpeechKit voice list.
export const CHARACTER_VOICES: Readonly<Record<Archetype, { voice: string; role: string }>> = {
  tsundere: { voice: "julia", role: "strict" },
  yandere: { voice: "jane", role: "good" },
  kuudere: { voice: "julia", role: "neutral" },
  dandere: { voice: "marina", role: "whisper" },
  himedere: { voice: "dasha", role: "strict" }
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
  provider: VoiceProvider;
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
  /** Gives back the characters of a call ElevenLabs answered with an error: it bills nothing. */
  releaseElevenlabs?: (characters: number) => Promise<void>;
}

// An HTTP error from ElevenLabs is not billed; a timeout or a dropped connection may have been.
const ELEVENLABS_REFUSED = /^elevenlabs_tts_\d{3}$/u;

/** The ElevenLabs voice of a built-in character, when the owner configured one. */
function elevenLabsVoice(tone: Archetype, config: WorkerConfig): string | undefined {
  if (tone === "tsundere") return config.ELEVENLABS_VOICE_TSUNDERE;
  if (tone === "yandere") return config.ELEVENLABS_VOICE_YANDERE;
  return undefined;
}

/**
 * The ElevenLabs voice a character speaks with: a premium character's own one (null: none), or
 * the built-in voice of the archetype. Undefined without a key or a voice.
 */
export function elevenLabsVoiceFor(
  tone: Archetype,
  config: WorkerConfig,
  customVoice?: string | null
): string | undefined {
  if (!config.ELEVENLABS_API_KEY) return undefined;
  return customVoice === undefined ? elevenLabsVoice(tone, config) : (customVoice ?? undefined);
}

async function synthesizeElevenLabs(
  text: string,
  voiceId: string,
  config: WorkerConfig,
  fetcher: typeof globalThis.fetch,
  timeoutMs: number
): Promise<Uint8Array> {
  const url = `${ELEVENLABS_URL}/${encodeURIComponent(voiceId)}?output_format=${ELEVENLABS_FORMAT}`;
  const response = await fetcher(url, {
    method: "POST",
    headers: { "xi-api-key": config.ELEVENLABS_API_KEY!, "Content-Type": "application/json" },
    body: JSON.stringify({ text, model_id: config.ELEVENLABS_MODEL }),
    signal: AbortSignal.timeout(timeoutMs)
  });
  if (!response.ok) throw new Error(`elevenlabs_tts_${response.status}`);
  const audio = new Uint8Array(await response.arrayBuffer());
  if (!audio.length) throw new Error("elevenlabs_tts_empty");
  return audio;
}

async function synthesizeYandex(
  text: string,
  tone: Archetype,
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

// Best first: a roast starts at the voice its tier allows and falls through the rest.
const VOICE_ORDER: readonly VoiceProvider[] = ["elevenlabs", "yandex", "piper"];

export interface SpeakOptions {
  /** The first voice this roast may use: economy roasts start at Yandex or Piper. */
  best?: VoiceProvider;
  /** False skips the local Piper: the landing demo stays silent rather than load the server. */
  piper?: boolean;
  /** A premium character's ElevenLabs voice instead of the built-in one; null means none. */
  voiceId?: string | null;
  /** False stops after ElevenLabs: a voice sample must be that voice or nothing. */
  yandex?: boolean;
  /** How long to wait for ElevenLabs; a sample is not live and can wait longer. */
  elevenLabsTimeoutMs?: number;
  log?: (message: string) => void;
}

/**
 * The best voice the owner pays for, within its monthly cap: ElevenLabs (when a key and a voice for
 * this character are set), then Yandex SpeechKit, then the local Piper. Any failure or slow answer
 * moves on to the next one: an outage of a cloud voice must not silence the stream. Usage is
 * reserved before each call, so failed and timed-out attempts count toward the caps. Without
 * Piper and without a cloud voice, the result is null.
 */
export async function speak(
  text: string,
  tone: Archetype,
  config: WorkerConfig,
  fetcher: typeof globalThis.fetch,
  reserve: VoiceReservations,
  options: SpeakOptions & { piper: false }
): Promise<Speech | null>;
export async function speak(
  text: string,
  tone: Archetype,
  config: WorkerConfig,
  fetcher: typeof globalThis.fetch,
  reserve: VoiceReservations,
  options?: SpeakOptions
): Promise<Speech>;
export async function speak(
  text: string,
  tone: Archetype,
  config: WorkerConfig,
  fetcher: typeof globalThis.fetch,
  reserve: VoiceReservations,
  {
    best = "elevenlabs",
    piper = true,
    voiceId: customVoice,
    yandex = true,
    elevenLabsTimeoutMs = ELEVENLABS_TIMEOUT_MS,
    log = console.warn
  }: SpeakOptions = {}
): Promise<Speech | null> {
  const allowed = (provider: VoiceProvider) =>
    VOICE_ORDER.indexOf(provider) >= VOICE_ORDER.indexOf(best);
  let fallbackReason = allowed("yandex") ? "no_cloud_voice" : "plan_voice";
  const voiceId = allowed("elevenlabs") ? elevenLabsVoiceFor(tone, config, customVoice) : undefined;
  if (voiceId) {
    const characters = Array.from(text).length;
    if (await reserve.elevenlabs(characters)) {
      try {
        const audio = await synthesizeElevenLabs(
          text,
          voiceId,
          config,
          fetcher,
          elevenLabsTimeoutMs
        );
        return {
          audio,
          provider: "elevenlabs",
          costUsd: characters * ELEVENLABS_USD_PER_CHARACTER
        };
      } catch (error) {
        fallbackReason = error instanceof Error ? error.message : "elevenlabs_tts_error";
        log(`ElevenLabs TTS failed, trying the next voice: ${fallbackReason}`);
        if (ELEVENLABS_REFUSED.test(fallbackReason)) {
          await reserve.releaseElevenlabs?.(characters).catch(() => undefined);
        }
      }
    } else {
      fallbackReason = "elevenlabs_tts_monthly_limit";
    }
  }
  if (config.YANDEX_TTS_API_KEY && yandex && allowed("yandex")) {
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
  if (!piper) return null;
  return {
    audio: await synthesizePiper(text, config, fetcher),
    provider: "piper",
    costUsd: 0,
    fallbackReason
  };
}
