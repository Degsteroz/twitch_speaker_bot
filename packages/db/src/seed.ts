import {
  DEFAULT_ANTHROPIC_MODEL,
  DEFAULT_CHANNEL_MONTHLY_ROASTS,
  DEFAULT_GLOBAL_MONTHLY_ROAST_CAP,
  DEFAULT_MONTHLY_BUDGET_USD
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
          monthlyTtsLimit: 20_000
        },
        { code: "basic", monthlyRoastLimit: 1_000, monthlyTtsLimit: 200_000 },
        { code: "premium", monthlyRoastLimit: 5_000, monthlyTtsLimit: 1_000_000 }
      ])
      .onConflictDoUpdate({
        target: plans.code,
        set: {
          monthlyRoastLimit: sql`excluded.monthly_roast_limit`,
          monthlyTtsLimit: sql`excluded.monthly_tts_limit`
        }
      });

    const defaults = [
      { key: "global_monthly_limit", value: DEFAULT_GLOBAL_MONTHLY_ROAST_CAP },
      { key: "kill_switch", value: false },
      { key: "monthly_budget_usd", value: DEFAULT_MONTHLY_BUDGET_USD },
      { key: "model", value: model },
      { key: "classifier_model", value: model },
      { key: "global_stop_words", value: [] },
      { key: "input_retention_days", value: 30 }
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
