import { randomBytes, randomUUID } from "node:crypto";
import { mkdir, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";

import type Anthropic from "@anthropic-ai/sdk";
import type { createDatabase } from "@roastbot/db";
import {
  calculateHaikuCostUsd,
  classifierInput,
  classifierSystemPrompt,
  composeRoastPrompt,
  enforceOutputLimit,
  findStopListMatch,
  inspectInput,
  inspectOutput,
  parseClassifierVerdict,
  pricingForModel,
  spokenText,
  type ViewerHistory
} from "@roastbot/prompts";
import {
  ARCHETYPE_THEME,
  BLOCKED_OUTPUT_FALLBACK,
  BRANDED_PLANS,
  CUSTOM_CHARACTER_PLANS,
  COOLDOWN_SOURCES,
  DASHBOARD_TEST_DAILY_LIMIT,
  OPTOUT_SKIPPED_SOURCES,
  DEFAULT_ANTHROPIC_MODEL,
  DEFAULT_GLOBAL_MONTHLY_ROAST_CAP,
  DEFAULT_MONTHLY_BUDGET_USD,
  DEFAULT_ELEVENLABS_MONTHLY_CHAR_LIMIT,
  DEFAULT_YANDEX_TTS_MONTHLY_LIMIT_RUB,
  OVERLAY_EVENT_TTL_SECONDS,
  roastRequestedJobSchema,
  triggerSettingsSchema,
  COMMAND_PLANS,
  type Archetype,
  type RoastRequestedJob,
  type EconomyVoice,
  type RoastStatus,
  type RoastTier,
  type StoredOverlayRoast,
  type Tone,
  type Toxicity,
  type Voice,
  yandexBillingMonth,
  yandexTtsRequestLimit
} from "@roastbot/shared";

import type { WorkerConfig } from "./config.js";
import { modelRequest } from "./models.js";
import { notifyStreamer, quotaNotice } from "./telegram.js";
import { speak } from "./tts.js";

export type Sql = ReturnType<typeof createDatabase>["client"];

interface ChannelContext {
  userStatus: string;
  streamerLogin: string;
  enabled: boolean;
  tone: Tone;
  voice: Voice;
  toxicity: Toxicity;
  cooldownSec: number;
  userCooldownSec: number;
  stopWords: string[];
  triggers: unknown;
  monthlyLimit: number | null;
  planCode: string | null;
  /** Premium roasts a month; null means every roast is premium. */
  premiumRoasts: number | null;
  economyModel: string;
  economyVoice: EconomyVoice;
  /** The chosen premium character, when it is usable: own or published, with a picture. */
  characterId: string | null;
  characterName: string | null;
  archetype: Archetype | null;
  /** Her ElevenLabs voice, when the owner still offers it. */
  characterVoiceId: string | null;
  imageHash: string | null;
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
  /** Flat cost on top of tokens, e.g. a paid speech synthesis request. */
  fixedUsd?: number;
}

export function textFrom(message: Anthropic.Beta.BetaMessage): string {
  return message.content
    .flatMap((block) => (block.type === "text" ? [block.text] : []))
    .join(" ")
    .trim();
}

export function costOf(spend: Spend): number {
  return (
    calculateHaikuCostUsd(spend.tokensIn, spend.tokensOut, pricingForModel(spend.model)) +
    (spend.fixedUsd ?? 0)
  );
}

export async function globalValue<T>(sql: Sql, key: string, fallback: T): Promise<T> {
  const [row] = await sql<{ value: T }[]>`select value from global_settings where key=${key}`;
  return row?.value ?? fallback;
}

async function loadContext(sql: Sql, channelId: string): Promise<ChannelContext | undefined> {
  const [context] = await sql<ChannelContext[]>`
    select u.status "userStatus", c.twitch_login "streamerLogin", s.enabled, s.tone, s.voice,
      s.toxicity,
      s.cooldown_sec "cooldownSec", s.user_cooldown_sec "userCooldownSec",
      s.stop_words "stopWords", s.triggers, p.monthly_roast_limit "monthlyLimit",
      p.code "planCode", p.premium_roasts "premiumRoasts", p.economy_model "economyModel",
      p.economy_voice "economyVoice", ch.id "characterId",
      coalesce(s.character_name, ch.name) "characterName", ch.archetype,
      v.id "characterVoiceId", ch.image_hash "imageHash"
    from channels c join users u on u.id=c.user_id join settings s on s.channel_id=c.id
    left join lateral (
      select sub.plan_id from subscriptions sub
      where sub.user_id=u.id and (sub.valid_until is null or sub.valid_until>now())
      order by sub.created_at desc limit 1
    ) sub on true
    left join plans p on p.id=sub.plan_id
    left join characters ch on ch.id=s.character_id and ch.image_hash is not null
      and (ch.author_channel_id=c.id or ch.status='published')
    left join voices v on v.id=ch.voice_id and v.enabled
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

/** Landing demo money of this month, part of the same budget. */
export const demoSpendSql = (sql: Sql, month: string) => sql`(select coalesce(sum(cost_usd),0)
  from demo_requests where to_char(created_at at time zone 'UTC','YYYY-MM')=${month})`;

/** A booked roast's tier; `quota` is the channel's count after booking (absent for tests). */
type Reservation =
  { rejected: string } | { tier: RoastTier; quota?: { used: number; limit: number } };

/**
 * Atomically checks every limit and books one roast against the quota and cooldowns, or a
 * dashboard test against the channel's daily test allowance. Returns the rejection reason, or the
 * tier the roast may spend API money on: the plan's premium allowance is booked here too.
 */
async function reserve(
  deps: PipelineDependencies,
  job: RoastRequestedJob,
  monthlyLimit: number,
  context: ChannelContext
): Promise<Reservation> {
  const now = deps.now?.() ?? new Date();
  const month = now.toISOString().slice(0, 7);
  const rejected = (reason: string): Reservation => ({ rejected: reason });
  return deps.sql.begin(async (tx): Promise<Reservation> => {
    await tx`select pg_advisory_xact_lock(hashtext('roastbot-global-quota'))`;
    const [killSwitch] = await tx<{ value: boolean }[]>`
      select value from global_settings where key='kill_switch'`;
    if (killSwitch?.value === true) return rejected("global_kill_switch");

    const [limits] = await tx<{ roastCap: number; budget: number; used: number; spent: number }[]>`
      select
        coalesce((select (value #>> '{}')::int from global_settings where key='global_monthly_limit'),
          ${DEFAULT_GLOBAL_MONTHLY_ROAST_CAP})::int "roastCap",
        coalesce((select (value #>> '{}')::float8 from global_settings where key='monthly_budget_usd'),
          ${DEFAULT_MONTHLY_BUDGET_USD})::float8 budget,
        coalesce(sum(roasts),0)::int used,
        (coalesce(sum(cost_usd),0) + ${demoSpendSql(tx as unknown as Sql, month)})::float8 spent
      from usage_monthly where month=${month}`;
    if ((limits?.used ?? 0) >= (limits?.roastCap ?? DEFAULT_GLOBAL_MONTHLY_ROAST_CAP)) {
      return rejected("global_quota_exceeded");
    }
    if ((limits?.spent ?? 0) >= (limits?.budget ?? DEFAULT_MONTHLY_BUDGET_USD)) {
      return rejected("global_budget_exceeded");
    }

    if (job.source === "dashboard_test") {
      // Tests skip the monthly quota and cooldowns but not the global guards above.
      const booked = await tx`
        insert into test_usage_daily(channel_id,day,roasts)
        values(${job.channelId},${now.toISOString().slice(0, 10)},1)
        on conflict(channel_id,day) do update set roasts=test_usage_daily.roasts+1
          where test_usage_daily.roasts < ${DASHBOARD_TEST_DAILY_LIMIT}
        returning roasts`;
      if (!booked.length) return rejected("test_limit_reached");
      return { tier: await bookTier(tx as unknown as Sql, job.channelId, month, context) };
    }

    const [usage] = await tx<{ roasts: number; gifted: number }[]>`
      select coalesce(um.roasts,0)::int roasts,
        coalesce((select sum(amount-used) from gifted_quota
          where channel_id=${job.channelId} and month=${month}),0)::int gifted
      from (select 1) x
      left join usage_monthly um on um.channel_id=${job.channelId} and um.month=${month}`;
    const used = usage?.roasts ?? 0;
    if (used >= monthlyLimit + (usage?.gifted ?? 0)) return rejected("channel_quota_exceeded");

    if (COOLDOWN_SOURCES.has(job.source)) {
      const cooldowns = await tx<{ scope: string }[]>`
        select scope from cooldown_state where channel_id=${job.channelId} and next_allowed_at>now()
        and ((scope='channel' and subject_key='*') or (scope='viewer' and subject_key=${job.viewerLogin}))`;
      if (cooldowns.length) return rejected("cooldown_active");
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
      if (!gifted.length) return rejected("channel_quota_exceeded");
    }
    await tx`
      insert into usage_monthly(channel_id,month,roasts) values(${job.channelId},${month},1)
      on conflict(channel_id,month) do update set roasts=usage_monthly.roasts+1,updated_at=now()`;
    return {
      tier: await bookTier(tx as unknown as Sql, job.channelId, month, context),
      quota: { used: used + 1, limit: monthlyLimit + (usage?.gifted ?? 0) }
    };
  });
}

/**
 * Premium while the plan's monthly premium allowance lasts (tests included: the streamer's first
 * roasts should sound the best), economy after it. Runs inside reserve() under its lock.
 */
async function bookTier(
  tx: Sql,
  channelId: string,
  month: string,
  context: ChannelContext
): Promise<RoastTier> {
  if (context.premiumRoasts === null) return "premium";
  if (context.premiumRoasts <= 0) return "economy";
  const booked = await tx`
    insert into usage_monthly(channel_id,month,premium_roasts) values(${channelId},${month},1)
    on conflict(channel_id,month) do update
      set premium_roasts=usage_monthly.premium_roasts+1, updated_at=now()
      where usage_monthly.premium_roasts < ${context.premiumRoasts}
    returning premium_roasts`;
  return booked.length ? "premium" : "economy";
}

/**
 * Atomically reserves Yandex requests for the Moscow-time billing month. The upsert only grows
 * the counter while it stays within the cap, so parallel roasts cannot overshoot it together.
 */
// Enough for the thread of a conversation; older lines only add tokens.
const HISTORY_EXCHANGES = 3;

/**
 * What the character remembers of this viewer on this channel: the last few exchanges in the last
 * 12 hours (roughly this stream), what they wrote and what she answered. No counts: "your 24th
 * time" is not a joke. The streamer's own events (ads, anonymous gifts) have no memory.
 */
async function viewerHistory(
  sql: Sql,
  job: RoastRequestedJob,
  roastId: string,
  streamerLogin: string
): Promise<ViewerHistory | undefined> {
  if (job.viewerLogin.toLowerCase() === streamerLogin.toLowerCase()) return undefined;
  const rows = await sql<{ message: string; reply: string }[]>`
    select input_text "message", output_text "reply" from roasts
    where channel_id=${job.channelId} and viewer_login=${job.viewerLogin} and id<>${roastId}
      and status='done' and output_text is not null and created_at > now()-interval '12 hours'
    order by created_at desc limit ${HISTORY_EXCHANGES}`;
  return rows.length ? { exchanges: rows.reverse() } : undefined;
}

export async function reserveYandexRequests(
  sql: Sql,
  now: Date,
  requests: number,
  limitRub: number
) {
  const limit = yandexTtsRequestLimit(limitRub);
  if (requests > limit) return false;
  const reserved = await sql`
    insert into tts_usage_monthly(provider,month,requests)
    values('yandex',${yandexBillingMonth(now)},${requests})
    on conflict(provider,month) do update
      set requests=tts_usage_monthly.requests+excluded.requests, updated_at=now()
      where tts_usage_monthly.requests+excluded.requests <= ${limit}
    returning requests`;
  return reserved.length > 0;
}

// ElevenLabs counts characters per calendar month; same atomic upsert as Yandex, the row
// stores characters in `requests`.
export async function reserveElevenLabsCharacters(
  sql: Sql,
  now: Date,
  characters: number,
  limit: number
) {
  if (characters > limit) return false;
  const reserved = await sql`
    insert into tts_usage_monthly(provider,month,requests)
    values('elevenlabs',${now.toISOString().slice(0, 7)},${characters})
    on conflict(provider,month) do update
      set requests=tts_usage_monthly.requests+excluded.requests, updated_at=now()
      where tts_usage_monthly.requests+excluded.requests <= ${limit}
    returning requests`;
  return reserved.length > 0;
}

export async function storeAudio(bytes: Uint8Array, audioDir: string): Promise<string> {
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
    // `!роаст` is a paid feature. The twitch service drops it on free channels already; this is
    // the authoritative check for a job queued before a downgrade.
    if (job.source === "chat_command" && !COMMAND_PLANS.has(context.planCode ?? "")) {
      return await settle("skipped", "command_not_in_plan");
    }
    // The viewer said "!роаст-стоп": chat triggers from them are skipped, paid events still play
    // but roast the streamer, and the character does not bring up their history.
    const [optOut] = await deps.sql`select 1 from viewer_optouts
      where channel_id=${job.channelId} and lower(viewer_login)=lower(${job.viewerLogin})`;
    const optedOut = Boolean(optOut);
    if (optedOut && OPTOUT_SKIPPED_SOURCES.has(job.source)) {
      return await settle("skipped", "viewer_opted_out");
    }

    const globalWords = await globalValue<string[]>(deps.sql, "global_stop_words", []);
    const stopWords = [...globalWords, ...context.stopWords];
    // Nickname, message and injection checks: a rejected request costs neither quota nor money.
    const inputVerdict = inspectInput(job.viewerLogin, job.inputText, stopWords);
    if (!inputVerdict.allowed) return await settle("blocked_input", inputVerdict.reason);
    // Event summaries carry third-party names and titles (raiders, prediction outcomes).
    const eventMatch = job.eventSummary ? findStopListMatch(job.eventSummary, stopWords) : null;
    if (eventMatch) return await settle("blocked_input", `event:${eventMatch.term}`);

    const reservation = await reserve(deps, job, context.monthlyLimit!, context);
    if ("rejected" in reservation) return await settle("skipped", reservation.rejected);
    const { tier, quota } = reservation;

    const globalModel = await globalValue(deps.sql, "model", DEFAULT_ANTHROPIC_MODEL);
    const model = tier === "premium" ? globalModel : context.economyModel;
    // The classifier is the safety net: it stays the same on every tier.
    const classifierModel = await globalValue(deps.sql, "classifier_model", globalModel);
    // A premium character only on a plan that includes her; after a downgrade the built-in one
    // speaks again, and the choice waits in settings for an upgrade.
    const character =
      context.characterId &&
      context.characterName &&
      context.archetype &&
      context.imageHash &&
      CUSTOM_CHARACTER_PLANS.has(context.planCode ?? "")
        ? {
            id: context.characterId,
            name: context.characterName,
            archetype: context.archetype,
            voiceId: context.characterVoiceId,
            imagePath: `/characters/${context.characterId}/image?v=${context.imageHash.slice(0, 16)}`
          }
        : undefined;
    const archetype: Archetype = character?.archetype ?? context.tone;
    await deps.sql`update roasts set tier=${tier}, model=${model}, tone=${archetype},
      character_id=${character?.id ?? null} where id=${roastId}`;
    // Instructions go in `system`, the viewer's data alone in the user turn. Thinking and effort
    // per model live in modelRequest().
    // The channel's switch picks the target; a job without an author (anonymous gift, ad break,
    // the streamer's own message) always roasts the streamer.
    const { targetMode } = triggerSettingsSchema.parse(context.triggers ?? {});
    const target =
      job.target === "streamer" || optedOut || targetMode === "streamer"
        ? "streamer"
        : targetMode === "author"
          ? "viewer"
          : "auto";
    const history = optedOut
      ? undefined
      : await viewerHistory(deps.sql, job, roastId, context.streamerLogin);
    const prompt = composeRoastPrompt({
      viewer: job.viewerLogin,
      message: job.inputText,
      tone: context.tone,
      ...(character ? { character: { name: character.name, archetype } } : {}),
      toxicity: context.toxicity,
      target,
      streamer: context.streamerLogin,
      ...(job.eventSummary ? { event: job.eventSummary } : {}),
      ...(job.game ? { game: job.game } : {}),
      ...(history ? { history } : {})
    });
    const generated = await deps.anthropic.beta.messages.create(
      modelRequest(model, "generate", prompt.system, prompt.user)
    );
    // After a refusal fallback the reply comes from another model: bill at its rate.
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
      const outputVerdict = inspectOutput(output, job.inputText, stopWords, context.toxicity);
      if (!outputVerdict.allowed) blockReason = outputVerdict.reason;
      else {
        const classified = await deps.anthropic.beta.messages.create(
          modelRequest(
            classifierModel,
            "classify",
            classifierSystemPrompt(context.toxicity),
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
    const elevenLabsLimit = await globalValue<number>(
      deps.sql,
      "elevenlabs_monthly_char_limit",
      DEFAULT_ELEVENLABS_MONTHLY_CHAR_LIMIT
    );
    const spoken = spokenText(output);
    const speech = await speak(
      spoken,
      archetype,
      deps.config,
      deps.fetch ?? globalThis.fetch,
      {
        yandex: (requests) => reserveYandexRequests(deps.sql, clock(), requests, yandexLimitRub),
        elevenlabs: (characters) =>
          reserveElevenLabsCharacters(deps.sql, clock(), characters, elevenLabsLimit)
      },
      {
        best: tier === "premium" ? "elevenlabs" : context.economyVoice,
        // A premium character speaks in her own voice; without one, the archetype's voice.
        ...(character ? { voiceId: character.voiceId } : {})
      }
    );
    if (speech.costUsd > 0) {
      spends.push({
        model: `tts:${speech.provider}`,
        tokensIn: 0,
        tokensOut: 0,
        fixedUsd: speech.costUsd
      });
    }
    const audioFile = await storeAudio(speech.audio, deps.config.AUDIO_DIR);
    const now = clock();
    const expiresAt = new Date(now.getTime() + OVERLAY_EVENT_TTL_SECONDS * 1000);
    const ttsChars = Array.from(spoken).length;
    const currentRoastId = roastId;

    await deps.sql.begin(async (tx) => {
      const spent = await recordSpend(tx as unknown as Sql, job.channelId, month, spends);
      spends.length = 0;
      await tx`update usage_monthly set tts_chars=tts_chars+${ttsChars}
        where channel_id=${job.channelId} and month=${month}`;
      await tx`update roasts set status=${blockReason ? "blocked_output" : "done"}, output_text=${output},
        error=${blockReason ?? null},
        tokens_in=${spent.tokensIn},tokens_out=${spent.tokensOut},
        tts_chars=${ttsChars}, cost_usd=${spent.cost},latency_ms=${Date.now() - started},
        voice_provider=${speech.provider}
        where id=${currentRoastId}`;
      const overlayId = randomUUID();
      const payload: StoredOverlayRoast = {
        version: 1,
        type: "roast.play",
        eventId: overlayId,
        roastId: currentRoastId,
        viewerLogin: job.viewerLogin,
        text: output,
        tone: ARCHETYPE_THEME[archetype],
        ...(character
          ? { character: { name: character.name, imagePath: character.imagePath } }
          : {}),
        ...(BRANDED_PLANS.has(context.planCode ?? "") ? { branding: true } : {}),
        audioFile,
        expiresAt: expiresAt.toISOString(),
        sentAt: now.toISOString()
      };
      await tx`insert into overlay_events(id,channel_id,roast_id,payload,expires_at)
        values(${overlayId},${job.channelId},${currentRoastId},${deps.sql.json(payload)},${expiresAt.toISOString()})`;
      await tx`select pg_notify('overlay_events',${job.channelId})`;
    });
    const notice =
      quota &&
      quotaNotice(
        job.channelId,
        month,
        quota.used,
        quota.limit,
        deps.config.DASHBOARD_URL?.replace(/\/$/u, "")
      );
    // A notification never holds up or fails the roast.
    if (notice) {
      void notifyStreamer(deps.sql, deps.config, notice, deps.fetch ?? globalThis.fetch).catch(
        (error: unknown) => console.warn("quota notification:", error)
      );
    }
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
