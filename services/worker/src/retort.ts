// Harem mode: now and then the other built-in heroine argues with the reply that just played.
// Her line goes through every check a roast does (stop list, output inspection, classifier, voice
// reservations) and plays right after it as the roast's second overlay event. It is a bonus:
// anything that goes wrong only means she stays silent, the roast itself is already on air.
import {
  classifierInput,
  classifierSystemPrompt,
  composeRetortPrompt,
  enforceOutputLimit,
  inspectOutput,
  parseClassifierVerdict,
  spokenText
} from "@roastbot/prompts";
import {
  CHARACTER_NAMES,
  OVERLAY_EVENT_TTL_SECONDS,
  rivalTone,
  type Archetype,
  type RoastRequestedJob,
  type RoastTier
} from "@roastbot/shared";

import type { ChannelContext, OnAirCharacter, PipelineDependencies, Sql } from "./context.js";
import { extraSpendAllowed, voiceReservations } from "./limits.js";
import { modelRequest } from "./models.js";
import { publishOverlay, storeAudio } from "./overlay.js";
import { recordSpend, spendOf, textFrom, type Spend } from "./spend.js";
import { speak } from "./tts.js";

export interface RetortInput {
  job: RoastRequestedJob;
  roastId: string;
  context: ChannelContext;
  /** The premium character who spoke, if any; otherwise the channel's built-in heroine. */
  character: OnAirCharacter | undefined;
  archetype: Archetype;
  /** What she said: the roast's checked output. */
  said: string;
  tier: RoastTier;
  /** The model that wrote the roast writes the retort too. */
  model: string;
  classifierModel: string;
  stopWords: string[];
  month: string;
}

/** Why the retort stayed silent, or "played"; for logs and tests. */
export type RetortOutcome =
  | "played"
  | "budget"
  | "refusal"
  | "empty"
  | "blocked_output"
  | "classifier_block"
  | "no_voice"
  | "failed";

export async function playRetort(
  deps: PipelineDependencies,
  input: RetortInput
): Promise<RetortOutcome> {
  const { job, context } = input;
  const spends: Spend[] = [];
  try {
    // The roast passed reserve(); her extra call still respects the switch and the budget.
    if (!(await extraSpendAllowed(deps))) return "budget";
    const tone = rivalTone(input.archetype);
    const prompt = composeRetortPrompt({
      tone,
      speaker: {
        name: input.character?.name ?? CHARACTER_NAMES[context.tone],
        archetype: input.archetype
      },
      said: input.said,
      viewer: job.viewerLogin,
      message: job.inputText,
      streamer: context.streamerLogin,
      ...(job.eventSummary ? { event: job.eventSummary } : {}),
      toxicity: context.toxicity
    });
    const generated = await deps.anthropic.beta.messages.create(
      modelRequest(input.model, "generate", prompt.systemBlocks, prompt.user)
    );
    spends.push(spendOf(generated.model || input.model, generated.usage));
    if (generated.stop_reason === "refusal") return await settle("refusal");
    const output = enforceOutputLimit(textFrom(generated));
    if (!output) return await settle("empty");
    // Neither the viewer's message nor her rival's line may come back word for word.
    for (const repeated of [job.inputText, input.said]) {
      if (!inspectOutput(output, repeated, input.stopWords, context.toxicity).allowed) {
        return await settle("blocked_output");
      }
    }
    const classified = await deps.anthropic.beta.messages.create(
      modelRequest(
        input.classifierModel,
        "classify",
        classifierSystemPrompt(context.toxicity),
        classifierInput(output)
      )
    );
    spends.push(spendOf(classified.model || input.classifierModel, classified.usage));
    if (
      classified.stop_reason === "refusal" ||
      parseClassifierVerdict(textFrom(classified)) === "block"
    ) {
      return await settle("classifier_block");
    }

    const spoken = spokenText(output);
    // Never the local Piper: a retort is not worth the emergency voice.
    const speech = await speak(
      spoken,
      tone,
      deps.config,
      deps.fetch ?? globalThis.fetch,
      await voiceReservations(deps),
      { best: input.tier === "premium" ? "elevenlabs" : context.economyVoice, piper: false }
    );
    if (!speech) return await settle("no_voice");
    if (speech.costUsd > 0) {
      spends.push({
        model: `tts:${speech.provider}`,
        tokensIn: 0,
        tokensOut: 0,
        fixedUsd: speech.costUsd
      });
    }
    const audioFile = await storeAudio(speech.audio, deps.config.AUDIO_DIR);
    const now = deps.now?.() ?? new Date();
    const ttsChars = Array.from(spoken).length;
    await deps.sql.begin(async (tx) => {
      const spent = await book(tx as unknown as Sql, ttsChars);
      await tx`update roasts set retort_text=${output}, retort_tone=${tone},
        tokens_in=tokens_in+${spent.tokensIn}, tokens_out=tokens_out+${spent.tokensOut},
        tts_chars=tts_chars+${ttsChars}, cost_usd=cost_usd+${spent.cost}
        where id=${input.roastId}`;
      await publishOverlay(tx as unknown as Sql, {
        job,
        roastId: input.roastId,
        text: output,
        archetype: tone,
        character: undefined,
        planCode: context.planCode,
        audioFile,
        part: 1,
        now,
        expiresAt: new Date(now.getTime() + OVERLAY_EVENT_TTL_SECONDS * 1000)
      });
    });
    return "played";
  } catch (error) {
    console.warn("harem retort:", error instanceof Error ? error.message : error);
    await settle("failed").catch(() => undefined);
    return "failed";
  }

  /** Money already spent on a silent retort still counts against the budget. */
  async function settle(outcome: RetortOutcome): Promise<RetortOutcome> {
    if (spends.length) {
      await deps.sql.begin(async (tx) => {
        const spent = await book(tx as unknown as Sql, 0);
        await tx`update roasts set tokens_in=tokens_in+${spent.tokensIn},
          tokens_out=tokens_out+${spent.tokensOut}, cost_usd=cost_usd+${spent.cost}
          where id=${input.roastId}`;
      });
    }
    return outcome;
  }

  async function book(tx: Sql, ttsChars: number) {
    const spent = await recordSpend(tx, job.channelId, input.month, spends);
    spends.length = 0;
    if (ttsChars) {
      await tx`update usage_monthly set tts_chars=tts_chars+${ttsChars}
        where channel_id=${job.channelId} and month=${input.month}`;
    }
    return spent;
  }
}
