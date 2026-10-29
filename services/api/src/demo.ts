// Landing demo. Anyone may try Ai without logging in: DEMO_PER_IP_DAILY answers per IP and a
// daily cap for the service. The IP is stored only as an HMAC with the day, so it cannot be read
// back.
import { createHmac } from "node:crypto";

import {
  DEFAULT_DEMO_DAILY_LIMIT,
  DEMO_PER_IP_DAILY,
  DEMO_REQUESTED_QUEUE,
  demoRequestSchema
} from "@roastbot/shared";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";

import { currentDay, denied, type RouteContext } from "./context.js";
import { signAudioPath } from "./security.js";

export function registerDemoRoutes(app: FastifyInstance, context: RouteContext) {
  const { sql, boss, config } = context;

  const demoKey = (request: FastifyRequest, day: string) =>
    createHmac("sha256", config.SESSION_SECRET).update(`demo:${day}:${request.ip}`).digest("hex");
  const demoLimit = async () => {
    const [row] = await sql<{ limit: number }[]>`
      select coalesce((select (value #>> '{}')::int from global_settings
        where key='demo_daily_limit'), ${DEFAULT_DEMO_DAILY_LIMIT})::int "limit"`;
    return row?.limit ?? DEFAULT_DEMO_DAILY_LIMIT;
  };

  app.get("/demo", async (request) => {
    const day = currentDay();
    const limit = await demoLimit();
    const [usage] = await sql<{ mine: number; total: number }[]>`
      select count(*) filter (where ip_hash=${demoKey(request, day)})::int mine,
        count(*)::int total from demo_requests where day=${day}`;
    const remaining =
      (usage?.total ?? 0) >= limit ? 0 : Math.max(0, DEMO_PER_IP_DAILY - (usage?.mine ?? 0));
    return { enabled: limit > 0, remaining, perDay: DEMO_PER_IP_DAILY };
  });

  app.post("/demo", async (request, reply) => {
    const { text } = demoRequestSchema.parse(request.body);
    const day = currentDay();
    const ipHash = demoKey(request, day);
    const limit = await demoLimit();
    if (limit <= 0) return denied(reply, 404, "demo_disabled", "Демо сейчас выключено");
    const result = await sql.begin(async (tx) => {
      // One lock for both counters: parallel requests cannot slip past either cap.
      await tx`select pg_advisory_xact_lock(hashtext('roastbot-demo'))`;
      const [usage] = await tx<{ mine: number; total: number }[]>`
        select count(*) filter (where ip_hash=${ipHash})::int mine, count(*)::int total
        from demo_requests where day=${day}`;
      if ((usage?.mine ?? 0) >= DEMO_PER_IP_DAILY) return "ip_limit" as const;
      if ((usage?.total ?? 0) >= limit) return "service_limit" as const;
      const [row] = await tx<{ id: string }[]>`
        insert into demo_requests(ip_hash,day,input_text) values(${ipHash},${day},${text})
        returning id`;
      return row!.id;
    });
    if (result === "ip_limit") {
      return denied(reply, 429, "demo_limit", "На сегодня всё. Завтра Аи ответит снова.");
    }
    if (result === "service_limit") {
      return denied(reply, 429, "demo_busy", "Аи на сегодня наговорилась. Загляните завтра.");
    }
    await boss.send(DEMO_REQUESTED_QUEUE, { demoId: result });
    return { id: result, status: "queued" };
  });

  app.get("/demo/:id", async (request, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    // Only from the same IP and day that asked: a leaked id shows nothing to others.
    const [row] = await sql<
      { status: string; output: string | null; audioFile: string | null; createdAt: Date }[]
    >`
      select status, output_text "output", audio_file "audioFile", created_at "createdAt"
      from demo_requests where id=${id} and ip_hash=${demoKey(request, currentDay())}`;
    if (!row) return denied(reply, 404, "not_found", "Ответ не найден");
    return {
      status: row.status,
      text: row.status === "done" || row.status === "blocked" ? row.output : null,
      audioUrl: row.audioFile
        ? `${config.PUBLIC_URL}${signAudioPath(row.audioFile, config.AUDIO_SIGNING_SECRET)}`
        : null
    };
  });
}
