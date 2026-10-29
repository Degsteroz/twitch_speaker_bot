// What a roast job knows about its channel, and the dependencies every step of it shares.
import type Anthropic from "@anthropic-ai/sdk";
import type { createDatabase } from "@roastbot/db";
import {
  MAX_REGULAR_TOXICITY,
  ZERO_REGRETS_TOXICITY,
  type Archetype,
  type EconomyVoice,
  type RoastStatus,
  type Tone,
  type Toxicity,
  type Voice
} from "@roastbot/shared";

import type { WorkerConfig } from "./config.js";

export type Sql = ReturnType<typeof createDatabase>["client"];

export interface PipelineDependencies {
  sql: Sql;
  anthropic: Anthropic;
  config: WorkerConfig;
  now?: () => Date;
  fetch?: typeof globalThis.fetch;
  /** Picks between a spoken and a free stub; tests pin it. */
  random?: () => number;
}

export interface RoastOutcome {
  roastId: string;
  status: RoastStatus;
  reason?: string;
}

export interface ChannelContext {
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
  /**
   * The owner's own channel or a favourite marked unlimited: no quota, pauses or viewer limit,
   * every plan feature, always the premium tier. Global guards and moderation still apply.
   */
  unlimited: boolean;
  /** The owner's per-channel models and pause floor (channel_overrides); null keeps the default. */
  overrideModel: string | null;
  overrideChatModel: string | null;
  minCooldownSec: number | null;
  /** The owner opened toxicity 6 for this channel; without it a stored 6 plays as 5. */
  zeroRegrets: boolean;
  /** The chosen premium character, when it is usable: own or published, with a picture. */
  characterId: string | null;
  characterName: string | null;
  archetype: Archetype | null;
  /** Her ElevenLabs voice, when the owner still offers it. */
  characterVoiceId: string | null;
  imageHash: string | null;
}

/** The premium character on air, when the plan includes her. */
export interface OnAirCharacter {
  id: string;
  name: string;
  archetype: Archetype;
  voiceId: string | null;
  imagePath: string;
}

export async function globalValue<T>(sql: Sql, key: string, fallback: T): Promise<T> {
  const [row] = await sql<{ value: T }[]>`select value from global_settings where key=${key}`;
  return row?.value ?? fallback;
}

export async function loadContext(
  sql: Sql,
  channelId: string
): Promise<ChannelContext | undefined> {
  const [context] = await sql<ChannelContext[]>`
    select u.status "userStatus", c.twitch_login "streamerLogin", s.enabled, s.tone, s.voice,
      s.toxicity,
      s.cooldown_sec "cooldownSec", s.user_cooldown_sec "userCooldownSec",
      s.stop_words "stopWords", s.triggers,
      case when p.id is not null then coalesce(o.monthly_roast_limit, p.monthly_roast_limit)
        end "monthlyLimit",
      p.code "planCode",
      case when o.premium_roasts is not null then o.premium_roasts else p.premium_roasts end
        "premiumRoasts",
      coalesce(o.economy_model, p.economy_model) "economyModel",
      coalesce(o.economy_voice, p.economy_voice::text) "economyVoice",
      (u.role='owner' or coalesce(o.unlimited, false)) unlimited,
      (u.role='owner' or coalesce(o.zero_regrets, false)) "zeroRegrets",
      o.model "overrideModel", o.chat_model "overrideChatModel",
      o.min_cooldown_sec "minCooldownSec", ch.id "characterId",
      coalesce(s.character_name, ch.name) "characterName", ch.archetype,
      v.id "characterVoiceId", ch.image_hash "imageHash"
    from channels c join users u on u.id=c.user_id join settings s on s.channel_id=c.id
    left join lateral (
      select sub.plan_id from subscriptions sub
      where sub.user_id=u.id and (sub.valid_until is null or sub.valid_until>now())
      order by sub.created_at desc limit 1
    ) sub on true
    left join plans p on p.id=sub.plan_id
    left join channel_overrides o on o.channel_id=c.id
    left join characters ch on ch.id=s.character_id and ch.image_hash is not null
      and (ch.author_channel_id=c.id or ch.status='published')
    left join voices v on v.id=ch.voice_id and v.enabled
    where c.id=${channelId}`;
  if (context && context.toxicity === ZERO_REGRETS_TOXICITY && !context.zeroRegrets) {
    context.toxicity = MAX_REGULAR_TOXICITY;
  }
  return context;
}

export function rejectionFor(context: ChannelContext | undefined): string | undefined {
  if (!context) return "channel_not_found";
  if (context.userStatus !== "active") return "user_suspended";
  if (!context.enabled) return "channel_disabled";
  if (context.monthlyLimit === null && !context.unlimited) return "no_active_plan";
  return undefined;
}
