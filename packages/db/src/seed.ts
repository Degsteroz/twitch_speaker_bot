import {
  DEFAULT_ANTHROPIC_MODEL,
  DEFAULT_CHAT_MODEL,
  DEFAULT_CLASSIFIER_MODEL,
  DEFAULT_ELEVENLABS_MONTHLY_CHAR_LIMIT,
  DEFAULT_CHANNEL_MONTHLY_ROASTS,
  DEFAULT_DEMO_DAILY_LIMIT,
  DEFAULT_DEMO_ELEVENLABS_MONTHLY_CHAR_LIMIT,
  DEFAULT_SIGNUP_DAILY_LIMIT,
  DEFAULT_SIGNUP_MIN_ACCOUNT_AGE_DAYS,
  DEFAULT_GLOBAL_MONTHLY_ROAST_CAP,
  DEFAULT_INWORLD_MONTHLY_CHAR_LIMIT,
  DEFAULT_MONTHLY_BUDGET_USD,
  DEFAULT_YANDEX_TTS_MONTHLY_LIMIT_RUB,
  FREE_PREMIUM_ROASTS
} from "@roastbot/shared";
import { sql } from "drizzle-orm";

import { createDatabase } from "./client.js";
import { globalSettings, plans } from "./schema.js";

export async function seedDatabase(
  databaseUrl: string,
  model = process.env["ANTHROPIC_MODEL"] || DEFAULT_ANTHROPIC_MODEL
): Promise<void> {
  const database = createDatabase(databaseUrl, { applicationName: "roastbot-seed" });

  try {
    await database.db
      .insert(plans)
      .values([
        {
          code: "free",
          monthlyRoastLimit: DEFAULT_CHANNEL_MONTHLY_ROASTS,
          monthlyTtsLimit: 20_000,
          // The first roasts of the month show the good voice, the rest go to Yandex.
          premiumRoasts: FREE_PREMIUM_ROASTS
        },
        // Good roasts, the total with the Yandex ones after them, and the price: see 0022.
        {
          code: "basic",
          monthlyRoastLimit: 700,
          monthlyTtsLimit: 60_000,
          premiumRoasts: 500,
          starsPrice: 300
        },
        {
          code: "premium",
          monthlyRoastLimit: 1_500,
          monthlyTtsLimit: 300_000,
          premiumRoasts: 1_000,
          starsPrice: 600
        }
      ])
      // Every plan number is the owner's in /admin: the upsert only refreshes the TTS limit.
      .onConflictDoUpdate({
        target: plans.code,
        set: { monthlyTtsLimit: sql`excluded.monthly_tts_limit` }
      });

    const defaults = [
      { key: "global_monthly_limit", value: DEFAULT_GLOBAL_MONTHLY_ROAST_CAP },
      { key: "kill_switch", value: false },
      { key: "monthly_budget_usd", value: DEFAULT_MONTHLY_BUDGET_USD },
      { key: "model", value: model },
      {
        key: "classifier_model",
        value: process.env["CLASSIFIER_MODEL"] || DEFAULT_CLASSIFIER_MODEL
      },
      { key: "chat_model", value: DEFAULT_CHAT_MODEL },
      { key: "global_stop_words", value: [] },
      { key: "input_retention_days", value: 30 },
      { key: "yandex_tts_monthly_limit_rub", value: DEFAULT_YANDEX_TTS_MONTHLY_LIMIT_RUB },
      { key: "elevenlabs_monthly_char_limit", value: DEFAULT_ELEVENLABS_MONTHLY_CHAR_LIMIT },
      { key: "inworld_monthly_char_limit", value: DEFAULT_INWORLD_MONTHLY_CHAR_LIMIT },
      { key: "demo_daily_limit", value: DEFAULT_DEMO_DAILY_LIMIT },
      { key: "demo_elevenlabs_char_limit", value: DEFAULT_DEMO_ELEVENLABS_MONTHLY_CHAR_LIMIT },
      { key: "signup_daily_limit", value: DEFAULT_SIGNUP_DAILY_LIMIT },
      { key: "signup_min_account_age_days", value: DEFAULT_SIGNUP_MIN_ACCOUNT_AGE_DAYS }
    ];

    for (const setting of defaults) {
      await database.db
        .insert(globalSettings)
        .values(setting)
        .onConflictDoNothing({ target: globalSettings.key });
    }
  } finally {
    await database.close();
  }
}

if (process.argv[1] && import.meta.url === new URL(process.argv[1], "file:").href) {
  const databaseUrl = process.env["DATABASE_URL"];
  if (!databaseUrl) throw new Error("DATABASE_URL is required");
  await seedDatabase(databaseUrl);
}
