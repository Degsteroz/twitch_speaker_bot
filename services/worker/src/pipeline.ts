import { randomBytes, randomUUID } from "node:crypto";
import { mkdir, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";

import type Anthropic from "@anthropic-ai/sdk";
import type { createDatabase } from "@roastbot/db";
import {
  CLASSIFIER_SYSTEM_PROMPT,
  calculateHaikuCostUsd,
  classifierInput,
  composeRoastPrompt,
  enforceOutputLimit,
  inspectInput,
  inspectOutput,
  parseClassifierVerdict,
  pricingForModel
} from "@roastbot/prompts";
import {
  BLOCKED_OUTPUT_FALLBACK,
  DEFAULT_ANTHROPIC_MODEL,
  DEFAULT_GLOBAL_MONTHLY_ROAST_CAP,
  DEFAULT_MONTHLY_BUDGET_USD,
  OVERLAY_EVENT_TTL_SECONDS,
  roastRequestedJobSchema,
  type RoastRequestedJob,
  type RoastStatus,
  type StoredOverlayRoast,
  type Tone,
  type Toxicity,
  type Voice
} from "@roastbot/shared";

import type { WorkerConfig } from "./config.js";

type Sql = ReturnType<typeof createDatabase>["client"];

interface ChannelContext {
  userStatus: string;
  enabled: boolean;
  tone: Tone;
  voice: Voice;
  toxicity: Toxicity;
  cooldownSec: number;
  userCooldownSec: number;
  stopWords: string[];
  monthlyLimit: number | null;
}

export interface PipelineDependencies {
  sql: Sql;
  anthropic: Anthropic;
  config: WorkerConfig;
  now?: () => Date;
  fetch?: typeof globalThis.fetch;
}

export interface RoastOutcome {
  roastId: string;
  status: RoastStatus;
  reason?: string;
}

interface Spend {
  model: string;
  tokensIn: number;
  tokensOut: number;
}

const GENERATION_MAX_TOKENS = 300;
const CLASSIFIER_MAX_TOKENS = 16;
const TTS_TIMEOUT_MS = 15_000;

function textFrom(message: Anthropic.Message): string {
  return message.content
    .flatMap((block) => (block.type === "text" ? [block.text] : []))
    .join(" ")
    .trim();
}

function costOf(spend: Spend): number {
  return calculateHaikuCostUsd(spend.tokensIn, spend.tokensOut, pricingForModel(spend.model));
}

async function globalValue<T>(sql: Sql, key: string, fallback: T): Promise<T> {
  const [row] = await sql<{ value: T }[]>`select value from global_settings where key=${key}`;
  return row?.value ?? fallback;
}

async function loadContext(sql: Sql, channelId: string): Promise<ChannelContext | undefined> {
  const [context] = await sql<ChannelContext[]>`
    select u.status "userStatus", s.enabled, s.tone, s.voice, s.toxicity,
      s.cooldown_sec "cooldownSec", s.user_cooldown_sec "userCooldownSec",
      s.stop_words "stopWords", p.monthly_roast_limit "monthlyLimit"
    from channels c join users u on u.id=c.user_id join settings s on s.channel_id=c.id
    left join lateral (
      select sub.plan_id from subscriptions sub
      where sub.user_id=u.id and (sub.valid_until is null or sub.valid_until>now())
      order by sub.created_at desc limit 1
    ) sub on true
    left join plans p on p.id=sub.plan_id
    where c.id=${channelId}`;
  return context;
}

function rejectionFor(context: ChannelContext | undefined): string | undefined {
  if (!context) return "channel_not_found";
  if (context.userStatus !== "active") return "user_suspended";
  if (!context.enabled) return "channel_disabled";
  if (context.monthlyLimit === null) return "no_active_plan";
  return undefined;
}

/**
 * Atomically checks every limit and books one roast against the quota and cooldowns.
 * Returns the rejection reason, or undefined when the roast may spend API money.
 */
async function reserve(
  deps: PipelineDependencies,
  job: RoastRequestedJob,
  monthlyLimit: number,
  context: ChannelContext
): Promise<string | undefined> {
  const month = (deps.now?.() ?? new Date()).toISOString().slice(0, 7);
  return deps.sql.begin(async (tx) => {
    await tx`select pg_advisory_xact_lock(hashtext('roastbot-global-quota'))`;
    const [killSwitch] = await tx<{ value: boolean }[]>`
      select value from global_settings where key='kill_switch'`;
    if (killSwitch?.value === true) return "global_kill_switch";

    const [limits] = await tx<{ roastCap: number; budget: number; used: number; spent: number }[]>`
      select
        coalesce((select (value #>> '{}')::int from global_settings where key='global_monthly_limit'),
          ${DEFAULT_GLOBAL_MONTHLY_ROAST_CAP})::int "roastCap",
        coalesce((select (value #>> '{}')::float8 from global_settings where key='monthly_budget_usd'),
          ${DEFAULT_MONTHLY_BUDGET_USD})::float8 budget,
        coalesce(sum(roasts),0)::int used, coalesce(sum(cost_usd),0)::float8 spent
      from usage_monthly where month=${month}`;
    if ((limits?.used ?? 0) >= (limits?.roastCap ?? DEFAULT_GLOBAL_MONTHLY_ROAST_CAP)) {
      return "global_quota_exceeded";
    }
    if ((limits?.spent ?? 0) >= (limits?.budget ?? DEFAULT_MONTHLY_BUDGET_USD)) {
      return "global_budget_exceeded";
    }

    const [usage] = await tx<{ roasts: number; gifted: number }[]>`
      select coalesce(um.roasts,0)::int roasts,
        coalesce((select sum(amount-used) from gifted_quota
          where channel_id=${job.channelId} and month=${month}),0)::int gifted
      from (select 1) x
      left join usage_monthly um on um.channel_id=${job.channelId} and um.month=${month}`;
    const used = usage?.roasts ?? 0;
    if (used >= monthlyLimit + (usage?.gifted ?? 0)) return "channel_quota_exceeded";

    if (job.source !== "dashboard_test") {
      const cooldowns = await tx<{ scope: string }[]>`
        select scope from cooldown_state where channel_id=${job.channelId} and next_allowed_at>now()
        and ((scope='channel' and subject_key='*') or (scope='viewer' and subject_key=${job.viewerLogin}))`;
      if (cooldowns.length) return "cooldown_active";
      await tx`
        insert into cooldown_state(channel_id,scope,subject_key,next_allowed_at) values
         (${job.channelId},'channel','*',now()+${context.cooldownSec}*interval '1 second'),
         (${job.channelId},'viewer',${job.viewerLogin},now()+${context.userCooldownSec}*interval '1 second')
        on conflict(channel_id,scope,subject_key)
        do update set next_allowed_at=excluded.next_allowed_at,updated_at=now()`;
    }

    if (used >= monthlyLimit) {
      const gifted = await tx`
        update gifted_quota set used=used+1 where id=(
          select id from gifted_quota where channel_id=${job.channelId} and month=${month}
          and used<amount order by created_at for update skip locked limit 1
        ) returning id`;
      if (!gifted.length) return "channel_quota_exceeded";
    }
    await tx`
      insert into usage_monthly(channel_id,month,roasts) values(${job.channelId},${month},1)
      on conflict(channel_id,month) do update set roasts=usage_monthly.roasts+1,updated_at=now()`;
    return undefined;
  });
}

async function synthesize(
  text: string,
  voice: Voice,
  config: WorkerConfig,
  fetcher: typeof globalThis.fetch
): Promise<Uint8Array> {
  const response = await fetcher(`${config.TTS_URL}/synth`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ text, voice }),
    signal: AbortSignal.timeout(TTS_TIMEOUT_MS)
  });
  if (!response.ok) throw new Error(`tts_failed_${response.status}`);
  return new Uint8Array(await response.arrayBuffer());
}

async function storeAudio(bytes: Uint8Array, audioDir: string): Promise<string> {
  const filename = `${randomUUID()}.wav`;
  await mkdir(audioDir, { recursive: true });
  const temporary = join(audioDir, `.${randomBytes(12).toString("hex")}.tmp`);
  await writeFile(temporary, bytes, { flag: "wx" });
  await rename(temporary, join(audioDir, filename));
  return filename;
}

async function recordSpend(sql: Sql, channelId: string, month: string, spends: Spend[]) {
  const tokensIn = spends.reduce((sum, spend) => sum + spend.tokensIn, 0);
  const tokensOut = spends.reduce((sum, spend) => sum + spend.tokensOut, 0);
  const cost = spends.reduce((sum, spend) => sum + costOf(spend), 0);
  await sql`insert into usage_monthly(channel_id,month,tokens_in,tokens_out,cost_usd)
    values(${channelId},${month},${tokensIn},${tokensOut},${cost})
    on conflict(channel_id,month) do update set tokens_in=usage_monthly.tokens_in+excluded.tokens_in,
      tokens_out=usage_monthly.tokens_out+excluded.tokens_out,
      cost_usd=usage_monthly.cost_usd+excluded.cost_usd,updated_at=now()`;
  return { tokensIn, tokensOut, cost };
}

export async function processRoast(
  rawJob: unknown,
  deps: PipelineDependencies
): Promise<RoastOutcome> {
  const started = Date.now();
  const clock = () => deps.now?.() ?? new Date();
  const job = roastRequestedJobSchema.parse(rawJob);
  const month = clock().toISOString().slice(0, 7);
  const spends: Spend[] = [];
  let roastId: string | undefined;

  const settle = async (status: RoastStatus, reason?: string): Promise<RoastOutcome> => {
    await deps.sql`update roasts set status=${status},error=${reason ?? null},
      latency_ms=${Date.now() - started} where id=${roastId!}`;
    return { roastId: roastId!, status, ...(reason ? { reason } : {}) };
  };

  try {
    const [inserted] = await deps.sql<{ id: string }[]>`
      insert into roasts(channel_id,event_id,source,viewer_login,input_text,tone,voice,toxicity)
      select ${job.channelId},${job.eventId},${job.source},${job.viewerLogin},${job.inputText},
        tone,voice,toxicity from settings where channel_id=${job.channelId}
      on conflict(event_id) do nothing returning id`;
    if (inserted) roastId = inserted.id;
    else {
      const [existing] = await deps.sql<{ id: string; status: RoastStatus }[]>`
        select id,status from roasts where event_id=${job.eventId}`;
      if (!existing) throw new Error("roast_insert_failed");
      roastId = existing.id;
      // A redelivered job must never spend quota or API money twice.
      if (existing.status !== "queued") return { roastId, status: existing.status };
    }

    if (clock().getTime() - Date.parse(job.requestedAt) > OVERLAY_EVENT_TTL_SECONDS * 1000) {
      return await settle("skipped", "stale_job");
    }
    const context = await loadContext(deps.sql, job.channelId);
    const rejection = rejectionFor(context);
    if (rejection || !context) return await settle("skipped", rejection);
    if (await globalValue<boolean>(deps.sql, "kill_switch", false)) {
      return await settle("skipped", "global_kill_switch");
    }

    const globalWords = await globalValue<string[]>(deps.sql, "global_stop_words", []);
    const stopWords = [...globalWords, ...context.stopWords];
    // Nickname, message and injection checks: a rejected request costs neither quota nor money.
    const inputVerdict = inspectInput(job.viewerLogin, job.inputText, stopWords);
    if (!inputVerdict.allowed) return await settle("blocked_input", inputVerdict.reason);

    const reservation = await reserve(deps, job, context.monthlyLimit!, context);
    if (reservation) return await settle("skipped", reservation);

    const model = await globalValue(deps.sql, "model", DEFAULT_ANTHROPIC_MODEL);
    const classifierModel = await globalValue(deps.sql, "classifier_model", model);
    // Haiku 5.5 thinks by default and counts thinking against max_tokens; a one-line roast does
    // not need it, and disabling keeps latency inside the 4-second budget.
    // Instructions go in `system`, the viewer's data alone in the user turn.
    const prompt = composeRoastPrompt({
      viewer: job.viewerLogin,
      message: job.inputText,
      tone: context.tone,
      toxicity: context.toxicity
    });
    const generated = await deps.anthropic.messages.create({
      model,
      max_tokens: GENERATION_MAX_TOKENS,
      thinking: { type: "disabled" },
      system: prompt.system,
      messages: [{ role: "user", content: prompt.user }]
    });
    spends.push({
      model,
      tokensIn: generated.usage.input_tokens,
      tokensOut: generated.usage.output_tokens
    });
    let output = enforceOutputLimit(textFrom(generated));
    let blockReason: string | undefined;
    if (generated.stop_reason === "refusal") blockReason = "model_refusal";
    else if (!output) blockReason = "empty_output";
    else {
      const outputVerdict = inspectOutput(output, job.inputText, stopWords);
      if (!outputVerdict.allowed) blockReason = outputVerdict.reason;
      else {
        const classified = await deps.anthropic.messages.create({
          model: classifierModel,
          max_tokens: CLASSIFIER_MAX_TOKENS,
          thinking: { type: "disabled" },
          system: CLASSIFIER_SYSTEM_PROMPT,
          messages: [{ role: "user", content: classifierInput(output) }]
        });
        spends.push({
          model: classifierModel,
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

    const audioFile = await storeAudio(
      await synthesize(output, context.voice, deps.config, deps.fetch ?? globalThis.fetch),
      deps.config.AUDIO_DIR
    );
    const now = clock();
    const expiresAt = new Date(now.getTime() + OVERLAY_EVENT_TTL_SECONDS * 1000);
    const ttsChars = Array.from(output).length;
    const currentRoastId = roastId;

    await deps.sql.begin(async (tx) => {
      const spent = await recordSpend(tx as unknown as Sql, job.channelId, month, spends);
      spends.length = 0;
      await tx`update usage_monthly set tts_chars=tts_chars+${ttsChars}
        where channel_id=${job.channelId} and month=${month}`;
      await tx`update roasts set status=${blockReason ? "blocked_output" : "done"}, output_text=${output},
        error=${blockReason ?? null}, tokens_in=${spent.tokensIn},tokens_out=${spent.tokensOut},
        tts_chars=${ttsChars}, cost_usd=${spent.cost},latency_ms=${Date.now() - started}
        where id=${currentRoastId}`;
      const overlayId = randomUUID();
      const payload: StoredOverlayRoast = {
        version: 1,
        type: "roast.play",
        eventId: overlayId,
        roastId: currentRoastId,
        viewerLogin: job.viewerLogin,
        text: output,
        tone: context.tone,
        audioFile,
        expiresAt: expiresAt.toISOString(),
        sentAt: now.toISOString()
      };
      await tx`insert into overlay_events(id,channel_id,roast_id,payload,expires_at)
        values(${overlayId},${job.channelId},${currentRoastId},${deps.sql.json(payload)},${expiresAt.toISOString()})`;
      await tx`select pg_notify('overlay_events',${job.channelId})`;
    });
    return blockReason
      ? { roastId, status: "blocked_output", reason: blockReason }
      : { roastId, status: "done" };
  } catch (error) {
    if (roastId) {
      const message = error instanceof Error ? error.message : "unknown";
      // API money already spent on a failed roast still counts against the budget.
      const spent = spends.length
        ? await recordSpend(deps.sql, job.channelId, month, spends)
        : { tokensIn: 0, tokensOut: 0, cost: 0 };
      await deps.sql`update roasts set status='failed',error=${message.slice(0, 500)},
        tokens_in=${spent.tokensIn},tokens_out=${spent.tokensOut},cost_usd=${spent.cost},
        latency_ms=${Date.now() - started} where id=${roastId}`;
    }
    throw error;
  }
}
