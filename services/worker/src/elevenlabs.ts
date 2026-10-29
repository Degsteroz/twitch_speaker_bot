// ElevenLabs usage as ElevenLabs itself counts it. The app reserves characters before every call
// (so two roasts at once cannot overshoot), but that count drifts: ElevenLabs resets on the day
// the subscription renews, not on the 1st, the plan may be smaller than the owner's cap, and a
// timed-out call may or may not have been billed. Every few minutes the worker reads the real
// usage and limit and corrects the counter; the cap the reservations use is the smaller of the
// owner's setting and the plan.
import { DEFAULT_ELEVENLABS_MONTHLY_CHAR_LIMIT, ELEVENLABS_PLAN_MARGIN } from "@roastbot/shared";
import { z } from "zod";

import type { WorkerConfig } from "./config.js";
import type { Sql } from "./context.js";

const SUBSCRIPTION_URL = "https://api.elevenlabs.io/v1/user/subscription";
const SYNC_TIMEOUT_MS = 10_000;

const subscriptionSchema = z.object({
  character_count: z.number().int().min(0),
  character_limit: z.number().int().min(0),
  next_character_count_reset_unix: z.number().int().nullish()
});

/** What the worker last read from ElevenLabs; stored in global_settings for the admin page. */
// A type alias, not an interface: postgres.js only takes index-signature types as JSON.
export type ElevenLabsSubscription = {
  used: number;
  limit: number;
  /** When ElevenLabs resets the count; null when it did not say. */
  resetAt: string | null;
  syncedAt: string;
};

const month = (now: Date) => now.toISOString().slice(0, 7);

/**
 * Reads ElevenLabs' own count and writes it over ours. Returns null without a key or when
 * ElevenLabs does not answer (the key may lack the "User: read" permission): the reservations
 * then go on with our own count and the owner's cap.
 */
export async function syncElevenLabsUsage(
  sql: Sql,
  config: WorkerConfig,
  fetcher: typeof globalThis.fetch = globalThis.fetch,
  now: Date = new Date()
): Promise<ElevenLabsSubscription | null> {
  if (!config.ELEVENLABS_API_KEY) return null;
  let parsed: z.infer<typeof subscriptionSchema>;
  try {
    const response = await fetcher(SUBSCRIPTION_URL, {
      headers: { "xi-api-key": config.ELEVENLABS_API_KEY },
      signal: AbortSignal.timeout(SYNC_TIMEOUT_MS)
    });
    if (!response.ok) throw new Error(`elevenlabs_subscription_${response.status}`);
    parsed = subscriptionSchema.parse(await response.json());
  } catch (error) {
    console.warn("ElevenLabs usage sync failed:", error instanceof Error ? error.message : error);
    return null;
  }
  const subscription: ElevenLabsSubscription = {
    used: parsed.character_count,
    limit: parsed.character_limit,
    resetAt: parsed.next_character_count_reset_unix
      ? new Date(parsed.next_character_count_reset_unix * 1000).toISOString()
      : null,
    syncedAt: now.toISOString()
  };
  await sql.begin(async (tx) => {
    await tx`
      insert into tts_usage_monthly(provider,month,requests)
      values('elevenlabs',${month(now)},${subscription.used})
      on conflict(provider,month) do update set requests=excluded.requests, updated_at=now()`;
    await tx`
      insert into global_settings(key,value) values('elevenlabs_subscription',${tx.json(subscription)})
      on conflict(key) do update set value=excluded.value, updated_at=now()`;
  });
  return subscription;
}

/** The cap reservations use: the owner's setting, never above the plan minus a margin. */
export async function elevenLabsCharLimit(sql: Sql): Promise<number> {
  const rows = await sql<{ key: string; value: unknown }[]>`
    select key, value from global_settings
    where key in ('elevenlabs_monthly_char_limit','elevenlabs_subscription')`;
  const value = (key: string) => rows.find((row) => row.key === key)?.value;
  const owner =
    (value("elevenlabs_monthly_char_limit") as number | undefined) ??
    DEFAULT_ELEVENLABS_MONTHLY_CHAR_LIMIT;
  const plan = value("elevenlabs_subscription") as ElevenLabsSubscription | undefined;
  return plan ? Math.min(owner, Math.max(0, plan.limit - ELEVENLABS_PLAN_MARGIN)) : owner;
}

/** Gives back characters of a call ElevenLabs refused: an error answer is not billed. */
export async function releaseElevenLabsCharacters(sql: Sql, now: Date, characters: number) {
  await sql`update tts_usage_monthly set requests=greatest(0, requests-${characters}), updated_at=now()
    where provider='elevenlabs' and month=${month(now)}`;
}
