import {
  addressesCharacter,
  classifierInput,
  classifierSystemPrompt,
  composeRoastPrompt,
  enforceOutputLimit,
  findStopListMatch,
  inspectInput,
  inspectOutput,
  parseClassifierVerdict,
  spokenText,
  type ViewerHistory
} from "@roastbot/prompts";
import {
  BLOCKED_OUTPUT_FALLBACK,
  CHARACTER_NAMES,
  CUSTOM_CHARACTER_PLANS,
  OPTOUT_SKIPPED_SOURCES,
  DEFAULT_ANTHROPIC_MODEL,
  DEFAULT_CHAT_MODEL,
  OVERLAY_EVENT_TTL_SECONDS,
  isStubCall,
  roastRequestedJobSchema,
  triggerSettingsSchema,
  COMMAND_PLANS,
  type Archetype,
  type RoastRequestedJob,
  type RoastSource,
  type RoastStatus,
  type RoastTier,
  type Toxicity,
  UNLIMITED_MODEL,
  ZERO_REGRETS_MODEL,
  ZERO_REGRETS_TOXICITY,
  zeroRegretsUsesSonnet
} from "@roastbot/shared";

import {
  globalValue,
  loadContext,
  rejectionFor,
  type PipelineDependencies,
  type RoastOutcome,
  type Sql
} from "./context.js";
import { reserve, voiceReservations } from "./limits.js";
import { modelRequest } from "./models.js";
import { publishOverlay, storeAudio } from "./overlay.js";
import { recordSpend, spendOf, textFrom, type Spend } from "./spend.js";
import { playStub, STUB_REJECTIONS } from "./stubs.js";
import { notifyStreamer, quotaNotice } from "./telegram.js";
import { speak } from "./tts.js";

export type { PipelineDependencies, RoastOutcome } from "./context.js";

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

export interface ModelChoice {
  source: RoastSource;
  named?: boolean | undefined;
  toxicity: Toxicity;
  unlimited: boolean;
  tier: RoastTier;
  economyModel: string;
  overrideModel: string | null;
  overrideChatModel: string | null;
  /** global_settings.model and chat_model. */
  globalModel: string;
  chatModel: string;
}

/**
 * Which model writes the roast. Chat words are background chatter nobody paid for: the cheap chat
 * model answers them on the premium tier too. Paid events, the command and rewards get the global
 * model. The owner's override for the channel wins; an unlimited channel never drops to the cheap
 * chat model. "Ноль сожалений" sends the calls that matter to Sonnet on any tier; plain chat words
 * keep whatever chat model the channel has.
 */
export function pickModel(choice: ModelChoice): string {
  const chatWord = choice.source === "chat_keyword";
  if (
    choice.toxicity === ZERO_REGRETS_TOXICITY &&
    zeroRegretsUsesSonnet(choice.source, choice.named)
  ) {
    return ZERO_REGRETS_MODEL;
  }
  if (choice.unlimited) {
    return (chatWord ? choice.overrideChatModel : null) ?? choice.overrideModel ?? UNLIMITED_MODEL;
  }
  if (choice.tier !== "premium") return choice.economyModel;
  if (chatWord) return choice.overrideChatModel ?? choice.chatModel;
  return choice.overrideModel ?? choice.globalModel;
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
    if (
      job.source === "chat_command" &&
      !context.unlimited &&
      !COMMAND_PLANS.has(context.planCode ?? "")
    ) {
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

    // A premium character only on a plan that includes her; after a downgrade the built-in one
    // speaks again, and the choice waits in settings for an upgrade.
    const character =
      context.characterId &&
      context.characterName &&
      context.archetype &&
      context.imageHash &&
      (context.unlimited || CUSTOM_CHARACTER_PLANS.has(context.planCode ?? ""))
        ? {
            id: context.characterId,
            name: context.characterName,
            archetype: context.archetype,
            voiceId: context.characterVoiceId,
            imagePath: `/characters/${context.characterId}/image?v=${context.imageHash.slice(0, 16)}`
          }
        : undefined;
    const archetype: Archetype = character?.archetype ?? context.tone;
    const stub = (reason: string) =>
      playStub(deps, { job, roastId: roastId!, context, character, archetype, reason, started });
    // A reward the frequency passed over: a short "no", no quota, no model.
    if (job.declined) return await stub("stub_declined");

    const reservation = await reserve(deps, job, context.monthlyLimit ?? 0, context);
    if ("rejected" in reservation) {
      // Someone called the bot directly during a pause or past their limit: a stub, so nobody
      // thinks the bot is down. Everything else (quota, budget) stays silent.
      const stubReason = STUB_REJECTIONS[reservation.rejected];
      if (stubReason && isStubCall(job.source, job.named)) return await stub(stubReason);
      return await settle("skipped", reservation.rejected);
    }
    const { tier, quota } = reservation;

    const globalModel = await globalValue(deps.sql, "model", DEFAULT_ANTHROPIC_MODEL);
    const model = pickModel({
      source: job.source,
      named: job.named,
      toxicity: context.toxicity,
      unlimited: context.unlimited,
      tier,
      economyModel: context.economyModel,
      overrideModel: context.overrideModel,
      overrideChatModel: context.overrideChatModel,
      globalModel,
      chatModel: await globalValue(deps.sql, "chat_model", DEFAULT_CHAT_MODEL)
    });
    // The classifier is the safety net: it stays the same on every tier.
    const classifierModel = await globalValue(deps.sql, "classifier_model", globalModel);
    await deps.sql`update roasts set tier=${tier}, model=${model}, tone=${archetype},
      toxicity=${context.toxicity},
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
    // "Ноль сожалений": calling her by name is an attack, and the author gets it back, whatever
    // the channel's target switch says. Not when there is no author or the viewer opted out.
    const addressed =
      context.toxicity === ZERO_REGRETS_TOXICITY &&
      job.target !== "streamer" &&
      !optedOut &&
      (job.named === true ||
        addressesCharacter(job.inputText, character?.name ?? CHARACTER_NAMES[context.tone]));
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
      ...(history ? { history } : {}),
      ...(addressed ? { addressed } : {})
    });
    const generated = await deps.anthropic.beta.messages.create(
      modelRequest(model, "generate", prompt.systemBlocks, prompt.user)
    );
    // After a refusal fallback the reply comes from another model: bill at its rate.
    spends.push(spendOf(generated.model || model, generated.usage));
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
        spends.push(spendOf(classified.model || classifierModel, classified.usage));
        if (
          classified.stop_reason === "refusal" ||
          parseClassifierVerdict(textFrom(classified)) === "block"
        ) {
          blockReason = "classifier_block";
        }
      }
    }
    if (blockReason) output = BLOCKED_OUTPUT_FALLBACK;

    const spoken = spokenText(output);
    const speech = await speak(
      spoken,
      archetype,
      deps.config,
      deps.fetch ?? globalThis.fetch,
      await voiceReservations(deps),
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
      await publishOverlay(tx as unknown as Sql, {
        job,
        roastId: currentRoastId,
        text: output,
        archetype,
        character,
        planCode: context.planCode,
        audioFile,
        now,
        expiresAt
      });
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
