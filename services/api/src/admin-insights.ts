// Back-office insights the owner used to get from SQL on the server: where the month's money went
// and why roasts did not play (/admin/spend), and how the server itself is doing (/admin/server).
// Both are read on request only: no background work on the small VPS.
import { statfs, readdir, stat } from "node:fs/promises";
import { cpus, freemem, loadavg, totalmem, uptime } from "node:os";
import { join } from "node:path";

import { DEFAULT_MONTHLY_BUDGET_USD, ELEVENLABS_USD_PER_CHARACTER } from "@roastbot/shared";
import type { FastifyInstance } from "fastify";
import { z } from "zod";

import { currentMonth, demoSpend, type RouteContext } from "./context.js";

const monthQuery = z.object({
  month: z
    .string()
    .regex(/^\d{4}-(0[1-9]|1[0-2])$/u)
    .optional()
});
// The audio folder is cleaned every few minutes; counting more files than this is not worth it.
const AUDIO_FILES_COUNTED = 5_000;

/** Bytes and files in the audio folder, up to AUDIO_FILES_COUNTED; null when it cannot be read. */
async function folderSize(path: string) {
  try {
    const names = (await readdir(path)).slice(0, AUDIO_FILES_COUNTED);
    let bytes = 0;
    for (const name of names) {
      const info = await stat(join(path, name)).catch(() => undefined);
      if (info?.isFile()) bytes += info.size;
    }
    return { bytes, files: names.length };
  } catch {
    return null;
  }
}

export function registerAdminInsightRoutes(app: FastifyInstance, context: RouteContext) {
  const { sql, requireOwner, config } = context;

  app.get("/admin/spend", { preHandler: requireOwner }, async (request) => {
    const month = monthQuery.parse(request.query).month ?? currentMonth();
    const range = sql`created_at >= (${month}::text || '-01')::timestamp at time zone 'UTC'
      and created_at < ((${month}::text || '-01')::timestamp + interval '1 month') at time zone 'UTC'`;
    // What paid for what: real roasts by tier, model and voice; stubs, blocks and failures apart.
    const groups = await sql<
      {
        kind: string;
        tier: string | null;
        model: string | null;
        voice: string | null;
        count: number;
        usd: number;
        chars: number;
      }[]
    >`
      select case status when 'done' then 'roast' when 'skipped' then 'stub'
          when 'failed' then 'failed' else 'blocked' end kind,
        tier, model, voice_provider voice, count(*)::int count,
        coalesce(sum(cost_usd),0)::float8 usd, coalesce(sum(tts_chars),0)::int chars
      from roasts where ${range} and (status='done' or cost_usd>0)
      group by 1,2,3,4 order by usd desc`;
    const reasons = await sql<{ status: string; reason: string | null; count: number }[]>`
      select status, left(error, 80) reason, count(*)::int count
      from roasts where ${range} and status<>'done'
      group by 1,2 order by 3 desc limit 30`;
    const days = await sql<{ day: string; roasts: number; usd: number }[]>`
      select to_char(d.bucket,'YYYY-MM-DD') "day", coalesce(r.roasts,0)::int roasts,
        (coalesce(r.usd,0) + coalesce(x.usd,0))::float8 usd
      from (select date_trunc('day', created_at at time zone 'UTC') bucket from roasts where ${range}
            union select date_trunc('day', created_at at time zone 'UTC') from demo_requests
            where ${range}) d
      left join (select date_trunc('day', created_at at time zone 'UTC') bucket,
          count(*) filter (where status='done') roasts, sum(cost_usd) usd
        from roasts where ${range} group by 1) r on r.bucket=d.bucket
      left join (select date_trunc('day', created_at at time zone 'UTC') bucket, sum(cost_usd) usd
        from demo_requests where ${range} group by 1) x on x.bucket=d.bucket
      order by d.bucket`;
    const [totals] = await sql<{ usd: number; demoUsd: number; budget: number }[]>`
      select ((select coalesce(sum(cost_usd),0) from usage_monthly where month=${month})
          + ${demoSpend(sql, month)})::float8 usd,
        ${demoSpend(sql, month)}::float8 "demoUsd",
        coalesce((select (value #>> '{}')::float8 from global_settings where key='monthly_budget_usd'),
          ${DEFAULT_MONTHLY_BUDGET_USD})::float8 budget`;
    // ElevenLabs is a prepaid plan; the budget counts it at list price. Shown apart so the owner
    // sees what was really paid on top (Anthropic, Inworld, Yandex).
    const elevenLabsChars = groups
      .filter((group) => group.voice === "elevenlabs")
      .reduce((sum, group) => sum + group.chars, 0);
    return {
      month,
      groups,
      reasons,
      days,
      usd: totals?.usd ?? 0,
      demoUsd: totals?.demoUsd ?? 0,
      budget: totals?.budget ?? DEFAULT_MONTHLY_BUDGET_USD,
      elevenLabsUsd: elevenLabsChars * ELEVENLABS_USD_PER_CHARACTER
    };
  });

  app.get("/admin/server", { preHandler: requireOwner }, async () => {
    // A container sees the host's load, memory and the disk its volume lives on.
    const disk = await statfs(config.AUDIO_DIR).catch(() => undefined);
    const [database] = await sql<{ bytes: number }[]>`
      select pg_database_size(current_database())::float8 bytes`;
    const tables = await sql<{ name: string; bytes: number }[]>`
      select c.relname name, pg_total_relation_size(c.oid)::float8 bytes
      from pg_class c join pg_namespace n on n.oid=c.relnamespace
      where c.relkind='r' and n.nspname not in ('pg_catalog','information_schema')
      order by 2 desc limit 5`;
    return {
      load: loadavg().map((value) => Math.round(value * 100) / 100),
      cpus: cpus().length,
      memory: { total: totalmem(), free: freemem() },
      disk: disk ? { total: disk.blocks * disk.bsize, free: disk.bavail * disk.bsize } : null,
      database: database?.bytes ?? 0,
      tables,
      audio: await folderSize(config.AUDIO_DIR),
      uptimeSec: Math.round(uptime())
    };
  });
}
