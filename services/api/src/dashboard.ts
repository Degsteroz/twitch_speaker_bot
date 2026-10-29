// The streamer's panel: settings, rewards, status, test roasts and the activity feed.
import { randomBytes, randomUUID } from "node:crypto";

import {
  BRANDED_PLANS,
  COMMAND_PLANS,
  DASHBOARD_TEST_DAILY_LIMIT,
  DEFAULT_GLOBAL_MONTHLY_ROAST_CAP,
  DEFAULT_MONTHLY_BUDGET_USD,
  gameContext,
  MAX_REGULAR_TOXICITY,
  ROAST_REQUESTED_QUEUE,
  ZERO_REGRETS_TOXICITY,
  channelSettingsSchema,
  effectiveCooldown,
  minCooldownSeconds,
  testRoastRequestSchema,
  updateSettingsRequestSchema,
  type UpdateSettingsRequest
} from "@roastbot/shared";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";

import { channelAccessToken } from "./channel-token.js";
import {
  currentDay,
  currentMonth,
  demoSpend,
  denied,
  session,
  type RouteContext,
  type Sql
} from "./context.js";
import type { Overlays } from "./overlay.js";
import { simulatedRoast } from "./simulator.js";
import { TwitchApiError, getChannelGame, getRewards } from "./twitch.js";

// One roast for its page (/roasts/<id>) and the test poll. The owner reads any channel's roast
// through /admin/roasts/:id.
export const roastDetail = (sql: Sql, id: string, channelId: string | null) => sql`
    select r.id, r.status, r.source, r.viewer_login "viewerLogin", r.input_text "inputText",
      r.output_text "outputText", r.error, r.latency_ms "latencyMs", r.created_at "createdAt",
      r.tier, r.model, r.voice_provider "voiceProvider", r.cost_usd::float8 "costUsd",
      c.twitch_login "channelLogin", o.status "overlayStatus",
      r.favorite_at is not null favorite, r.showcase_approved_at is not null "onShowcase",
      case when r.source='dashboard_test' then e.raw->>'kind' end "testKind"
    from roasts r join channels c on c.id=r.channel_id
    left join overlay_events o on o.roast_id=r.id
    left join events e on e.id=r.event_id
    where r.id=${id} and (${channelId}::uuid is null or r.channel_id=${channelId})`;
export const roastIdParams = z.object({ id: z.string().uuid() });

/** A stored 6 without the owner's tick (taken back later) is shown and played as 5. */
const allowedToxicity = (toxicity: number, zeroRegrets: boolean) =>
  toxicity === ZERO_REGRETS_TOXICITY && !zeroRegrets ? MAX_REGULAR_TOXICITY : toxicity;

export function registerDashboardRoutes(
  app: FastifyInstance,
  context: RouteContext,
  overlays: Overlays
) {
  const { sql, boss, config, requireUser } = context;

  app.post("/me/overlay-token/rotate", { preHandler: requireUser }, async (request) => {
    const { channelId } = session(request);
    const overlayToken = randomBytes(32).toString("base64url");
    await sql`update channels set overlay_token=${overlayToken} where id=${channelId}`;
    overlays.close(channelId, "token rotated");
    return { overlayToken };
  });

  // The plan's minimum pause applies whatever is stored; the panel sees and saves the real one.
  // The owner's override for the channel replaces the plan's floor; an unlimited channel has none.
  // It also says whether the owner opened toxicity 6 ("Ноль сожалений") for the channel.
  const pauseFloor = async (channelId: string) => {
    const [row] = await sql<
      {
        code: string | null;
        unlimited: boolean;
        minCooldownSec: number | null;
        zeroRegrets: boolean;
      }[]
    >`
      select p.code, (u.role='owner' or coalesce(o.unlimited,false)) unlimited,
        o.min_cooldown_sec "minCooldownSec",
        (u.role='owner' or coalesce(o.zero_regrets,false)) "zeroRegrets"
      from channels c join users u on u.id=c.user_id left join lateral (
        select plan_id from subscriptions sub where sub.user_id=c.user_id
        and (sub.valid_until is null or sub.valid_until>now()) order by sub.created_at desc limit 1
      ) sub on true left join plans p on p.id=sub.plan_id
      left join channel_overrides o on o.channel_id=c.id where c.id=${channelId}`;
    return {
      plan: row?.code ?? null,
      override: row?.unlimited ? 0 : (row?.minCooldownSec ?? null),
      zeroRegrets: row?.zeroRegrets ?? false
    };
  };
  const withPlanPauses = async <
    T extends { cooldown_sec: number; user_cooldown_sec: number; toxicity: number }
  >(
    row: T | undefined,
    channelId: string
  ) => {
    if (!row) return row;
    const { plan, override, zeroRegrets } = await pauseFloor(channelId);
    return {
      ...row,
      toxicity: allowedToxicity(row.toxicity, zeroRegrets),
      cooldown_sec: effectiveCooldown(row.cooldown_sec, plan, override),
      user_cooldown_sec: effectiveCooldown(row.user_cooldown_sec, plan, override)
    };
  };

  app.get("/settings", { preHandler: requireUser }, async (request) => {
    const { channelId } = session(request);
    const [row] = await sql<
      { cooldown_sec: number; user_cooldown_sec: number; toxicity: number }[]
    >`select * from settings where channel_id=${channelId}`;
    return withPlanPauses(row, channelId);
  });
  app.patch("/settings", { preHandler: requireUser }, async (request, reply) => {
    // Zod 4 fills defaults even into partial fields: keep only what the request actually sent,
    // or a one-field patch would reset triggers, stop words and toxicity to the defaults.
    const sent = request.body && typeof request.body === "object" ? request.body : {};
    const patch: UpdateSettingsRequest = Object.fromEntries(
      Object.entries(updateSettingsRequestSchema.parse(sent)).filter(([key]) => key in sent)
    );
    const [current] = await sql<{ settings: unknown }[]>`
      select jsonb_build_object('tone',tone,'voice',voice,'toxicity',toxicity,'cooldownSec',cooldown_sec,
       'userCooldownSec',user_cooldown_sec,'triggers',triggers,'stopWords',stop_words,'enabled',enabled) settings
      from settings where channel_id=${session(request).channelId}`;
    const merged = channelSettingsSchema.parse({ ...(current?.settings as object), ...patch });
    const { plan, override, zeroRegrets } = await pauseFloor(session(request).channelId);
    if (patch.toxicity === ZERO_REGRETS_TOXICITY && !zeroRegrets) {
      return denied(reply, 403, "zero_regrets_not_allowed", "Этот уровень открывает владелец");
    }
    const [updated] = await sql<{ cooldown_sec: number; user_cooldown_sec: number }[]>`
      update settings set tone=${merged.tone}, voice=${merged.voice},
       toxicity=${allowedToxicity(merged.toxicity, zeroRegrets)},
       cooldown_sec=${effectiveCooldown(merged.cooldownSec, plan, override)},
       user_cooldown_sec=${effectiveCooldown(merged.userCooldownSec, plan, override)},
       triggers=${sql.json(merged.triggers)}, stop_words=${merged.stopWords}, enabled=${merged.enabled},
       updated_at=now() where channel_id=${session(request).channelId} returning *`;
    return updated;
  });
  app.post("/settings/enabled", { preHandler: requireUser }, async (request) => {
    const { enabled } = z.object({ enabled: z.boolean() }).parse(request.body);
    await sql`update settings set enabled=${enabled}, updated_at=now()
      where channel_id=${session(request).channelId}`;
    return { enabled };
  });

  app.get("/rewards", { preHandler: requireUser }, async (request) => {
    const { channelId } = session(request);
    try {
      let credentials = await channelAccessToken(sql, config, channelId);
      if (!credentials) return { available: false, reason: "reauth_required", rewards: [] };
      try {
        return {
          available: true,
          rewards: await getRewards(
            credentials.token,
            config.TWITCH_CLIENT_ID,
            credentials.twitchId
          )
        };
      } catch (error) {
        if (!(error instanceof TwitchApiError) || error.status !== 401) throw error;
        credentials = await channelAccessToken(sql, config, channelId, true);
        if (!credentials) throw error;
        return {
          available: true,
          rewards: await getRewards(
            credentials.token,
            config.TWITCH_CLIENT_ID,
            credentials.twitchId
          )
        };
      }
    } catch (error) {
      if (error instanceof TwitchApiError) {
        // Helix answers 403 for channels without affiliate/partner status: no Channel Points.
        const reason =
          error.status === 403
            ? "not_affiliate"
            : error.status === 400 || error.status === 401
              ? "reauth_required"
              : "twitch_unavailable";
        return { available: false, reason, rewards: [] };
      }
      throw error;
    }
  });

  const channelStatus = async (request: FastifyRequest) => {
    const month = currentMonth();
    const [row] = await sql<
      {
        enabled: boolean;
        userStatus: string;
        used: number;
        limit: number;
        gifted: number;
        plan: string | null;
        premiumRoasts: number | null;
        premiumUsed: number;
        testsUsed: number;
        unlimited: boolean;
        minCooldownSec: number | null;
        zeroRegrets: boolean;
      }[]
    >`
      select s.enabled, u.status "userStatus", coalesce(um.roasts,0)::int used, p.code plan,
        coalesce(o.monthly_roast_limit, p.monthly_roast_limit, 0)::int "limit",
        case when o.premium_roasts is not null then o.premium_roasts else p.premium_roasts end
          "premiumRoasts",
        (u.role='owner' or coalesce(o.unlimited,false)) unlimited,
        (u.role='owner' or coalesce(o.zero_regrets,false)) "zeroRegrets",
        o.min_cooldown_sec "minCooldownSec",
        coalesce(um.premium_roasts,0)::int "premiumUsed",
        coalesce((select roasts from test_usage_daily
          where channel_id=c.id and day=${currentDay()}),0)::int "testsUsed",
        coalesce((select sum(amount-used) from gifted_quota
          where channel_id=c.id and month=${month}),0)::int gifted
      from channels c join users u on u.id=c.user_id join settings s on s.channel_id=c.id
      left join lateral (
        select plan_id from subscriptions sub where sub.user_id=c.user_id
        and (sub.valid_until is null or sub.valid_until>now()) order by sub.created_at desc limit 1
      ) sub on true
      left join plans p on p.id=sub.plan_id
      left join channel_overrides o on o.channel_id=c.id
      left join usage_monthly um on um.channel_id=c.id and um.month=${month}
      where c.id=${session(request).channelId}`;
    if (!row) throw new Error("channel_not_found");
    const [global] = await sql<
      { used: number; spent: number; cap: number; budget: number; kill: boolean }[]
    >`
      select coalesce(sum(roasts),0)::int used,
        (coalesce(sum(cost_usd),0) + ${demoSpend(sql, month)})::float8 spent,
        coalesce((select (value #>> '{}')::int from global_settings where key='global_monthly_limit'),
          ${DEFAULT_GLOBAL_MONTHLY_ROAST_CAP})::int cap,
        coalesce((select (value #>> '{}')::float8 from global_settings where key='monthly_budget_usd'),
          ${DEFAULT_MONTHLY_BUDGET_USD})::float8 budget,
        coalesce((select (value #>> '{}')::boolean from global_settings where key='kill_switch'),false) kill
      from usage_monthly where month=${month}`;
    const globalLimitReached =
      (global?.used ?? 0) >= (global?.cap ?? DEFAULT_GLOBAL_MONTHLY_ROAST_CAP) ||
      (global?.spent ?? 0) >= (global?.budget ?? DEFAULT_MONTHLY_BUDGET_USD);
    const remaining = Math.max(0, row.limit + row.gifted - row.used);
    const killSwitch = global?.kill ?? false;
    const state =
      row.userStatus !== "active"
        ? "suspended"
        : !row.enabled || killSwitch
          ? "paused"
          : (remaining === 0 && !row.unlimited) || globalLimitReached
            ? "limit"
            : "working";
    const channelId = session(request).channelId;
    const [eventsub] = await sql<{ connected: boolean; subscriptions: Record<string, string> }[]>`
      select connected, subscriptions from eventsub_state where channel_id=${channelId}`;
    return {
      month,
      plan: row.plan,
      // Is it actually on air: the overlay page is open somewhere (OBS), and Twitch accepted our
      // EventSub subscriptions (null when the channel needs none).
      overlayConnected: overlays.connected(channelId),
      twitchEvents: eventsub
        ? {
            connected: eventsub.connected,
            failed: Object.entries(eventsub.subscriptions)
              .filter(([, result]) => result !== "ok")
              .map(([type]) => type)
          }
        : null,
      // The owner's channel and unlimited favourites: no quota, pauses or test limit.
      unlimited: row.unlimited,
      // The panel shows toxicity 6, "Ноль сожалений", only when the owner opened it.
      zeroRegrets: row.zeroRegrets,
      // `!роаст` is a paid feature; the panel shows the switch disabled on the free plan.
      commandAvailable: row.unlimited || COMMAND_PLANS.has(row.plan ?? ""),
      // The shortest pause the plan (or the owner's override) allows; the fields start there.
      minCooldownSec: row.unlimited ? 0 : minCooldownSeconds(row.plan, row.minCooldownSec),
      branding: BRANDED_PLANS.has(row.plan ?? ""),
      // Best model and voice left this month; null when every roast gets them.
      premium:
        row.premiumRoasts === null || row.unlimited
          ? null
          : {
              total: row.premiumRoasts,
              remaining: Math.max(0, row.premiumRoasts - row.premiumUsed)
            },
      // null: no daily test limit.
      tests: row.unlimited
        ? null
        : {
            limit: DASHBOARD_TEST_DAILY_LIMIT,
            remaining: Math.max(0, DASHBOARD_TEST_DAILY_LIMIT - row.testsUsed)
          },
      enabled: row.enabled,
      used: row.used,
      limit: row.limit,
      gifted: row.gifted,
      remaining,
      globalLimitReached,
      killSwitch,
      state
    };
  };
  app.get("/status", { preHandler: requireUser }, channelStatus);
  app.get("/quota", { preHandler: requireUser }, channelStatus);

  app.post("/roasts/test", { preHandler: requireUser }, async (request, reply) => {
    const body = testRoastRequestSchema.parse(request.body ?? {});
    const { channelId } = session(request);
    // A quick answer for the panel; the worker's booking under its lock is the real limit.
    const [tests] = await sql<{ roasts: number; unlimited: boolean }[]>`
      select coalesce((select roasts from test_usage_daily
          where channel_id=c.id and day=${currentDay()}),0)::int roasts,
        (u.role='owner' or coalesce(o.unlimited,false)) unlimited
      from channels c join users u on u.id=c.user_id
      left join channel_overrides o on o.channel_id=c.id where c.id=${channelId}`;
    if (!tests?.unlimited && (tests?.roasts ?? 0) >= DASHBOARD_TEST_DAILY_LIMIT) {
      return denied(
        reply,
        429,
        "test_limit_reached",
        `Тесты на сегодня закончились: ${String(DASHBOARD_TEST_DAILY_LIMIT)} в день. Квоту эфира они не тратят.`
      );
    }
    const simulated = simulatedRoast(body);
    // The same context as a live roast; a test never waits on Twitch for more than 2 seconds.
    const game = await channelAccessToken(sql, config, channelId)
      .then((credentials) =>
        credentials
          ? getChannelGame(credentials.token, config.TWITCH_CLIENT_ID, credentials.twitchId)
          : ""
      )
      .then(gameContext)
      .catch(() => undefined);
    const { eventId, roastId } = await sql.begin(async (tx) => {
      const [event] = await tx<{ id: string }[]>`
        insert into events (channel_id,type,provider_event_id,raw)
        values (${channelId},'dashboard_test',${randomUUID()},${sql.json(body)}) returning id`;
      if (!event) throw new Error("Event insert failed");
      const [roast] = await tx<{ id: string }[]>`
        insert into roasts(channel_id,event_id,source,viewer_login,input_text,tone,voice,toxicity)
        select ${channelId},${event.id},'dashboard_test',${simulated.viewerLogin},
          ${simulated.inputText},tone,voice,toxicity from settings
        where channel_id=${channelId} returning id`;
      if (!roast) throw new Error("Roast insert failed");
      return { eventId: event.id, roastId: roast.id };
    });
    // Enqueue only after commit: the worker must be able to see the event row.
    await boss.send(ROAST_REQUESTED_QUEUE, {
      jobVersion: 1,
      eventId,
      channelId,
      source: "dashboard_test",
      viewerLogin: simulated.viewerLogin,
      inputText: simulated.inputText,
      target: simulated.target,
      ...(simulated.eventSummary ? { eventSummary: simulated.eventSummary } : {}),
      ...(game ? { game } : {}),
      requestedAt: new Date().toISOString()
    });
    return { roastId, status: "queued" };
  });

  // What reached the bot lately and how it ended, plus Twitch's answer to our subscriptions: a
  // streamer whose reward "does nothing" sees here whether the redemption arrived at all.
  app.get("/activity", { preHandler: requireUser }, async (request) => {
    const { channelId } = session(request);
    const roasts = await sql`
      select r.id, r.created_at "createdAt", r.source, r.viewer_login "viewerLogin",
        left(r.input_text, 120) "inputText", r.output_text "outputText", r.status, r.error,
        o.status "overlayStatus", r.favorite_at is not null favorite,
        case when r.source='dashboard_test' then e.raw->>'kind' end "testKind"
      from roasts r left join overlay_events o on o.roast_id=r.id
      left join events e on e.id=r.event_id
      where r.channel_id=${channelId} order by r.created_at desc limit 15`;
    const [eventsub] = await sql`
      select connected, subscriptions, updated_at "updatedAt" from eventsub_state
      where channel_id=${channelId}`;
    return { roasts, eventsub: eventsub ?? null };
  });

  app.get("/roasts/:id", { preHandler: requireUser }, async (request, reply) => {
    const { id } = roastIdParams.parse(request.params);
    const [row] = await roastDetail(sql, id, session(request).channelId);
    if (!row) return denied(reply, 404, "not_found", "Роаст не найден");
    return row;
  });
}
