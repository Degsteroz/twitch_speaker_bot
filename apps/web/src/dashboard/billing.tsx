// The plan card: what the channel has now and what each paid plan gives, for Telegram Stars
// (30 days, renewing). After the streamer leaves to pay, the card waits for the payment itself.
import { useEffect, useState } from "react";

import { api, post } from "../api.js";
import { Card, date, errorText } from "../ui.js";
import { usePolling } from "./poll.js";

interface Billing {
  available: boolean;
  plans: {
    code: string;
    starsPrice: number;
    monthlyRoastLimit: number;
    premiumRoasts: number | null;
  }[];
  current: { plan: string; validUntil: string | null; source: string } | null;
  payments: { plan: string; stars: number; validUntil: string; refundedAt: string | null }[];
}

const PLAN_NAMES: Record<string, string> = { free: "Free", basic: "Basic", premium: "Premium" };

export function BillingCard({ onPaid }: { onPaid: () => void }) {
  const [billing, setBilling] = useState<Billing>();
  const [busy, setBusy] = useState("");
  const [notice, setNotice] = useState("");
  const [paidNow, setPaidNow] = useState(false);
  // The number of payments when the invoice was opened: a new one means it went through.
  const [before, setBefore] = useState(0);
  const load = () =>
    api<Billing>("/billing")
      .then((value) => {
        setBilling(value);
        return value;
      })
      .catch(() => undefined);
  const polling = usePolling(async () => {
    const value = await load();
    if (!value || value.payments.length <= before) return false;
    setPaidNow(true);
    onPaid();
    return true;
  });
  useEffect(() => {
    void load();
  }, []);
  if (!billing) return null;
  const buy = async (plan: string) => {
    setBusy(plan);
    setNotice("");
    setPaidNow(false);
    try {
      const { url } = await api<{ url: string }>("/billing/checkout", post({ plan }));
      setBefore(billing.payments.length);
      window.open(url, "_blank", "noopener");
      polling.start();
    } catch (reason) {
      setNotice(errorText(reason));
    } finally {
      setBusy("");
    }
  };
  const current = billing.current;
  const free = !current || current.plan === "free";
  return (
    <Card tour="billing">
      <p className="label">ТАРИФ</p>
      <h2>{PLAN_NAMES[current?.plan ?? ""] ?? "Нет тарифа"}</h2>
      <p>
        {current?.validUntil
          ? `Действует до ${date(current.validUntil)}${current.source === "telegram_stars" ? ", продлевается в Telegram автоматически" : ""}.`
          : "Бессрочно."}
      </p>
      {paidNow && (
        <p className="quota-estimate" role="status">
          Оплата прошла, тариф включён. Квота в панели уже обновилась.
        </p>
      )}
      {billing.available && billing.plans.length > 0 && (
        <>
          <p className="muted">
            {free
              ? "На Free доступно 10 роастов в месяц без команды !роаст. Платные тарифы:"
              : "Платные тарифы:"}
          </p>
          <ul className="plans">
            {billing.plans.map((plan) => (
              <li key={plan.code} className={current?.plan === plan.code ? "current" : ""}>
                <span>
                  <strong>{PLAN_NAMES[plan.code] ?? plan.code}</strong>
                  <small>
                    {plan.monthlyRoastLimit} роастов в месяц
                    {plan.premiumRoasts !== null && plan.premiumRoasts < plan.monthlyRoastLimit
                      ? `, из них ${String(plan.premiumRoasts)} на лучшей модели и голосе, остальные попроще`
                      : ", все на лучшей модели и голосе"}
                    ; команда !роаст
                  </small>
                </span>
                <button
                  className="button secondary"
                  disabled={Boolean(busy) || polling.waiting}
                  onClick={() => void buy(plan.code)}
                >
                  {busy === plan.code
                    ? "Готовим счёт…"
                    : current?.plan === plan.code
                      ? `Продлить · ${String(plan.starsPrice)} ⭐`
                      : `${String(plan.starsPrice)} ⭐ / 30 дней`}
                </button>
              </li>
            ))}
          </ul>
          <small className="hint below">
            Оплата звёздами в Telegram. Подписка продлевается каждые 30 дней, отменить можно в
            Telegram: «Настройки» → «Мои звёзды» → «Подписки».
          </small>
        </>
      )}
      {!billing.available && (
        <small className="hint below">Оплата сейчас недоступна. Напишите владельцу сервиса.</small>
      )}
      {polling.waiting && (
        <p className="quota-estimate" role="status">
          Ждём оплату в Telegram… Карточка обновится сама.{" "}
          <button className="mini" onClick={polling.stop}>
            Отмена
          </button>
        </p>
      )}
      {polling.timedOut && !paidNow && (
        <p className="quota-estimate warn" role="status">
          Оплата не пришла. Если вы оплатили, подождите минуту и обновите страницу: тариф включится,
          как только Telegram сообщит серверу.
        </p>
      )}
      {notice && <p className="feedback">{notice}</p>}
      {billing.payments.length > 0 && (
        <details className="used-invites">
          <summary>Оплаты: {billing.payments.length}</summary>
          <ul>
            {billing.payments.map((payment) => (
              <li key={`${payment.validUntil}${payment.plan}`}>
                {PLAN_NAMES[payment.plan] ?? payment.plan} · {payment.stars} ⭐ · до{" "}
                {date(payment.validUntil)}
                {payment.refundedAt ? " · возвращено" : ""}
              </li>
            ))}
          </ul>
        </details>
      )}
    </Card>
  );
}
