// Voice samples for the panel: the owner adds an ElevenLabs voice in /admin, the API queues a job
// and the worker records one short phrase in that voice. Like every paid call it goes through
// speak() after reserving characters against the monthly ElevenLabs cap; no fallback voice, since
// a sample in another voice would mislead.
import {
  DEFAULT_ELEVENLABS_MONTHLY_CHAR_LIMIT,
  elevenLabsVoiceIdSchema,
  VOICE_SAMPLE_TEXT,
  voiceSampleJobSchema
} from "@roastbot/shared";

import type { WorkerConfig } from "./config.js";
import { globalValue, reserveElevenLabsCharacters, type Sql } from "./pipeline.js";
import { speak } from "./tts.js";

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
  const [voice] = await deps.sql`select 1 from voices where id=${voiceId}`;
  if (!voice) return "skipped";
  const limit = await globalValue<number>(
    deps.sql,
    "elevenlabs_monthly_char_limit",
    DEFAULT_ELEVENLABS_MONTHLY_CHAR_LIMIT
  );
  const speech = await speak(
    VOICE_SAMPLE_TEXT,
    "tsundere",
    deps.config,
    deps.fetch ?? globalThis.fetch,
    {
      yandex: () => Promise.resolve(false),
      elevenlabs: (characters) =>
        reserveElevenLabsCharacters(deps.sql, deps.now?.() ?? new Date(), characters, limit)
    },
    { best: "elevenlabs", voiceId, yandex: false, piper: false }
  );
  const status = speech?.provider === "elevenlabs" ? "ready" : "failed";
  await deps.sql`update voices set sample_status=${status},
    sample=${status === "ready" ? Buffer.from(speech!.audio) : null} where id=${voiceId}`;
  return status;
}

// Mitsuki's and Ai's ElevenLabs voices are configured in the environment; streamers may pick them
// for their own characters too.
const BUILT_IN_VOICES = [
  { key: "ELEVENLABS_VOICE_TSUNDERE", label: "Как у Мицуки", sort: 1 },
  { key: "ELEVENLABS_VOICE_YANDERE", label: "Как у Аи", sort: 2 }
] as const;

/**
 * At startup: offers the built-in characters' voices in the list and returns the voices that still
 * wait for a sample, so the caller queues one job per voice. Failed samples are retried only from
 * /admin, so a broken voice ID does not spend characters on every restart.
 */
export async function syncVoices(sql: Sql, config: WorkerConfig): Promise<string[]> {
  for (const { key, label, sort } of BUILT_IN_VOICES) {
    const parsed = elevenLabsVoiceIdSchema.safeParse(config[key]);
    if (parsed.success)
      await sql`insert into voices(id,label,sort) values(${parsed.data},${label},${sort})
        on conflict (id) do nothing`;
  }
  if (!config.ELEVENLABS_API_KEY) return [];
  const pending = await sql<{ id: string }[]>`
    select id from voices where sample is null and sample_status='pending' and enabled`;
  return pending.map(({ id }) => id);
}
