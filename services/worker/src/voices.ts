// Voice samples for the panel: the owner adds an ElevenLabs or Inworld voice in /admin, the API
// queues a job and the worker records one short phrase in that voice. Like every paid call it goes
// through speak() after reserving characters against that provider's monthly cap; no fallback
// voice, since a sample in another voice would mislead.
import {
  characterVoiceProviderSchema,
  elevenLabsVoiceIdSchema,
  VOICE_COMPARE_PROVIDERS,
  VOICE_COMPARE_TONES,
  VOICE_SAMPLE_TEXT,
  voiceCompareJobSchema,
  voiceSampleJobSchema
} from "@roastbot/shared";

import type { WorkerConfig } from "./config.js";
import type { Sql } from "./context.js";
import { voiceReservations } from "./limits.js";
import { cloudVoicesFor, speak } from "./tts.js";

// The first synthesis in a voice from the ElevenLabs library is slower than the live roast timeout;
// nobody waits for a sample, so it gets much longer.
const SAMPLE_TIMEOUT_MS = 60_000;

export interface VoiceSampleDependencies {
  sql: Sql;
  config: WorkerConfig;
  fetch?: typeof globalThis.fetch;
  now?: () => Date;
}

export async function recordVoiceSample(
  rawJob: unknown,
  deps: VoiceSampleDependencies
): Promise<"ready" | "failed" | "skipped"> {
  const { voiceId } = voiceSampleJobSchema.parse(rawJob);
  const [voice] = await deps.sql<{ provider: string }[]>`
    select provider from voices where id=${voiceId}`;
  if (!voice) return "skipped";
  const provider = characterVoiceProviderSchema.parse(voice.provider);
  const speech = await speak(
    VOICE_SAMPLE_TEXT,
    "tsundere",
    deps.config,
    deps.fetch ?? globalThis.fetch,
    await voiceReservations(deps),
    {
      best: provider,
      voice: { provider, id: voiceId },
      fallback: false,
      piper: false,
      cloudTimeoutMs: SAMPLE_TIMEOUT_MS
    }
  );
  const status = speech?.provider === provider ? "ready" : "failed";
  await deps.sql`update voices set sample_status=${status},
    sample=${status === "ready" ? Buffer.from(speech!.audio) : null} where id=${voiceId}`;
  return status;
}

/**
 * The owner's voice comparison: the same phrase from Mitsuki and Ai in ElevenLabs, Inworld and
 * Yandex, each strictly in that service (no fallback, never Piper) and within its monthly cap.
 * A service without a key or a voice for the heroine is marked no_voice without a call. A newer
 * request with another phrase wins: rows whose phrase changed meanwhile are left alone.
 */
export async function recordVoiceComparison(
  rawJob: unknown,
  deps: VoiceSampleDependencies
): Promise<Record<string, string>> {
  const { text } = voiceCompareJobSchema.parse(rawJob);
  const reservations = await voiceReservations(deps);
  const result: Record<string, string> = {};
  for (const tone of VOICE_COMPARE_TONES) {
    const voices = cloudVoicesFor(tone, deps.config);
    for (const provider of VOICE_COMPARE_PROVIDERS) {
      const configured =
        provider === "yandex" ? Boolean(deps.config.YANDEX_TTS_API_KEY) : Boolean(voices[provider]);
      const speech = configured
        ? await speak(text, tone, deps.config, deps.fetch ?? globalThis.fetch, reservations, {
            best: provider,
            fallback: false,
            piper: false,
            cloudTimeoutMs: SAMPLE_TIMEOUT_MS
          }).catch(() => null)
        : null;
      const status = !configured ? "no_voice" : speech?.provider === provider ? "ready" : "failed";
      await deps.sql`update voice_compare set status=${status},
          audio=${status === "ready" ? Buffer.from(speech!.audio) : null}, updated_at=now()
        where tone=${tone} and provider=${provider} and text=${text}`;
      result[`${tone}/${provider}`] = status;
    }
  }
  return result;
}

// Mitsuki's and Ai's ElevenLabs voices are configured in the environment; streamers may pick them
// for their own characters too. Their Inworld twins (INWORLD_VOICE_*) take over after the
// ElevenLabs cap without a row of their own: see cloudVoicesFor().
const BUILT_IN_VOICES = [
  { key: "ELEVENLABS_VOICE_TSUNDERE", label: "Как у Мицуки", sort: 1 },
  { key: "ELEVENLABS_VOICE_YANDERE", label: "Как у Аи", sort: 2 }
] as const;

// global_settings key: the one-time move of own characters to Ai's voice is done.
const MOVED_TO_AI = "custom_voices_moved_to_ai";

/**
 * At startup: offers the built-in characters' voices in the list and returns the voices that still
 * wait for a sample, so the caller queues one job per voice. Failed samples are retried only from
 * /admin, so a broken voice ID does not spend characters on every restart.
 */
export async function syncVoices(sql: Sql, config: WorkerConfig): Promise<string[]> {
  const builtIn: string[] = [];
  for (const { key, label, sort } of BUILT_IN_VOICES) {
    const parsed = elevenLabsVoiceIdSchema.safeParse(config[key]);
    if (!parsed.success) continue;
    builtIn.push(parsed.data);
    await sql`insert into voices(id,label,sort) values(${parsed.data},${label},${sort})
      on conflict (id) do nothing`;
  }
  const ai = elevenLabsVoiceIdSchema.safeParse(config.ELEVENLABS_VOICE_YANDERE);
  if (ai.success) await moveOwnCharactersToAi(sql, ai.data, builtIn);
  const providers = [
    ...(config.ELEVENLABS_API_KEY ? ["elevenlabs"] : []),
    ...(config.INWORLD_API_KEY ? ["inworld"] : [])
  ];
  if (!providers.length) return [];
  const pending = await sql<{ id: string }[]>`
    select id from voices where sample is null and sample_status='pending' and enabled
      and provider in ${sql(providers)}`;
  return pending.map(({ id }) => id);
}

/**
 * Once: own characters with any other ElevenLabs voice now speak like Ai, and those voices leave
 * the list, so the rest of the ElevenLabs plan goes to Mitsuki and Ai. Streamers then pick from the
 * Inworld voices the owner adds. The flag is written in the same transaction, so parallel workers
 * do it once.
 */
async function moveOwnCharactersToAi(sql: Sql, ai: string, builtIn: string[]) {
  await sql.begin(async (tx) => {
    const [first] = await tx`insert into global_settings(key,value)
      values(${MOVED_TO_AI},${tx.json(new Date().toISOString())})
      on conflict(key) do nothing returning key`;
    if (!first) return;
    const moved = await tx`update characters set voice_id=${ai}, updated_at=now()
      where voice_id in (select id from voices where provider='elevenlabs'
        and id not in ${tx(builtIn)}) returning id`;
    await tx`update voices set enabled=false
      where provider='elevenlabs' and id not in ${tx(builtIn)}`;
    console.log(JSON.stringify({ msg: "voices.moved_to_ai", characters: moved.length }));
  });
}
