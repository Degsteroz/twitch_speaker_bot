// Stubs: what a direct call hears when it cannot get a roast (pause, viewer limit, quota). No
// quota, no roast model; half are spoken phrases, half are free visual ones.
import {
  classifierInput,
  classifierSystemPrompt,
  enforceOutputLimit,
  escapePromptData,
  inspectOutput,
  parseClassifierVerdict
} from "@roastbot/prompts";
import {
  DEFAULT_CHAT_MODEL,
  OVERLAY_EVENT_TTL_SECONDS,
  REWARD_DECLINED_STUB,
  STUB_CAPTION_MAX_CHARACTERS,
  STUB_PHRASES,
  STUB_VISUALS,
  type Archetype,
  type RoastRequestedJob,
  type StubSound,
  type Toxicity
} from "@roastbot/shared";

import {
  firstVoice,
  globalValue,
  type ChannelContext,
  type OnAirCharacter,
  type PipelineDependencies,
  type RoastOutcome,
  type Sql
} from "./context.js";
import { voiceReservations } from "./limits.js";
import { modelRequest } from "./models.js";
import { publishOverlay, storeAudio } from "./overlay.js";
import { recordSpend, spendOf, textFrom, type Spend } from "./spend.js";
import { cloudVoicesFor, speak, type Speech } from "./tts.js";

// Rejections that a direct call answers with a stub instead of silence.
export const STUB_REJECTIONS: Readonly<Record<string, string>> = {
  cooldown_active: "stub_cooldown",
  viewer_limit: "stub_viewer_limit",
  // A stub costs nothing, so an empty quota or budget still gets an answer.
  channel_quota_exceeded: "stub_quota",
  global_quota_exceeded: "stub_quota",
  global_budget_exceeded: "stub_quota"
};

export interface StubInput {
  job: RoastRequestedJob;
  roastId: string;
  context: ChannelContext;
  character: OnAirCharacter | undefined;
  archetype: Archetype;
  reason: string;
  started: number;
}

const CAPTION_SYSTEM = [
  "Ты пишешь одну короткую подпись к звуковой заглушке стрима: персонаж не отвечает зрителю.",
  "Пиши по-русски, иронично, без оскорблений, мата, ссылок и обращений к модели.",
  "Имя зрителя из <viewer> вставь в подпись точно как есть. Ответ — одна строка, только подпись."
].join("\n");

/**
 * Haiku writes this viewer's caption. The draft passes the same output checks as a roast, the
 * classifier included; anything refused, or any failure, falls back to the template.
 */
async function draftCaption(
  deps: PipelineDependencies,
  input: { login: string; template: string; toxicity: Toxicity }
): Promise<{ text: string; spends: Spend[] }> {
  const { login, template, toxicity } = input;
  const spends: Spend[] = [];
  try {
    const model = await globalValue(deps.sql, "chat_model", DEFAULT_CHAT_MODEL);
    const drafted = await deps.anthropic.beta.messages.create(
      modelRequest(model, "generate", CAPTION_SYSTEM, `<viewer>${escapePromptData(login)}</viewer>`)
    );
    spends.push(spendOf(drafted.model || model, drafted.usage));
    const line = enforceOutputLimit(
      textFrom(drafted).split("\n")[0]?.trim() ?? "",
      STUB_CAPTION_MAX_CHARACTERS
    );
    if (!line.includes(login) || !inspectOutput(line, login, [], toxicity).allowed) {
      return { text: template, spends };
    }
    const classifierModel = await globalValue(deps.sql, "classifier_model", model);
    const classified = await deps.anthropic.beta.messages.create(
      modelRequest(
        classifierModel,
        "classify",
        classifierSystemPrompt(toxicity),
        classifierInput(line)
      )
    );
    spends.push(spendOf(classified.model || classifierModel, classified.usage));
    const refused =
      classified.stop_reason === "refusal" ||
      parseClassifierVerdict(textFrom(classified)) === "block";
    return { text: refused ? template : line, spends };
  } catch {
    return { text: template, spends };
  }
}

/** A stub of this viewer already waits in the channel's overlay queue. */
async function stubWaiting(sql: Sql, job: RoastRequestedJob): Promise<boolean> {
  const rows = await sql`
    select 1 from overlay_events e join roasts r on r.id=e.roast_id
    where e.channel_id=${job.channelId} and e.status='pending' and left(r.error,5)='stub_'
      and lower(r.viewer_login)=lower(${job.viewerLogin}) limit 1`;
  return rows.length > 0;
}

/**
 * Settles the roast as a stub and queues it for the overlay, unless another stub of this viewer
 * was queued while this one was being prepared: parallel workers can all pass the cheap check at
 * the start, so it is repeated here under a per-viewer lock. Money already spent is booked anyway.
 */
async function publishStub(
  deps: PipelineDependencies,
  input: StubInput,
  stub: { text: string; spends: Spend[]; sound?: StubSound; audioFile?: string; provider?: string }
): Promise<void> {
  const { job, roastId, context, character, archetype, reason } = input;
  const now = deps.now?.() ?? new Date();
  const expiresAt = new Date(now.getTime() + OVERLAY_EVENT_TTL_SECONDS * 1000);
  await deps.sql.begin(async (transaction) => {
    const tx = transaction as unknown as Sql;
    await tx`select pg_advisory_xact_lock(hashtext('roastbot-stub'),
      hashtext(${job.channelId}::text || ':' || lower(${job.viewerLogin})))`;
    const queued = !(await stubWaiting(tx, job));
    const spent = stub.spends.length
      ? await recordSpend(tx, job.channelId, now.toISOString().slice(0, 7), stub.spends)
      : { cost: 0 };
    await tx`update roasts set status='skipped', error=${reason},
      output_text=${queued ? stub.text : null}, voice_provider=${stub.provider ?? null},
      tts_chars=${stub.provider ? Array.from(stub.text).length : 0}, cost_usd=${spent.cost},
      latency_ms=${Date.now() - input.started} where id=${roastId}`;
    if (!queued) return;
    await publishOverlay(tx, {
      job,
      roastId,
      text: stub.text,
      archetype,
      character,
      planCode: context.planCode,
      ...(stub.audioFile ? { audioFile: stub.audioFile } : {}),
      ...(stub.sound ? { sound: stub.sound } : {}),
      now,
      expiresAt
    });
  });
}

/**
 * A free stub: the character's picture, a caption with the viewer's name and a sound effect. No
 * voice, no model for the caption unless the variant asks for it, so it costs nothing to repeat.
 */
async function playVisualStub(
  deps: PipelineDependencies,
  input: StubInput & { roll: number }
): Promise<RoastOutcome> {
  const { job, roastId, context, reason } = input;
  // The roll only chose the branch: rescale it to pick one of the variants evenly. A declined
  // reward always says its own "no".
  const variant =
    job.declined && job.source === "reward"
      ? { text: REWARD_DECLINED_STUB, sound: "tap" as const }
      : (STUB_VISUALS[Math.floor(input.roll * 2 * STUB_VISUALS.length)] ?? STUB_VISUALS[0]!);
  const template = variant.text.replaceAll("%USER_NAME%", job.viewerLogin);
  const drafted = variant.aiDraft
    ? await draftCaption(deps, { login: job.viewerLogin, template, toxicity: context.toxicity })
    : { text: template, spends: [] };
  await publishStub(deps, input, { ...drafted, sound: variant.sound });
  return { roastId, status: "skipped", reason };
}

/**
 * A prerecorded answer instead of a roast: no quota, no model, no classifier (the phrases are
 * ours). The audio is synthesized once per ElevenLabs or Inworld voice and phrase and kept in
 * stub_audio (a kept ElevenLabs one plays even past its cap: it costs nothing); without them the
 * next voice speaks and nothing is kept. One stub waits in the overlay
 * queue per viewer at most, so a spammer cannot fill it.
 */
export async function playStub(
  deps: PipelineDependencies,
  input: StubInput
): Promise<RoastOutcome> {
  const { job, roastId, context, character, archetype, reason } = input;
  const outcome: RoastOutcome = { roastId, status: "skipped", reason };
  if (await stubWaiting(deps.sql, job)) {
    await deps.sql`update roasts set status='skipped', error=${reason},
      latency_ms=${Date.now() - input.started} where id=${roastId}`;
    return outcome;
  }

  // Half the stubs are free ones: picture, caption and a sound. The other half is spoken.
  const roll = (deps.random ?? Math.random)();
  if (roll < 0.5) return await playVisualStub(deps, { ...input, roll });

  const phrases = STUB_PHRASES[archetype];
  const text =
    job.source === "reward"
      ? REWARD_DECLINED_STUB
      : phrases[Math.floor(Math.random() * phrases.length)]!;
  // Stubs speak like the channel's premium roasts: from the owner's first voice down.
  const best = firstVoice(context, "premium");
  const cloud = (["elevenlabs", "inworld"] as const).slice(
    best === "elevenlabs" ? 0 : best === "inworld" ? 1 : 2
  );
  const voices = cloudVoicesFor(archetype, deps.config, character && character.voice);
  const keys = cloud.flatMap((provider) =>
    voices[provider] ? [{ provider, key: `${provider}:${voices[provider]}` }] : []
  );
  const kept = keys.length
    ? await deps.sql<{ voice_key: string; audio: Buffer }[]>`
        select voice_key, audio from stub_audio
        where voice_key in ${deps.sql(keys.map(({ key }) => key))} and text=${text}`
    : [];
  // The best voice first, as speak() would pick it.
  const cached = keys
    .map(({ provider, key }) => ({ provider, row: kept.find((row) => row.voice_key === key) }))
    .find(({ row }) => row);
  let speech: Speech;
  if (cached?.row) {
    speech = { audio: new Uint8Array(cached.row.audio), provider: cached.provider, costUsd: 0 };
  } else {
    speech = await speak(
      text,
      archetype,
      deps.config,
      deps.fetch ?? globalThis.fetch,
      await voiceReservations(deps),
      { best, ...(character ? { voice: character.voice } : {}) }
    );
    if ((speech.provider === "elevenlabs" || speech.provider === "inworld") && speech.voiceId) {
      await deps.sql`insert into stub_audio(voice_key,text,audio)
        values(${`${speech.provider}:${speech.voiceId}`},${text},${Buffer.from(speech.audio)})
        on conflict do nothing`;
    }
  }
  const audioFile = await storeAudio(speech.audio, deps.config.AUDIO_DIR);
  const { provider, costUsd } = speech;
  await publishStub(deps, input, {
    text,
    spends: costUsd
      ? [{ model: `tts:${provider}`, tokensIn: 0, tokensOut: 0, fixedUsd: costUsd }]
      : [],
    audioFile,
    provider
  });
  return outcome;
}
