// Back-office (/admin): the owner's overview, accounts, plans, moderation and global settings.
import {
  DEFAULT_DEMO_DAILY_LIMIT,
  DEFAULT_ELEVENLABS_MONTHLY_CHAR_LIMIT,
  DEFAULT_GLOBAL_MONTHLY_ROAST_CAP,
  DEFAULT_MONTHLY_BUDGET_USD,
  DEFAULT_YANDEX_TTS_MONTHLY_LIMIT_RUB,
  ELEVENLABS_PLAN_MARGIN,
  YANDEX_TTS_RUB_PER_REQUEST,
  channelOverrideSchema,
  economyVoiceSchema,
  roastStatusSchema,
  yandexBillingMonth
} from "@roastbot/shared";
import type { FastifyInstance } from "fastify";
import { z } from "zod";

import {
  currentDay,
  currentMonth,
  demoSpend,
  denied,
  session,
  type RouteContext
} from "./context.js";
import { roastDetail, roastIdParams } from "./dashboard.js";

const modelSchema = z.string().regex(/^claude-[a-z0-9-]+$/u);

// Global settings the owner may edit, each with its own validation so a typo in /admin can never
// store a value the worker cannot use.
const globalSettingSchemas = {
  kill_switch: z.boolean(),
  global_monthly_limit: z.number().int().min(0).max(1_000_000),
  monthly_budget_usd: z.number().min(0).max(10_000),
  model: modelSchema,
  classifier_model: modelSchema,
  // Chat words on the premium tier; paid events, the command and rewards get `model`.
  chat_model: modelSchema,
  input_retention_days: z.number().int().min(1).max(30),
  yandex_tts_monthly_limit_rub: z.number().min(0).max(100_000),
  elevenlabs_monthly_char_limit: z.number().int().min(0).max(10_000_000),
  // Landing demo answers a day for the whole service; 0 hides the demo.
  demo_daily_limit: z.number().int().min(0).max(1_000),
  // Open registration's brakes: new accounts a day (0 sends everyone to review) and the youngest
  // Twitch account that skips review.
  signup_daily_limit: z.number().int().min(0).max(10_000),
  signup_min_account_age_days: z.number().int().min(0).max(3_650)
} as const;
type GlobalSettingKey = keyof typeof globalSettingSchemas;

const stopWordsSchema = z.array(z.string().trim().min(1).max(100)).max(1000);
const twitchLoginSchema = z
  .string()
  .trim()
  .transform((value) => value.replace(/^@/u, "").toLowerCase())
  .pipe(z.string().regex(/^[a-z0-9_]{3,25}$/u, "Некорректный логин Twitch"));
const userIdParams = z.object({ id: z.string().uuid() });

export function registerAdminRoutes(app: FastifyInstance, context: RouteContext) {
  const { sql, requireOwner, audit } = context;

  app.get("/admin/overview", { preHandler: requireOwner }, async () => {
    const month = currentMonth();
    const [row] = await sql<
      {
        usersTotal: number;
        usersActive: number;
        usersPending: number;
        activeChannelsHour: number;
        roastsToday: number;
        errorsToday: number;
        blockedToday: number;
        skippedToday: number;
        roastsMonth: number;
        spentMonth: number;
        demoSpentMonth: number;
        demoToday: number;
        demoLimit: number;
        roastCap: number;
        budget: number;
        killSwitch: boolean;
        pendingModeration: number;
      }[]
    >`
      select
        (select count(*) from users)::int "usersTotal",
        (select count(*) from users where status='active')::int "usersActive",
        (select count(*) from users where status='pending')::int "usersPending",
        (select count(distinct channel_id) from roasts where created_at>now()-interval '1 hour')::int
          "activeChannelsHour",
        (select count(*) from roasts where created_at>=date_trunc('day',now())
          and status in ('done','blocked_output'))::int "roastsToday",
        (select count(*) from roasts where created_at>=date_trunc('day',now())
          and status='failed')::int "errorsToday",
        (select count(*) from roasts where created_at>=date_trunc('day',now())
          and status in ('blocked_input','blocked_output'))::int "blockedToday",
        (select count(*) from roasts where created_at>=date_trunc('day',now())
          and status='skipped')::int "skippedToday",
        (select coalesce(sum(roasts),0) from usage_monthly where month=${month})::int "roastsMonth",
        ((select coalesce(sum(cost_usd),0) from usage_monthly where month=${month})
          + ${demoSpend(sql, month)})::float8 "spentMonth",
        ${demoSpend(sql, month)}::float8 "demoSpentMonth",
        (select count(*) from demo_requests where day=${currentDay()})::int "demoToday",
        coalesce((select (value #>> '{}')::int from global_settings where key='demo_daily_limit'),
          ${DEFAULT_DEMO_DAILY_LIMIT})::int "demoLimit",
        coalesce((select (value #>> '{}')::int from global_settings where key='global_monthly_limit'),
          ${DEFAULT_GLOBAL_MONTHLY_ROAST_CAP})::int "roastCap",
        coalesce((select (value #>> '{}')::float8 from global_settings where key='monthly_budget_usd'),
          ${DEFAULT_MONTHLY_BUDGET_USD})::float8 budget,
        coalesce((select (value #>> '{}')::boolean from global_settings where key='kill_switch'),false)
          "killSwitch",
        (select count(*) from roasts where moderation_reviewed_at is null
          and status in ('blocked_input','blocked_output'))::int "pendingModeration"`;
    const [tts] = await sql<
      {
        requests: number;
        limitRub: number;
        elevenLabsChars: number;
        elevenLabsLimit: number;
        elevenLabsPlan: { limit: number; resetAt: string | null; syncedAt: string } | null;
      }[]
    >`
      select coalesce((select requests from tts_usage_monthly
          where provider='yandex' and month=${yandexBillingMonth(new Date())}),0)::int requests,
        coalesce((select (value #>> '{}')::float8 from global_settings
          where key='yandex_tts_monthly_limit_rub'), ${DEFAULT_YANDEX_TTS_MONTHLY_LIMIT_RUB})::float8 "limitRub",
        coalesce((select requests from tts_usage_monthly
          where provider='elevenlabs' and month=${new Date().toISOString().slice(0, 7)}),0)::int
          "elevenLabsChars",
        coalesce((select (value #>> '{}')::int from global_settings
          where key='elevenlabs_monthly_char_limit'), ${DEFAULT_ELEVENLABS_MONTHLY_CHAR_LIMIT})::int
          "elevenLabsLimit",
        (select value from global_settings where key='elevenlabs_subscription') "elevenLabsPlan"`;
    // The worker syncs ElevenLabs' own count and plan; the cap is never above the plan.
    const plan = tts?.elevenLabsPlan ?? null;
    const ownerLimit = tts?.elevenLabsLimit ?? DEFAULT_ELEVENLABS_MONTHLY_CHAR_LIMIT;
    return {
      ...row,
      yandexTtsSpentRub: Math.round((tts?.requests ?? 0) * YANDEX_TTS_RUB_PER_REQUEST * 100) / 100,
      yandexTtsLimitRub: tts?.limitRub ?? DEFAULT_YANDEX_TTS_MONTHLY_LIMIT_RUB,
      elevenLabsChars: tts?.elevenLabsChars ?? 0,
      elevenLabsLimit: plan
        ? Math.min(ownerLimit, Math.max(0, plan.limit - ELEVENLABS_PLAN_MARGIN))
        : ownerLimit,
      elevenLabsResetAt: plan?.resetAt ?? null,
      elevenLabsSyncedAt: plan?.syncedAt ?? null
    };
  });

  app.get("/admin/users", { preHandler: requireOwner }, async (request) => {
    const q = z
      .object({
        search: z.string().max(64).default(""),
        limit: z.coerce.number().int().min(1).max(100).default(50)
      })
      .parse(request.query);
    const month = currentMonth();
    return sql`
      select u.id, u.twitch_id, u.login, u.display_name, u.role, u.status, u.created_at,
        u.totp_enabled_at is not null mfa_enabled, c.id channel_id, c.twitch_login, s.enabled,
        coalesce(p.code::text,'none') plan, sub.valid_until,
        coalesce(um.roasts,0)::int used,
        coalesce(o.monthly_roast_limit, p.monthly_roast_limit, 0)::int "limit",
        coalesce(um.cost_usd,0)::float8 cost_usd,
        coalesce((select sum(amount-used) from gifted_quota g
          where g.channel_id=c.id and g.month=${month}),0)::int gifted,
        (u.role='owner' or coalesce(o.unlimited,false)) unlimited,
        case when o.channel_id is null then null else jsonb_build_object(
          'unlimited',o.unlimited,'zeroRegrets',o.zero_regrets,
          'monthlyRoastLimit',o.monthly_roast_limit,
          'premiumRoasts',o.premium_roasts,'minCooldownSec',o.min_cooldown_sec,'model',o.model,
          'chatModel',o.chat_model,'economyModel',o.economy_model,'economyVoice',o.economy_voice,
          'note',o.note) end override,
        coalesce(um.premium_roasts,0)::int premium_used, p.premium_roasts plan_premium_roasts,
        p.monthly_roast_limit plan_limit
      from users u left join channels c on c.user_id=u.id
      left join settings s on s.channel_id=c.id
      left join channel_overrides o on o.channel_id=c.id
      left join lateral (
        select plan_id, valid_until from subscriptions where user_id=u.id
        and (valid_until is null or valid_until>now()) order by created_at desc limit 1
      ) sub on true
      left join plans p on p.id=sub.plan_id
      left join usage_monthly um on um.channel_id=c.id and um.month=${month}
      where u.login ilike ${`%${q.search}%`}
      order by u.status='pending' desc, u.created_at desc limit ${q.limit}`;
  });

  app.post("/admin/users/:id/suspend", { preHandler: requireOwner }, async (request) => {
    const { id } = userIdParams.parse(request.params);
    await sql.begin(async (tx) => {
      await tx`update users set status='suspended' where id=${id}`;
      await audit(tx, request, "user.suspend", id, {});
    });
    return { id, status: "suspended" };
  });
  app.post("/admin/users/:id/activate", { preHandler: requireOwner }, async (request) => {
    const { id } = userIdParams.parse(request.params);
    await sql.begin(async (tx) => {
      await tx`update users set status='active' where id=${id}`;
      await audit(tx, request, "user.activate", id, {});
    });
    return { id, status: "active" };
  });
  // Favourites: the owner's exceptions to the plan for one channel. Saving all-null fields with
  // unlimited off is the same as removing the row.
  app.put("/admin/users/:id/override", { preHandler: requireOwner }, async (request, reply) => {
    const { id } = userIdParams.parse(request.params);
    const body = channelOverrideSchema.parse(request.body);
    const [channel] = await sql<{ id: string }[]>`select id from channels where user_id=${id}`;
    if (!channel) return denied(reply, 404, "channel_not_found", "У аккаунта нет канала");
    const empty = Object.values(body).every(
      (value) => value === null || value === "" || value === false
    );
    await sql.begin(async (tx) => {
      if (empty) await tx`delete from channel_overrides where channel_id=${channel.id}`;
      else {
        await tx`insert into channel_overrides(channel_id,unlimited,zero_regrets,monthly_roast_limit,
            premium_roasts,min_cooldown_sec,model,chat_model,economy_model,economy_voice,note,
            updated_by_user_id)
          values(${channel.id},${body.unlimited},${body.zeroRegrets},${body.monthlyRoastLimit},
            ${body.premiumRoasts},
            ${body.minCooldownSec},${body.model},${body.chatModel},${body.economyModel},
            ${body.economyVoice},${body.note || null},${session(request).userId})
          on conflict(channel_id) do update set unlimited=excluded.unlimited,
            zero_regrets=excluded.zero_regrets,
            monthly_roast_limit=excluded.monthly_roast_limit, premium_roasts=excluded.premium_roasts,
            min_cooldown_sec=excluded.min_cooldown_sec, model=excluded.model,
            chat_model=excluded.chat_model, economy_model=excluded.economy_model,
            economy_voice=excluded.economy_voice, note=excluded.note,
            updated_by_user_id=excluded.updated_by_user_id, updated_at=now()`;
      }
      await audit(tx, request, empty ? "override.delete" : "override.set", id, body);
    });
    return { id, override: empty ? null : body };
  });

  // Support case: a streamer lost the phone and the recovery codes. The owner's own factor is
  // never reset from the UI: a stolen owner session must not be able to drop the owner's 2FA.
  app.post("/admin/users/:id/mfa/reset", { preHandler: requireOwner }, async (request, reply) => {
    const { id } = userIdParams.parse(request.params);
    if (id === session(request).userId) {
      return denied(reply, 400, "mfa_self_reset", "Свою 2FA сбросить нельзя");
    }
    await sql.begin(async (tx) => {
      await tx`update users set totp_secret_ciphertext=null, totp_secret_iv=null,
        totp_secret_tag=null, totp_enabled_at=null, totp_last_step=null,
        mfa_recovery_hashes=ARRAY[]::text[], mfa_failed_attempts=0, mfa_locked_until=null
        where id=${id}`;
      await audit(tx, request, "mfa.reset", id, {});
    });
    return { id, mfaEnabled: false };
  });

  // Pre-approval by Twitch login: whoever signs in with it skips the review queue once.
  app.get(
    "/admin/invites",
    { preHandler: requireOwner },
    async () =>
      sql`select i.login, i.created_at, i.used_at, u.login used_by_login
      from invites i left join users u on u.id=i.used_by_user_id
      order by i.used_at is not null, i.created_at desc limit 200`
  );
  app.post("/admin/invites", { preHandler: requireOwner }, async (request) => {
    const { login } = z.object({ login: twitchLoginSchema }).parse(request.body);
    const approvedExisting = await sql.begin(async (tx) => {
      await tx`insert into invites(login,created_by_user_id)
        values(${login},${session(request).userId}) on conflict (login) do nothing`;
      // Someone with this login already signed in and waits for review: approve right away.
      const [waiting] = await tx<{ id: string }[]>`
        update users set status='active' where login=${login} and status='pending' returning id`;
      if (waiting) {
        await tx`update invites set used_at=now(), used_by_user_id=${waiting.id}
          where login=${login} and used_at is null`;
      }
      await audit(tx, request, "invite.create", login, { approvedExisting: Boolean(waiting) });
      return Boolean(waiting);
    });
    return { login, approvedExisting };
  });
  app.delete("/admin/invites/:login", { preHandler: requireOwner }, async (request) => {
    const { login } = z.object({ login: twitchLoginSchema }).parse(request.params);
    const deleted = await sql.begin(async (tx) => {
      const rows = await tx`delete from invites where login=${login} and used_at is null
        returning login`;
      await audit(tx, request, "invite.delete", login, {});
      return rows.length > 0;
    });
    return { login, deleted };
  });

  app.post("/admin/users/:id/subscription", { preHandler: requireOwner }, async (request) => {
    const { id } = userIdParams.parse(request.params);
    const body = z
      .object({
        plan: z.enum(["free", "basic", "premium"]),
        validUntil: z.string().datetime().nullable()
      })
      .parse(request.body);
    await sql.begin(async (tx) => {
      const inserted = await tx`insert into subscriptions(user_id,plan_id,valid_until)
        select ${id},id,${body.validUntil} from plans where code=${body.plan} returning id`;
      if (!inserted.length) throw Object.assign(new Error("Тариф не найден"), { statusCode: 404 });
      await audit(tx, request, "subscription.set", id, body);
    });
    return { id, ...body };
  });
  app.post("/admin/users/:id/gift", { preHandler: requireOwner }, async (request) => {
    const { id } = userIdParams.parse(request.params);
    const body = z
      .object({
        amount: z.number().int().positive().max(100_000),
        reason: z.string().max(500).optional()
      })
      .parse(request.body);
    await sql.begin(async (tx) => {
      const inserted =
        await tx`insert into gifted_quota(channel_id,month,amount,granted_by_user_id,reason)
        select id,${currentMonth()},${body.amount},${session(request).userId},${body.reason ?? null}
        from channels where user_id=${id} returning id`;
      if (!inserted.length) throw Object.assign(new Error("Канал не найден"), { statusCode: 404 });
      await audit(tx, request, "quota.gift", id, body);
    });
    return { id, ...body };
  });

  app.get("/admin/roasts", { preHandler: requireOwner }, async (request) => {
    const q = z
      .object({
        channelId: z.string().uuid().optional(),
        // A login is easier to share in a link than a UUID.
        channel: z
          .string()
          .trim()
          .max(64)
          .transform((value) => value.replace(/^[@#]/u, "").toLowerCase())
          .optional(),
        status: roastStatusSchema.optional(),
        from: z.string().datetime().optional(),
        to: z.string().datetime().optional(),
        limit: z.coerce.number().int().min(1).max(200).default(50)
      })
      .parse(request.query);
    return sql`select r.*, c.twitch_login from roasts r join channels c on c.id=r.channel_id
      where (${q.channelId ?? null}::uuid is null or r.channel_id=${q.channelId ?? null})
      and (${q.channel || null}::text is null or c.twitch_login=${q.channel || null})
      and (${q.status ?? null}::text is null or r.status::text=${q.status ?? null})
      and (${q.from ?? null}::timestamptz is null or r.created_at>=${q.from ?? null})
      and (${q.to ?? null}::timestamptz is null or r.created_at<=${q.to ?? null})
      order by r.created_at desc limit ${q.limit}`;
  });

  app.get("/admin/roasts/:id", { preHandler: requireOwner }, async (request, reply) => {
    const { id } = roastIdParams.parse(request.params);
    const [row] = await roastDetail(sql, id, null);
    if (!row) return denied(reply, 404, "not_found", "Роаст не найден");
    return row;
  });

  // Plans: limits and the model and voice tiers (the free plan's first roasts sound the best).
  app.get(
    "/admin/plans",
    { preHandler: requireOwner },
    async () =>
      sql`select code, monthly_roast_limit "monthlyRoastLimit", premium_roasts "premiumRoasts",
        economy_model "economyModel", economy_voice "economyVoice", stars_price "starsPrice"
      from plans order by monthly_roast_limit`
  );
  app.put("/admin/plans/:code", { preHandler: requireOwner }, async (request, reply) => {
    const { code } = z.object({ code: z.enum(["free", "basic", "premium"]) }).parse(request.params);
    // The monthly limit stays in code: the seed refreshes it on every deploy.
    const body = z
      .object({
        premiumRoasts: z.number().int().min(0).max(1_000_000).nullable(),
        economyModel: modelSchema,
        economyVoice: economyVoiceSchema,
        // Telegram Stars for 30 days; null takes the plan off sale. Paid subscriptions keep the
        // price they were bought at: the new one applies to new invoices.
        starsPrice: z.number().int().min(1).max(10_000).nullable()
      })
      .strict()
      .parse(request.body);
    const updated = await sql.begin(async (tx) => {
      const rows =
        await tx`update plans set premium_roasts=${body.premiumRoasts}, economy_model=${body.economyModel},
          economy_voice=${body.economyVoice}, stars_price=${body.starsPrice}
        where code=${code} returning code`;
      if (rows.length) await audit(tx, request, "plan.update", code, body);
      return rows.length > 0;
    });
    if (!updated) return denied(reply, 404, "not_found", "Тариф не найден");
    return { code, ...body };
  });

  app.get("/admin/moderation", { preHandler: requireOwner }, async () => {
    const [row] = await sql<{ value: string[] }[]>`
      select value from global_settings where key='global_stop_words'`;
    return { words: row?.value ?? [] };
  });
  app.put("/admin/moderation", { preHandler: requireOwner }, async (request) => {
    const words = [...new Set(stopWordsSchema.parse(request.body))];
    await sql.begin(async (tx) => {
      await tx`insert into global_settings(key,value) values('global_stop_words',${sql.json(words)})
        on conflict(key) do update set value=excluded.value,updated_at=now()`;
      await audit(tx, request, "global_stop_words.update", "global_stop_words", { words });
    });
    return { words };
  });
  app.get(
    "/admin/moderation/queue",
    { preHandler: requireOwner },
    async () =>
      sql`select r.id, r.channel_id, c.twitch_login, r.viewer_login, r.input_text, r.output_text,
        r.status, r.error, r.created_at
      from roasts r join channels c on c.id=r.channel_id
      where r.moderation_reviewed_at is null and r.status in ('blocked_input','blocked_output')
      order by r.created_at desc limit 100`
  );
  app.post("/admin/roasts/:id/review", { preHandler: requireOwner }, async (request, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    const body = z
      .object({ addStopWord: z.string().trim().min(1).max(100).optional() })
      .parse(request.body ?? {});
    const result = await sql.begin(async (tx) => {
      const updated = await tx`update roasts set moderation_reviewed_at=now()
        where id=${id} and moderation_reviewed_at is null and status in ('blocked_input','blocked_output')
        returning id`;
      if (!updated.length) return false;
      if (body.addStopWord) {
        await tx`insert into global_settings(key,value) values('global_stop_words',${sql.json([body.addStopWord])})
          on conflict(key) do update set value=(
            select coalesce(jsonb_agg(distinct w),'[]'::jsonb)
            from jsonb_array_elements_text(global_settings.value || excluded.value) w
          ),updated_at=now()`;
      }
      await audit(tx, request, "moderation.review", id, body);
      return true;
    });
    if (!result)
      return reply.code(404).send({ error: { code: "not_found", message: "Нет в очереди" } });
    return { id, reviewed: true };
  });

  app.get(
    "/admin/settings",
    { preHandler: requireOwner },
    async () => sql`select key, value, updated_at from global_settings order by key`
  );
  app.put("/admin/settings/:key", { preHandler: requireOwner }, async (request) => {
    const { key } = z
      .object({
        key: z.enum(Object.keys(globalSettingSchemas) as [GlobalSettingKey, ...GlobalSettingKey[]])
      })
      .parse(request.params);
    const value = globalSettingSchemas[key].parse(request.body);
    await sql.begin(async (tx) => {
      await tx`insert into global_settings(key,value) values(${key},${sql.json(value)})
        on conflict(key) do update set value=excluded.value,updated_at=now()`;
      await audit(tx, request, "global_setting.update", key, { value });
    });
    return { key, value };
  });
  app.get("/admin/audit", { preHandler: requireOwner }, async (request) => {
    const { limit, action } = z
      .object({
        limit: z.coerce.number().int().min(1).max(200).default(100),
        action: z
          .string()
          .regex(/^[a-z_.]{1,64}$/u)
          .optional()
      })
      .parse(request.query);
    // Most targets are user ids: show the login next to them.
    return sql`select a.*, u.login actor_login, t.login target_login from audit_log a
      left join users u on u.id=a.actor_user_id
      left join users t on t.id::text=a.target
      where (${action ?? null}::text is null or a.action=${action ?? null})
      order by a.created_at desc limit ${limit}`;
  });
}
