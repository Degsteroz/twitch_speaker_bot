// Every limit a roast books before it may spend money: the global guards, the channel's quota,
// pauses and viewer limit (all under one lock), and the paid voices' monthly caps.
import {
  COOLDOWN_SOURCES,
  DASHBOARD_TEST_DAILY_LIMIT,
  DEFAULT_GLOBAL_MONTHLY_ROAST_CAP,
  DEFAULT_MONTHLY_BUDGET_USD,
  DEFAULT_YANDEX_TTS_MONTHLY_LIMIT_RUB,
  VIEWER_LIMITED_SOURCES,
  VIEWER_ROAST_LIMIT,
  VIEWER_ROAST_WINDOW_MINUTES,
  effectiveCooldown,
  yandexBillingMonth,
  yandexTtsRequestLimit,
  type RoastRequestedJob,
  type RoastTier
} from "@roastbot/shared";

import {
  globalValue,
  type ChannelContext,
  type PipelineDependencies,
  type Sql
} from "./context.js";
import { elevenLabsCharLimit, releaseElevenLabsCharacters } from "./elevenlabs.js";
import type { VoiceReservations } from "./tts.js";

/** Landing demo money of this month, part of the same budget. */
// The UTC month as a range, so the created_at index answers it instead of a scan.
export const demoSpendSql = (sql: Sql, month: string) => sql`(select coalesce(sum(cost_usd),0)
  from demo_requests
  where created_at >= (${month}::text || '-01')::timestamp at time zone 'UTC'
    and created_at < ((${month}::text || '-01')::timestamp + interval '1 month') at time zone 'UTC')`;

/** A booked roast's tier; `quota` is the channel's count after booking (absent for tests). */
export type Reservation =
  { rejected: string } | { tier: RoastTier; quota?: { used: number; limit: number } };

/**
 * Atomically checks every limit and books one roast against the quota and cooldowns, or a
 * dashboard test against the channel's daily test allowance. Returns the rejection reason, or the
 * tier the roast may spend API money on: the plan's premium allowance is booked here too.
 */
export async function reserve(
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

    if (context.unlimited) {
      // The owner's channel and unlimited favourites: past the global guards nothing stops them.
      // The roast is still counted, so the service cap and the statistics stay true.
      if (job.source !== "dashboard_test") {
        await tx`
          insert into usage_monthly(channel_id,month,roasts) values(${job.channelId},${month},1)
          on conflict(channel_id,month) do update set roasts=usage_monthly.roasts+1,updated_at=now()`;
      }
      return { tier: "premium" };
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
      if (VIEWER_LIMITED_SOURCES.has(job.source)) {
        // Answers this viewer already got in the window: finished ones and ones booked but still
        // being written (the tier is set right after booking).
        const [answered] = await tx<{ count: number }[]>`
          select count(*)::int count from roasts
          where channel_id=${job.channelId} and lower(viewer_login)=lower(${job.viewerLogin})
            and source::text in ${tx([...VIEWER_LIMITED_SOURCES])}
            and (status in ('done','blocked_output','failed') or (status='queued' and tier is not null))
            and created_at > now() - ${VIEWER_ROAST_WINDOW_MINUTES} * interval '1 minute'`;
        if ((answered?.count ?? 0) >= VIEWER_ROAST_LIMIT) return rejected("viewer_limit");
      }
      // Never below the plan's minimum, whatever the channel stored.
      const channelPause = effectiveCooldown(
        context.cooldownSec,
        context.planCode,
        context.minCooldownSec
      );
      const viewerPause = effectiveCooldown(
        context.userCooldownSec,
        context.planCode,
        context.minCooldownSec
      );
      await tx`
        insert into cooldown_state(channel_id,scope,subject_key,next_allowed_at) values
         (${job.channelId},'channel','*',now()+${channelPause}*interval '1 second'),
         (${job.channelId},'viewer',${job.viewerLogin},now()+${viewerPause}*interval '1 second')
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

/** Reservations against the owner's monthly caps for the paid voices. */
export async function voiceReservations(deps: PipelineDependencies): Promise<VoiceReservations> {
  const clock = () => deps.now?.() ?? new Date();
  const yandexLimitRub = await globalValue<number>(
    deps.sql,
    "yandex_tts_monthly_limit_rub",
    DEFAULT_YANDEX_TTS_MONTHLY_LIMIT_RUB
  );
  const elevenLabsLimit = await elevenLabsCharLimit(deps.sql);
  return {
    yandex: (requests) => reserveYandexRequests(deps.sql, clock(), requests, yandexLimitRub),
    elevenlabs: (characters) =>
      reserveElevenLabsCharacters(deps.sql, clock(), characters, elevenLabsLimit),
    releaseElevenlabs: (characters) => releaseElevenLabsCharacters(deps.sql, clock(), characters)
  };
}
