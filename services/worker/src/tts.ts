import {
  ELEVENLABS_USD_PER_CHARACTER,
  yandexTtsRequestsFor,
  type Archetype,
  type CharacterVoiceProvider,
  type VoiceProvider
} from "@roastbot/shared";

import type { WorkerConfig } from "./config.js";

// Each archetype has its own Yandex SpeechKit voice: the voice after the ElevenLabs and Inworld
// caps, on economy roasts and when both fail. Mitsuki and Ai were picked by ear from samples
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
// Past this the emergency Piper takes over.
const YANDEX_TIMEOUT_MS = 3_500;
const PIPER_TIMEOUT_MS = 15_000;

export { ELEVENLABS_USD_PER_CHARACTER };
const ELEVENLABS_URL = "https://api.elevenlabs.io/v1/text-to-speech";
// WAV like the other voices; 44.1 kHz WAV needs the Pro plan, 24 kHz does not.
const ELEVENLABS_FORMAT = "wav_24000";
// The expressive models take longer than SpeechKit; past this the next voice takes over.
const ELEVENLABS_TIMEOUT_MS = 6_000;

// Inworld TTS-2 Flash bills $15 per million characters On-Demand (pricing page, 2026-10).
export const INWORLD_USD_PER_CHARACTER = 15 / 1_000_000;
const INWORLD_URL = "https://api.inworld.ai/tts/v1/voice";
// LINEAR16 in a non-streaming answer comes with a WAV header, like the other voices.
const INWORLD_AUDIO_CONFIG = { audioEncoding: "LINEAR16", sampleRateHertz: 24_000 } as const;
const INWORLD_TIMEOUT_MS = 4_000;

export interface Speech {
  audio: Uint8Array;
  provider: VoiceProvider;
  costUsd: number;
  /** The ElevenLabs or Inworld voice that spoke; stubs cache their audio under it. */
  voiceId?: string;
  /** Why the cloud voice was skipped, if it was. */
  fallbackReason?: string;
}

/** Reserves billable requests against the monthly cap; false means the cap is reached. */
export type ReserveRequests = (requests: number) => Promise<boolean>;

/** Monthly caps per paid voice: Yandex counts requests, ElevenLabs and Inworld count characters. */
export interface VoiceReservations {
  yandex: ReserveRequests;
  elevenlabs: ReserveRequests;
  inworld: ReserveRequests;
  /** Gives back the characters of a call the provider answered with an error: it bills nothing. */
  release?: (provider: CharacterVoiceProvider, characters: number) => Promise<void>;
}

// An HTTP error is not billed; a timeout or a dropped connection may have been.
const REFUSED = /^(elevenlabs|inworld)_tts_\d{3}$/u;

/** A premium character's voice from the list (voices table). */
export interface CharacterVoice {
  provider: CharacterVoiceProvider;
  id: string;
}

/** The cloud voices a character may speak with, best first; a missing one is skipped. */
export interface CloudVoices {
  elevenlabs?: string | undefined;
  inworld?: string | undefined;
}

/** The voices of a built-in character, when the owner configured them. */
function builtInVoices(tone: Archetype, config: WorkerConfig): CloudVoices {
  if (tone === "tsundere")
    return { elevenlabs: config.ELEVENLABS_VOICE_TSUNDERE, inworld: config.INWORLD_VOICE_TSUNDERE };
  if (tone === "yandere")
    return { elevenlabs: config.ELEVENLABS_VOICE_YANDERE, inworld: config.INWORLD_VOICE_YANDERE };
  return {};
}

/**
 * The cloud voices a character speaks with: a premium character's own one (null: none), or the
 * built-in voices of the archetype. An own ElevenLabs voice that is Mitsuki's or Ai's goes on in
 * her Inworld voice after the ElevenLabs cap; any other one goes on in Yandex. Only voices with a
 * key are returned.
 */
export function cloudVoicesFor(
  tone: Archetype,
  config: WorkerConfig,
  custom?: CharacterVoice | null
): CloudVoices {
  let voices: CloudVoices;
  if (custom === undefined) voices = builtInVoices(tone, config);
  else if (custom === null) voices = {};
  else if (custom.provider === "inworld") voices = { inworld: custom.id };
  else {
    const twin = (["tsundere", "yandere"] as const)
      .map((builtIn) => builtInVoices(builtIn, config))
      .find((builtIn) => builtIn.elevenlabs === custom.id);
    voices = { elevenlabs: custom.id, inworld: twin?.inworld };
  }
  return {
    elevenlabs: config.ELEVENLABS_API_KEY ? voices.elevenlabs || undefined : undefined,
    inworld: config.INWORLD_API_KEY ? voices.inworld || undefined : undefined
  };
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

async function synthesizeInworld(
  text: string,
  voiceId: string,
  config: WorkerConfig,
  fetcher: typeof globalThis.fetch,
  timeoutMs: number
): Promise<Uint8Array> {
  const response = await fetcher(INWORLD_URL, {
    method: "POST",
    headers: {
      Authorization: `Basic ${config.INWORLD_API_KEY!}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      text,
      voiceId,
      modelId: config.INWORLD_MODEL,
      audioConfig: INWORLD_AUDIO_CONFIG
    }),
    signal: AbortSignal.timeout(timeoutMs)
  });
  if (!response.ok) throw new Error(`inworld_tts_${response.status}`);
  const { audioContent } = (await response.json()) as { audioContent?: string };
  if (!audioContent) throw new Error("inworld_tts_empty");
  return new Uint8Array(Buffer.from(audioContent, "base64"));
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
const VOICE_ORDER: readonly VoiceProvider[] = ["elevenlabs", "inworld", "yandex", "piper"];

const CHARACTER_PRICES: Readonly<Record<CharacterVoiceProvider, number>> = {
  elevenlabs: ELEVENLABS_USD_PER_CHARACTER,
  inworld: INWORLD_USD_PER_CHARACTER
};

export interface SpeakOptions {
  /** The first voice this roast may use: economy roasts start at Yandex. */
  best?: VoiceProvider;
  /** False skips the local Piper: the landing demo stays silent rather than load the server. */
  piper?: boolean;
  /** A premium character's voice instead of the built-in ones; null means none. */
  voice?: CharacterVoice | null;
  /** False stops after the first voice: a voice sample must be that voice or nothing. */
  fallback?: boolean;
  /** How long to wait for ElevenLabs and Inworld; a sample is not live and can wait longer. */
  cloudTimeoutMs?: number;
  log?: (message: string) => void;
}

/**
 * The best voice the owner pays for, within its monthly cap: ElevenLabs, then Inworld (each when a
 * key and a voice for this character are set), then Yandex SpeechKit, then the emergency Piper.
 * Any failure or slow answer moves on to the next one: an outage of a cloud voice must not silence
 * the stream. Usage is reserved before each call, so failed and timed-out attempts count toward
 * the caps. Without Piper and without a cloud voice, the result is null.
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
    voice: custom,
    fallback = true,
    cloudTimeoutMs,
    log = console.warn
  }: SpeakOptions = {}
): Promise<Speech | null> {
  const allowed = (provider: VoiceProvider) =>
    VOICE_ORDER.indexOf(provider) >= VOICE_ORDER.indexOf(best) && (fallback || provider === best);
  let fallbackReason = allowed("yandex") ? "no_cloud_voice" : "plan_voice";
  const voices = cloudVoicesFor(tone, config, custom);
  const characters = Array.from(text).length;
  for (const provider of ["elevenlabs", "inworld"] as const) {
    const voiceId = voices[provider];
    if (!voiceId || !allowed(provider)) continue;
    if (!(await reserve[provider](characters))) {
      fallbackReason = `${provider}_tts_monthly_limit`;
      continue;
    }
    try {
      const audio =
        provider === "elevenlabs"
          ? await synthesizeElevenLabs(
              text,
              voiceId,
              config,
              fetcher,
              cloudTimeoutMs ?? ELEVENLABS_TIMEOUT_MS
            )
          : await synthesizeInworld(
              text,
              voiceId,
              config,
              fetcher,
              cloudTimeoutMs ?? INWORLD_TIMEOUT_MS
            );
      return { audio, provider, voiceId, costUsd: characters * CHARACTER_PRICES[provider] };
    } catch (error) {
      fallbackReason = error instanceof Error ? error.message : `${provider}_tts_error`;
      log(`${provider} TTS failed, trying the next voice: ${fallbackReason}`);
      if (REFUSED.test(fallbackReason)) {
        await reserve.release?.(provider, characters).catch(() => undefined);
      }
    }
  }
  if (config.YANDEX_TTS_API_KEY && allowed("yandex")) {
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
  // The emergency voice: every cloud voice this roast may use failed, hit its cap or is not set.
  if (!piper || !fallback) return null;
  return {
    audio: await synthesizePiper(text, config, fetcher),
    provider: "piper",
    costUsd: 0,
    fallbackReason
  };
}
