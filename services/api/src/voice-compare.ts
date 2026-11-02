// The owner's voice comparison: one phrase from Mitsuki and Ai in ElevenLabs, Inworld and Yandex,
// recorded by the worker (voice.compare) and played side by side in /admin.
import {
  VOICE_COMPARE_PROVIDERS,
  VOICE_COMPARE_QUEUE,
  VOICE_COMPARE_TONES,
  VOICE_SAMPLE_TEXT,
  voiceCompareJobSchema
} from "@roastbot/shared";
import type { FastifyInstance } from "fastify";
import { z } from "zod";

import { denied, type RouteContext } from "./context.js";

const compareParams = z.object({
  tone: z.enum(VOICE_COMPARE_TONES),
  provider: z.enum(VOICE_COMPARE_PROVIDERS)
});

export function registerVoiceCompareRoutes(app: FastifyInstance, context: RouteContext) {
  const { sql, boss, requireOwner, audit } = context;

  app.get("/admin/voice-compare", { preHandler: requireOwner }, async () => ({
    defaultText: VOICE_SAMPLE_TEXT,
    rows: await sql`select tone, provider, text, status, updated_at "updatedAt"
      from voice_compare order by tone, provider`
  }));

  app.post("/admin/voice-compare", { preHandler: requireOwner }, async (request) => {
    const { text } = voiceCompareJobSchema.parse({
      text: VOICE_SAMPLE_TEXT,
      ...(request.body as object)
    });
    await sql.begin(async (tx) => {
      for (const tone of VOICE_COMPARE_TONES) {
        for (const provider of VOICE_COMPARE_PROVIDERS) {
          await tx`insert into voice_compare(tone,provider,text,status,audio)
            values(${tone},${provider},${text},'pending',null)
            on conflict(tone,provider) do update set text=excluded.text, status='pending',
              audio=null, updated_at=now()`;
        }
      }
      await audit(tx, request, "voice.compare", "voices", { text });
    });
    await boss.send(VOICE_COMPARE_QUEUE, { text });
    return { status: "pending" };
  });

  app.get(
    "/admin/voice-compare/:tone/:provider",
    { preHandler: requireOwner },
    async (request, reply) => {
      const { tone, provider } = compareParams.parse(request.params);
      const [row] = await sql<{ audio: Buffer | null }[]>`
        select audio from voice_compare where tone=${tone} and provider=${provider}
          and status='ready'`;
      if (!row?.audio) return denied(reply, 404, "not_found", "Записи нет");
      return reply
        .header("Cache-Control", "no-store")
        .header("X-Content-Type-Options", "nosniff")
        .type("audio/wav")
        .send(row.audio);
    }
  );
}
