import {
  classifierInput,
  classifierSystemPrompt,
  composeRoastPrompt,
  enforceOutputLimit,
  inspectInput,
  inspectOutput,
  parseClassifierVerdict
} from "@roastbot/prompts";
import {
  BLOCKED_OUTPUT_FALLBACK,
  DEFAULT_DEMO_DAILY_LIMIT,
  DEFAULT_ECONOMY_MODEL,
  DEFAULT_MONTHLY_BUDGET_USD,
  DEFAULT_YANDEX_TTS_MONTHLY_LIMIT_RUB,
  demoJobSchema,
  type DemoStatus
} from "@roastbot/shared";

import { modelRequest } from "./models.js";
import {
  costOf,
  demoSpendSql,
  globalValue,
  reserveYandexRequests,
  storeAudio,
  textFrom,
  type PipelineDependencies
} from "./pipeline.js";
import { speak } from "./tts.js";

// Ai on the landing page: a mild yandere at toxicity 2, voiced by Yandex only.
const DEMO_TOXICITY = 2;
// A visitor waits on the page; an older request is not worth the money.
const DEMO_STALE_MS = 60_000;

export interface DemoOutcome {
  demoId: string;
  status: DemoStatus;
  reason?: string;
}

/**
 * One landing demo answer through the same moderation as a roast: stop list and injection check
 * before the model, output checks and the classifier after. The cheap model of the free plan
 * writes it, Yandex voices it within its cap, Piper is never used. The cost joins the monthly
 * budget; a redelivered job does nothing.
 */
export async function processDemo(
  rawJob: unknown,
  deps: PipelineDependencies
): Promise<DemoOutcome> {
  const { demoId } = demoJobSchema.parse(rawJob);
  const clock = () => deps.now?.() ?? new Date();
  const spends: Parameters<typeof costOf>[0][] = [];
  const spent = () => spends.reduce((sum, spend) => sum + costOf(spend), 0);
  const settle = async (
    status: DemoStatus,
    reason?: string,
    extra: { output?: string; audioFile?: string } = {}
  ): Promise<DemoOutcome> => {
    await deps.sql`update demo_requests set status=${status}, error=${reason ?? null},
      output_text=${extra.output ?? null}, audio_file=${extra.audioFile ?? null},
      cost_usd=${spent()} where id=${demoId}`;
    return { demoId, status, ...(reason ? { reason } : {}) };
  };

  const [row] = await deps.sql<{ text: string | null; status: DemoStatus; createdAt: Date }[]>`
    select input_text "text", status, created_at "createdAt" from demo_requests
    where id=${demoId}`;
  if (!row) return { demoId, status: "skipped", reason: "not_found" };
  if (row.status !== "queued") return { demoId, status: row.status };
  try {
    if (clock().getTime() - row.createdAt.getTime() > DEMO_STALE_MS) {
      return await settle("skipped", "stale_job");
    }
    if (await globalValue<boolean>(deps.sql, "kill_switch", false)) {
      return await settle("skipped", "global_kill_switch");
    }
    if ((await globalValue<number>(deps.sql, "demo_daily_limit", DEFAULT_DEMO_DAILY_LIMIT)) <= 0) {
      return await settle("skipped", "demo_disabled");
    }
    const month = clock().toISOString().slice(0, 7);
    const [budget] = await deps.sql<{ spent: number; budget: number }[]>`
      select (coalesce(sum(cost_usd),0) + ${demoSpendSql(deps.sql, month)})::float8 spent,
        coalesce((select (value #>> '{}')::float8 from global_settings
          where key='monthly_budget_usd'), ${DEFAULT_MONTHLY_BUDGET_USD})::float8 budget
      from usage_monthly where month=${month}`;
    if ((budget?.spent ?? 0) >= (budget?.budget ?? DEFAULT_MONTHLY_BUDGET_USD)) {
      return await settle("skipped", "global_budget_exceeded");
    }

    const text = row.text ?? "";
    const stopWords = await globalValue<string[]>(deps.sql, "global_stop_words", []);
    const verdict = inspectInput("зритель", text, stopWords);
    if (!verdict.allowed) return await settle("blocked", verdict.reason);

    const [plan] = await deps.sql<{ model: string }[]>`
      select economy_model "model" from plans where code='free'`;
    const model = plan?.model ?? DEFAULT_ECONOMY_MODEL;
    const classifierModel = await globalValue(deps.sql, "classifier_model", model);
    const prompt = composeRoastPrompt({
      viewer: "зритель",
      message: text,
      tone: "yandere",
      toxicity: DEMO_TOXICITY,
      target: "viewer"
    });
    const generated = await deps.anthropic.beta.messages.create(
      modelRequest(model, "generate", prompt.system, prompt.user)
    );
    spends.push({
      model: generated.model || model,
      tokensIn: generated.usage.input_tokens,
      tokensOut: generated.usage.output_tokens
    });
    let output = enforceOutputLimit(textFrom(generated));
    let blockReason: string | undefined;
    if (generated.stop_reason === "refusal") blockReason = "model_refusal";
    else if (!output) blockReason = "empty_output";
    else {
      const outputVerdict = inspectOutput(output, text, stopWords, DEMO_TOXICITY);
      if (!outputVerdict.allowed) blockReason = outputVerdict.reason;
      else {
        const classified = await deps.anthropic.beta.messages.create(
          modelRequest(
            classifierModel,
            "classify",
            classifierSystemPrompt(DEMO_TOXICITY),
            classifierInput(output)
          )
        );
        spends.push({
          model: classified.model || classifierModel,
          tokensIn: classified.usage.input_tokens,
          tokensOut: classified.usage.output_tokens
        });
        if (
          classified.stop_reason === "refusal" ||
          parseClassifierVerdict(textFrom(classified)) === "block"
        ) {
          blockReason = "classifier_block";
        }
      }
    }
    if (blockReason) output = BLOCKED_OUTPUT_FALLBACK;

    const yandexLimitRub = await globalValue<number>(
      deps.sql,
      "yandex_tts_monthly_limit_rub",
      DEFAULT_YANDEX_TTS_MONTHLY_LIMIT_RUB
    );
    const speech = await speak(
      output,
      "yandere",
      deps.config,
      deps.fetch ?? globalThis.fetch,
      {
        yandex: (requests) => reserveYandexRequests(deps.sql, clock(), requests, yandexLimitRub),
        // The demo never uses ElevenLabs: best is Yandex.
        elevenlabs: () => Promise.resolve(false)
      },
      { best: "yandex", piper: false }
    );
    if (speech?.costUsd) {
      spends.push({
        model: `tts:${speech.provider}`,
        tokensIn: 0,
        tokensOut: 0,
        fixedUsd: speech.costUsd
      });
    }
    const audioFile = speech ? await storeAudio(speech.audio, deps.config.AUDIO_DIR) : undefined;
    return await settle(blockReason ? "blocked" : "done", blockReason, {
      output,
      ...(audioFile ? { audioFile } : {})
    });
  } catch (error) {
    // Money already spent on a failed answer still counts toward the budget.
    await settle("failed", error instanceof Error ? error.message.slice(0, 500) : "unknown");
    throw error;
  }
}
