import { createDatabase } from "@roastbot/db";
import { startTestDatabase, type TestDatabase } from "@roastbot/testing";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import type { WorkerConfig } from "./config.js";
import { elevenLabsCharLimit, syncElevenLabsUsage } from "./elevenlabs.js";
import { reserveElevenLabsCharacters } from "./limits.js";
import { speak } from "./tts.js";

let db: TestDatabase;
let worker: ReturnType<typeof createDatabase>;

const config: WorkerConfig = {
  DATABASE_URL: "postgres://unused",
  ANTHROPIC_API_KEY: "test",
  TTS_URL: "http://tts.test",
  ELEVENLABS_MODEL: "eleven_v4",
  AUDIO_DIR: "/tmp/unused",
  ELEVENLABS_API_KEY: "el-key",
  ELEVENLABS_VOICE_TSUNDERE: "voice-mitsuki"
};
const now = new Date("2026-10-27T12:00:00Z");

beforeAll(async () => {
  db = await startTestDatabase();
  worker = createDatabase(db.url, { applicationName: "elevenlabs-test" });
}, 120_000);

afterAll(async () => {
  await worker?.close();
  await db?.stop();
});

beforeEach(async () => {
  await db.sql`delete from tts_usage_monthly`;
  await db.sql`delete from global_settings where key='elevenlabs_subscription'`;
  await db.sql`update global_settings set value='70000'::jsonb
    where key='elevenlabs_monthly_char_limit'`;
});

const used = async () => {
  const [row] = await db.sql<{ requests: number }[]>`
    select requests from tts_usage_monthly where provider='elevenlabs' and month='2026-10'`;
  return row?.requests ?? 0;
};

const subscription = (body: unknown, status = 200) =>
  vi.fn(() => Promise.resolve(new Response(JSON.stringify(body), { status })));

describe("ElevenLabs usage sync", () => {
  it("writes ElevenLabs' own count over ours and keeps the cap below the plan", async () => {
    await reserveElevenLabsCharacters(worker.client, now, 40_230, 70_000);
    const fetcher = subscription({
      character_count: 16_086,
      character_limit: 40_000,
      next_character_count_reset_unix: 1_794_700_800
    });

    const synced = await syncElevenLabsUsage(worker.client, config, fetcher, now);

    expect(fetcher).toHaveBeenCalledWith(
      "https://api.elevenlabs.io/v1/user/subscription",
      expect.objectContaining({ headers: { "xi-api-key": "el-key" } })
    );
    expect(synced).toMatchObject({ used: 16_086, limit: 40_000 });
    expect(synced!.resetAt).toBe(new Date(1_794_700_800 * 1000).toISOString());
    expect(await used()).toBe(16_086);
    // The owner's 70,000 is above the 40,000 plan: the plan minus the margin wins.
    expect(await elevenLabsCharLimit(worker.client)).toBe(39_000);
    // A lower owner cap still wins over the plan.
    await db.sql`update global_settings set value='20000'::jsonb
      where key='elevenlabs_monthly_char_limit'`;
    expect(await elevenLabsCharLimit(worker.client)).toBe(20_000);
  });

  it("keeps our own count and the owner's cap when ElevenLabs does not answer", async () => {
    await reserveElevenLabsCharacters(worker.client, now, 500, 70_000);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    expect(await syncElevenLabsUsage(worker.client, config, subscription({}, 401), now)).toBeNull();
    expect(
      await syncElevenLabsUsage(worker.client, config, subscription({ unexpected: 1 }), now)
    ).toBeNull();
    warn.mockRestore();
    expect(await used()).toBe(500);
    expect(await elevenLabsCharLimit(worker.client)).toBe(70_000);
    // No key: nothing to ask.
    const fetcher = subscription({});
    expect(
      await syncElevenLabsUsage(
        worker.client,
        { ...config, ELEVENLABS_API_KEY: undefined },
        fetcher,
        now
      )
    ).toBeNull();
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("gives back the characters of a call ElevenLabs refused, not of a timeout", async () => {
    const reservations = {
      yandex: () => Promise.resolve(false),
      elevenlabs: (characters: number) =>
        reserveElevenLabsCharacters(worker.client, now, characters, 70_000),
      releaseElevenlabs: async (characters: number) => {
        await worker.client`update tts_usage_monthly set requests=requests-${characters}
          where provider='elevenlabs' and month='2026-10'`;
      }
    };
    const options = { piper: false as const, yandex: false, log: () => undefined };
    const refused = vi.fn(() => Promise.resolve(new Response("quota", { status: 401 })));
    expect(await speak("Привет", "tsundere", config, refused, reservations, options)).toBeNull();
    expect(await used()).toBe(0);

    const timedOut = vi.fn(() => Promise.reject(new DOMException("timeout", "TimeoutError")));
    expect(await speak("Привет", "tsundere", config, timedOut, reservations, options)).toBeNull();
    // A timed-out call may have been billed: it stays counted until the next sync.
    expect(await used()).toBe("Привет".length);
  });
});
