// The streamer's Telegram bot and plans for Telegram Stars.
//
// Linking: the panel creates a one-time code, the streamer opens t.me/<bot>?start=<code>, the
// webhook ties that chat to the channel. Payments: the panel asks for an invoice link (a 30-day
// Stars subscription), Telegram asks us to confirm before charging (pre_checkout_query) and then
// reports the payment (successful_payment), also on every renewal. Each payment adds a
// subscription until the date Telegram gives; the charge id makes a redelivered update harmless.
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

import {
  STARS_SUBSCRIPTION_SECONDS,
  parseStarsPayload,
  starsPayload,
  telegramCall
} from "@roastbot/shared";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";

import { denied, session, type RouteContext, type Sql } from "./context.js";

const LINK_TTL_MS = 10 * 60_000;
const hash = (value: string) => createHash("sha256").update(value).digest("hex");

const PLAN_TITLES: Record<string, string> = { basic: "Basic", premium: "Premium" };

/** "1000 роастов на 30 дней, из них 200 — лучшая модель и голос". */
export function planDescription(limit: number, premium: number | null): string {
  const best =
    premium === null || premium >= limit
      ? "все на лучшей модели и голосе"
      : `из них ${String(premium)} на лучшей модели и голосе`;
  return `${String(limit)} роастов на 30 дней, ${best}. Продлевается автоматически, отменить можно в Telegram.`;
}

const updateSchema = z
  .object({
    pre_checkout_query: z
      .object({
        id: z.string(),
        currency: z.string(),
        total_amount: z.number().int(),
        invoice_payload: z.string()
      })
      .passthrough()
      .optional(),
    message: z
      .object({
        chat: z.object({ id: z.number() }).passthrough(),
        from: z
          .object({ id: z.number(), username: z.string().optional() })
          .passthrough()
          .optional(),
        text: z.string().optional(),
        successful_payment: z
          .object({
            currency: z.string(),
            total_amount: z.number().int(),
            invoice_payload: z.string(),
            telegram_payment_charge_id: z.string(),
            subscription_expiration_date: z.number().int().optional(),
            is_recurring: z.boolean().optional()
          })
          .passthrough()
          .optional()
      })
      .passthrough()
      .optional()
  })
  .passthrough();

export function registerTelegramRoutes(app: FastifyInstance, context: RouteContext) {
  const { sql, config, requireUser, requireOwner, audit } = context;
  const token = config.TELEGRAM_BOT_TOKEN;
  const bot = config.TELEGRAM_BOT_USERNAME?.replace(/^@/u, "");
  const configured = Boolean(token && bot && config.TELEGRAM_WEBHOOK_SECRET);
  const call = <T>(method: string, body: Record<string, unknown>) =>
    telegramCall<T>(token!, method, body);
  const reply = (chatId: number | string, text: string) =>
    call("sendMessage", { chat_id: chatId, text, disable_web_page_preview: true }).catch(
      (error: unknown) => app.log.warn(error, "telegram reply")
    );

  const webhookUrl = `${config.PUBLIC_URL}/telegram/webhook`;
  const registerWebhook = () =>
    call("setWebhook", {
      url: webhookUrl,
      secret_token: config.TELEGRAM_WEBHOOK_SECRET,
      allowed_updates: ["message", "pre_checkout_query"]
    });

  // Right after the container starts the network may not be ready, and Telegram may answer 5xx:
  // one failed attempt must not leave the bot deaf until the next restart. Retries run in the
  // background and never hold up the API.
  const registerWithRetry = async () => {
    for (let attempt = 1; attempt <= 6; attempt += 1) {
      try {
        await registerWebhook();
        app.log.info({ url: webhookUrl }, "telegram webhook registered");
        return;
      } catch (error) {
        app.log.error({ err: error, attempt }, "telegram setWebhook failed");
        if (attempt < 6) await new Promise((resolve) => setTimeout(resolve, 15_000 * attempt));
      }
    }
  };
  if (configured && config.NODE_ENV !== "test") {
    app.addHook("onReady", () => {
      void registerWithRetry();
    });
  }

  // ---- linking -------------------------------------------------------------------------------
  app.get("/integrations/telegram", { preHandler: requireUser }, async (request) => {
    const [row] = await sql<{ username: string | null }[]>`
      select username from telegram_accounts where channel_id=${session(request).channelId}`;
    return {
      configured,
      connected: Boolean(row),
      username: row?.username ?? null,
      bot: bot ?? null
    };
  });

  app.post("/integrations/telegram/link", { preHandler: requireUser }, async (request, reply) => {
    if (!configured) return denied(reply, 404, "not_configured", "Telegram-бот не настроен");
    const code = randomBytes(18).toString("base64url");
    await sql`insert into telegram_link_tokens(token_hash,channel_id,expires_at)
      values(${hash(code)},${session(request).channelId},${new Date(Date.now() + LINK_TTL_MS)})`;
    return { url: `https://t.me/${bot!}?start=${code}` };
  });

  app.post("/integrations/telegram/disconnect", { preHandler: requireUser }, async (request) => {
    await sql`delete from telegram_accounts where channel_id=${session(request).channelId}`;
    return { connected: false };
  });

  // ---- billing -------------------------------------------------------------------------------
  app.get("/billing", { preHandler: requireUser }, async (request) => {
    const { channelId } = session(request);
    const plans = await sql`
      select code, stars_price "starsPrice", monthly_roast_limit "monthlyRoastLimit",
        premium_roasts "premiumRoasts"
      from plans where stars_price is not null order by stars_price`;
    const [current] = await sql`
      select p.code plan, sub.valid_until "validUntil", sub.source
      from channels c join subscriptions sub on sub.user_id=c.user_id
      join plans p on p.id=sub.plan_id
      where c.id=${channelId} and (sub.valid_until is null or sub.valid_until>now())
      order by sub.created_at desc limit 1`;
    const payments = await sql`
      select plan, stars, valid_until "validUntil", recurring, refunded_at "refundedAt",
        created_at "createdAt"
      from star_payments where channel_id=${channelId} order by created_at desc limit 10`;
    return { available: configured, plans, current: current ?? null, payments };
  });

  app.post("/billing/checkout", { preHandler: requireUser }, async (request, reply) => {
    if (!configured) return denied(reply, 404, "not_configured", "Оплата сейчас недоступна");
    const { plan } = z.object({ plan: z.enum(["basic", "premium"]) }).parse(request.body);
    const [row] = await sql<{ price: number | null; limit: number; premium: number | null }[]>`
      select stars_price price, monthly_roast_limit "limit", premium_roasts premium
      from plans where code=${plan}`;
    if (!row?.price) return denied(reply, 404, "not_for_sale", "Этот тариф не продаётся");
    const url = await call<string>("createInvoiceLink", {
      title: `RoastBot ${PLAN_TITLES[plan] ?? plan}`,
      description: planDescription(row.limit, row.premium),
      payload: starsPayload(session(request).channelId, plan),
      currency: "XTR",
      prices: [{ label: `${PLAN_TITLES[plan] ?? plan} на 30 дней`, amount: row.price }],
      subscription_period: STARS_SUBSCRIPTION_SECONDS
    });
    return { url };
  });

  // ---- webhook -------------------------------------------------------------------------------
  const fromTelegram = (request: FastifyRequest) => {
    const header = request.headers["x-telegram-bot-api-secret-token"];
    const expected = Buffer.from(config.TELEGRAM_WEBHOOK_SECRET ?? "");
    const given = Buffer.from(typeof header === "string" ? header : "");
    return (
      expected.length > 0 && given.length === expected.length && timingSafeEqual(given, expected)
    );
  };

  app.post("/telegram/webhook", async (request, response) => {
    if (!configured || !fromTelegram(request)) {
      return denied(response, 403, "forbidden", "Неверный секрет");
    }
    const update = updateSchema.safeParse(request.body);
    // An update we do not understand is still acknowledged: Telegram would resend it forever.
    if (!update.success) return { ok: true };
    const { pre_checkout_query: checkout, message } = update.data;

    if (checkout) {
      const error = await checkoutProblem(sql, checkout);
      await call("answerPreCheckoutQuery", {
        pre_checkout_query_id: checkout.id,
        ok: !error,
        ...(error ? { error_message: error } : {})
      });
      return { ok: true };
    }
    if (message?.successful_payment && message.from) {
      const paid = await recordPayment(sql, message.successful_payment, message.from.id);
      if (paid) {
        await reply(
          message.chat.id,
          `Оплачено: ${PLAN_TITLES[paid.plan] ?? paid.plan} до ${paid.validUntil.toLocaleDateString("ru-RU")}. Спасибо! Квота обновится в панели сразу.`
        );
      }
      return { ok: true };
    }
    const text = message?.text?.trim() ?? "";
    if (!message || !text.startsWith("/")) return { ok: true };
    const [command, argument] = text.split(/\s+/u);
    if (command === "/start" && argument) {
      const [linked] = await sql<{ login: string }[]>`
        with used as (
          delete from telegram_link_tokens where token_hash=${hash(argument)} and expires_at>now()
          returning channel_id
        ), saved as (
          insert into telegram_accounts(channel_id,chat_id,username)
          select channel_id, ${message.chat.id}, ${message.from?.username ?? null} from used
          on conflict(channel_id) do update set chat_id=excluded.chat_id,
            username=excluded.username, linked_at=now()
          returning channel_id
        )
        select c.twitch_login login from saved join channels c on c.id=saved.channel_id`;
      await reply(
        message.chat.id,
        linked
          ? `Готово: канал #${linked.login} подключён. Сюда придут предупреждения о квоте, отказы Twitch и итог после стрима. Отключить: /stop`
          : "Ссылка устарела. Нажмите «Подключить Telegram» в панели RoastBot ещё раз."
      );
    } else if (command === "/stop") {
      const removed = await sql`delete from telegram_accounts where chat_id=${message.chat.id}
        returning channel_id`;
      await reply(
        message.chat.id,
        removed.length ? "Уведомления отключены." : "Этот чат не подключён ни к одному каналу."
      );
    } else {
      await reply(
        message.chat.id,
        "Это бот RoastBot. Подключите его из панели: карточка «Telegram» → «Подключить»."
      );
    }
    return { ok: true };
  });

  // ---- owner ---------------------------------------------------------------------------------
  // What Telegram itself says about our webhook: the first place to look when the bot is silent.
  const webhookStatus = async () => {
    const info = await call<{
      url: string;
      pending_update_count: number;
      last_error_date?: number;
      last_error_message?: string;
    }>("getWebhookInfo", {});
    return {
      configured: true,
      expected: webhookUrl,
      url: info.url || null,
      pending: info.pending_update_count,
      lastError: info.last_error_message ?? null,
      lastErrorAt: info.last_error_date
        ? new Date(info.last_error_date * 1000).toISOString()
        : null,
      ok: info.url === webhookUrl && !info.last_error_message
    };
  };
  app.get("/admin/telegram", { preHandler: requireOwner }, async (_request, reply) => {
    if (!configured) return { configured: false };
    return webhookStatus().catch((error: unknown) =>
      denied(
        reply,
        502,
        "telegram_unavailable",
        error instanceof Error ? error.message : "Telegram"
      )
    );
  });
  app.post("/admin/telegram/webhook", { preHandler: requireOwner }, async (request, reply) => {
    if (!configured) return denied(reply, 404, "not_configured", "Telegram-бот не настроен");
    try {
      await registerWebhook();
      return await webhookStatus();
    } catch (error) {
      request.log.error(error, "telegram setWebhook failed");
      return denied(
        reply,
        502,
        "telegram_unavailable",
        error instanceof Error ? error.message : "Telegram"
      );
    }
  });

  app.get(
    "/admin/payments",
    { preHandler: requireOwner },
    async () =>
      sql`select p.charge_id "chargeId", p.plan, p.stars, p.recurring, p.valid_until "validUntil",
        p.refunded_at "refundedAt", p.created_at "createdAt", c.twitch_login "channel",
        p.telegram_user_id::text "telegramUserId"
      from star_payments p left join channels c on c.id=p.channel_id
      order by p.created_at desc limit 200`
  );

  app.post(
    "/admin/payments/:chargeId/refund",
    { preHandler: requireOwner },
    async (request, reply) => {
      if (!configured) return denied(reply, 404, "not_configured", "Telegram-бот не настроен");
      const { chargeId } = z.object({ chargeId: z.string().min(1).max(200) }).parse(request.params);
      const [payment] = await sql<{ telegramUserId: string; refundedAt: Date | null }[]>`
        select telegram_user_id::text "telegramUserId", refunded_at "refundedAt"
        from star_payments where charge_id=${chargeId}`;
      if (!payment) return denied(reply, 404, "not_found", "Платёж не найден");
      if (payment.refundedAt) return denied(reply, 409, "already_refunded", "Уже возвращён");
      const userId = Number(payment.telegramUserId);
      // Stop the renewals first; a payment that is not a subscription has none to cancel.
      await call("editUserStarSubscription", {
        user_id: userId,
        telegram_payment_charge_id: chargeId,
        is_canceled: true
      }).catch(() => undefined);
      await call("refundStarPayment", { user_id: userId, telegram_payment_charge_id: chargeId });
      await sql.begin(async (tx) => {
        await tx`update star_payments set refunded_at=now() where charge_id=${chargeId}`;
        await tx`update subscriptions set valid_until=now() where id=(
          select subscription_id from star_payments where charge_id=${chargeId})`;
        await audit(tx, request, "payment.refund", chargeId, {});
      });
      return { chargeId, refunded: true };
    }
  );
}

/** Why Telegram must not charge this invoice, or null when it may. */
async function checkoutProblem(
  sql: Sql,
  checkout: { currency: string; total_amount: number; invoice_payload: string }
): Promise<string | null> {
  const payload = parseStarsPayload(checkout.invoice_payload);
  if (!payload || checkout.currency !== "XTR") return "Счёт недействителен";
  const [row] = await sql<{ price: number | null; status: string | null }[]>`
    select p.stars_price price, u.status
    from plans p left join channels c on c.id=${payload.channelId}
    left join users u on u.id=c.user_id where p.code=${payload.plan}`;
  if (!row?.status) return "Канал не найден";
  if (row.status !== "active") return "Аккаунт RoastBot не активен";
  if (row.price !== checkout.total_amount)
    return "Цена изменилась, откройте оплату в панели заново";
  return null;
}

/** Books a payment once per charge id and extends the plan to Telegram's expiration date. */
async function recordPayment(
  sql: Sql,
  payment: {
    currency: string;
    total_amount: number;
    invoice_payload: string;
    telegram_payment_charge_id: string;
    subscription_expiration_date?: number | undefined;
    is_recurring?: boolean | undefined;
  },
  telegramUserId: number
): Promise<{ plan: string; validUntil: Date } | null> {
  const payload = parseStarsPayload(payment.invoice_payload);
  if (!payload || payment.currency !== "XTR") return null;
  const validUntil = payment.subscription_expiration_date
    ? new Date(payment.subscription_expiration_date * 1000)
    : new Date(Date.now() + STARS_SUBSCRIPTION_SECONDS * 1000);
  return sql.begin(async (tx) => {
    const [channel] = await tx<{ id: string; userId: string }[]>`
      select id, user_id "userId" from channels where id=${payload.channelId}`;
    const [inserted] = await tx`
      insert into star_payments(charge_id,channel_id,plan,stars,telegram_user_id,recurring,valid_until)
      values(${payment.telegram_payment_charge_id},${channel?.id ?? null},${payload.plan},
        ${payment.total_amount},${telegramUserId},${payment.is_recurring ?? false},${validUntil})
      on conflict(charge_id) do nothing returning charge_id`;
    if (!inserted) return null;
    if (channel) {
      const [subscription] = await tx<{ id: string }[]>`
        insert into subscriptions(user_id,plan_id,valid_until,source)
        select ${channel.userId}, id, ${validUntil}, 'telegram_stars' from plans
        where code=${payload.plan} returning id`;
      await tx`update star_payments set subscription_id=${subscription?.id ?? null}
        where charge_id=${payment.telegram_payment_charge_id}`;
    }
    await tx`insert into audit_log(actor_user_id,action,target,payload)
      values(${channel?.userId ?? null},'payment.stars',${payment.telegram_payment_charge_id},
        ${tx.json({ plan: payload.plan, stars: payment.total_amount, channelId: payload.channelId })})`;
    return { plan: payload.plan, validUntil };
  });
}
