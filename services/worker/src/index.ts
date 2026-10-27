import { readdir, stat, unlink } from "node:fs/promises";
import { join } from "node:path";

import Anthropic from "@anthropic-ai/sdk";
import { cleanupExpiredData, createDatabase } from "@roastbot/db";
import {
  DEMO_REQUESTED_QUEUE,
  DEMO_REQUESTED_QUEUE_OPTIONS,
  ROAST_REQUESTED_QUEUE,
  ROAST_REQUESTED_QUEUE_OPTIONS,
  TELEGRAM_NOTIFY_QUEUE,
  telegramNotifyJobSchema,
  VOICE_SAMPLE_QUEUE
} from "@roastbot/shared";
import { PgBoss } from "pg-boss";

import { loadConfig } from "./config.js";
import { processDemo } from "./demo.js";
import { syncElevenLabsUsage } from "./elevenlabs.js";
import { notifyStreamer, sendStreamSummaries } from "./telegram.js";
import { processRoast } from "./pipeline.js";
import { recordVoiceSample, syncVoices } from "./voices.js";

// Audio stays on disk well past the 2-minute overlay TTL plus the 60-second signed URL window.
const AUDIO_MAX_AGE_MS = 10 * 60 * 1000;

const config = loadConfig();
const database = createDatabase(config.DATABASE_URL, { applicationName: "roastbot-worker" });
const boss = new PgBoss({ connectionString: config.DATABASE_URL, useListenNotify: true });
// The SDK retries 429/5xx itself; keep the whole call short enough for a live stream.
const anthropic = new Anthropic({
  apiKey: config.ANTHROPIC_API_KEY,
  timeout: 20_000,
  maxRetries: 1
});

boss.on("error", (error) => console.error("pg-boss:", error));
await boss.start();
await boss.createQueue(ROAST_REQUESTED_QUEUE, { ...ROAST_REQUESTED_QUEUE_OPTIONS });
// createQueue is a no-op for an existing queue; updateQueue applies changed options on upgrade.
await boss.updateQueue(ROAST_REQUESTED_QUEUE, { ...ROAST_REQUESTED_QUEUE_OPTIONS });
const workOptions = { batchSize: 1, localConcurrency: 1, pollingIntervalSeconds: 0.5 };
await boss.work(ROAST_REQUESTED_QUEUE, workOptions, async (jobs) => {
  for (const job of jobs) {
    const outcome = await processRoast(job.data, { sql: database.client, anthropic, config });
    console.log(JSON.stringify({ msg: "roast.processed", ...outcome }));
  }
});

// The landing demo has its own queue, so a burst of visitors never delays a roast on stream.
await boss.createQueue(DEMO_REQUESTED_QUEUE, { ...DEMO_REQUESTED_QUEUE_OPTIONS });
await boss.work(DEMO_REQUESTED_QUEUE, workOptions, async (jobs) => {
  for (const job of jobs) {
    const outcome = await processDemo(job.data, { sql: database.client, anthropic, config });
    console.log(JSON.stringify({ msg: "demo.processed", ...outcome }));
  }
});

// Samples of the voices the owner offers for premium characters.
await boss.createQueue(VOICE_SAMPLE_QUEUE);
await boss.work(VOICE_SAMPLE_QUEUE, async (jobs) => {
  for (const job of jobs) {
    const status = await recordVoiceSample(job.data, { sql: database.client, config });
    console.log(JSON.stringify({ msg: "voice.sample", status }));
  }
});
for (const voiceId of await syncVoices(database.client, config))
  await boss.send(VOICE_SAMPLE_QUEUE, { voiceId }, { singletonKey: voiceId });

// The streamer's Telegram: notifications queued by other services, and the summary after a stream.
await boss.createQueue(TELEGRAM_NOTIFY_QUEUE);
await boss.work(TELEGRAM_NOTIFY_QUEUE, async (jobs) => {
  for (const job of jobs) {
    await notifyStreamer(database.client, config, telegramNotifyJobSchema.parse(job.data));
  }
});
if (config.TELEGRAM_BOT_TOKEN) {
  await boss.createQueue("stream.summary");
  await boss.schedule("stream.summary", "*/15 * * * *");
  await boss.work("stream.summary", async () => {
    const sent = await sendStreamSummaries(database.client, config);
    if (sent) console.log(JSON.stringify({ msg: "stream.summary", sent }));
  });
}

// ElevenLabs' own usage and plan limit over our count: it resets on the renewal day, not the 1st.
if (config.ELEVENLABS_API_KEY) {
  await syncElevenLabsUsage(database.client, config);
  await boss.createQueue("elevenlabs.sync");
  await boss.schedule("elevenlabs.sync", "*/5 * * * *");
  await boss.work("elevenlabs.sync", async () => {
    await syncElevenLabsUsage(database.client, config);
  });
}

await boss.createQueue("maintenance.cleanup");
await boss.schedule("maintenance.cleanup", "*/10 * * * *");
await boss.work("maintenance.cleanup", async () => {
  const retention = await database.client<{ days: number }[]>`
    select coalesce((select (value #>> '{}')::int from global_settings
      where key='input_retention_days'),30)::int days`;
  const result = await cleanupExpiredData(database.db, new Date(), retention[0]?.days ?? 30);
  const cutoff = Date.now() - AUDIO_MAX_AGE_MS;
  let deletedAudio = 0;
  for (const filename of await readdir(config.AUDIO_DIR).catch(() => [])) {
    if (!filename.endsWith(".wav") && !filename.endsWith(".tmp")) continue;
    const path = join(config.AUDIO_DIR, filename);
    const metadata = await stat(path).catch(() => null);
    if (metadata && metadata.mtimeMs < cutoff) {
      await unlink(path).then(
        () => deletedAudio++,
        () => undefined
      );
    }
  }
  console.log(JSON.stringify({ msg: "maintenance.cleanup", ...result, deletedAudio }));
});

if (config.TELEGRAM_BOT_TOKEN && config.TELEGRAM_CHAT_ID) {
  await boss.createQueue("summary.daily");
  await boss.schedule("summary.daily", "0 9 * * *");
  const dashboard = config.DASHBOARD_URL?.replace(/\/$/u, "");
  await boss.work("summary.daily", async () => {
    const [stats] = await database.client<
      { roasts: number; failed: number; blocked: number; cost: string; month: string }[]
    >`
      select count(*) filter (where status in ('done','blocked_output'))::int roasts,
        count(*) filter (where status='failed')::int failed,
        count(*) filter (where status in ('blocked_input','blocked_output'))::int blocked,
        coalesce(sum(cost_usd),0)::text cost,
        (select coalesce(sum(cost_usd),0)::text from usage_monthly
          where month=to_char(now(),'YYYY-MM')) month
      from roasts where created_at>=current_date-interval '1 day' and created_at<current_date`;
    const response = await fetch(
      `https://api.telegram.org/bot${config.TELEGRAM_BOT_TOKEN}/sendMessage`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          chat_id: config.TELEGRAM_CHAT_ID,
          text: [
            "RoastBot за вчера:",
            `роастов: ${String(stats?.roasts ?? 0)}`,
            `ошибок: ${String(stats?.failed ?? 0)}`,
            `заблокировано: ${String(stats?.blocked ?? 0)}`,
            `расход: $${stats?.cost ?? "0"} (за месяц $${stats?.month ?? "0"})`,
            ...(dashboard
              ? [
                  "",
                  `ошибки: ${dashboard}/admin/roasts?status=failed`,
                  `модерация: ${dashboard}/admin/moderation`
                ]
              : [])
          ].join("\n")
        })
      }
    );
    if (!response.ok) throw new Error(`telegram_${response.status}`);
  });
}

async function shutdown() {
  await boss.stop();
  await database.close();
}
process.once("SIGINT", () => void shutdown().finally(() => process.exit(0)));
process.once("SIGTERM", () => void shutdown().finally(() => process.exit(0)));
