// The plan card: what the channel has now and paid plans for Telegram Stars (30 days, renewing).
import { useEffect, useState } from "react";

import { api, post } from "../api.js";
import { Card, date, errorText } from "../ui.js";

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
  const load = () =>
    api<Billing>("/billing")
      .then(setBilling)
      .catch(() => setBilling(undefined));
  useEffect(() => {
    void load();
  }, []);
  if (!billing) return null;
  const buy = async (plan: string) => {
    setBusy(plan);
    setNotice("");
    try {
      const { url } = await api<{ url: string }>("/billing/checkout", post({ plan }));
      window.open(url, "_blank", "noopener");
      setNotice("Оплатите в Telegram и вернитесь: тариф включится сразу после оплаты.");
    } catch (reason) {
      setNotice(errorText(reason));
    } finally {
      setBusy("");
    }
  };
  const current = billing.current;
  return (
    <Card tour="billing">
      <p className="label">ТАРИФ</p>
      <h2>{PLAN_NAMES[current?.plan ?? ""] ?? "Нет тарифа"}</h2>
      <p>
        {current?.validUntil
          ? `Действует до ${date(current.validUntil)}${current.source === "telegram_stars" ? ", продлевается в Telegram автоматически" : ""}.`
          : "Бессрочно."}
      </p>
      {billing.available && billing.plans.length > 0 && (
        <ul className="plans">
          {billing.plans.map((plan) => (
            <li key={plan.code} className={current?.plan === plan.code ? "current" : ""}>
              <span>
                <strong>{PLAN_NAMES[plan.code] ?? plan.code}</strong>
                <small>
                  {plan.monthlyRoastLimit} роастов в месяц
                  {plan.premiumRoasts !== null && plan.premiumRoasts < plan.monthlyRoastLimit
                    ? `, ${String(plan.premiumRoasts)} на лучшей модели и голосе`
                    : ", все на лучшей модели и голосе"}
                  , команда !роаст
                </small>
              </span>
              <button
                className="button secondary"
                disabled={Boolean(busy)}
                onClick={() => void buy(plan.code).then(onPaid)}
              >
                {busy === plan.code ? "Готовим счёт…" : `${String(plan.starsPrice)} ⭐ / 30 дней`}
              </button>
            </li>
          ))}
        </ul>
      )}
      {billing.available && (
        <small className="hint below">
          Оплата звёздами Telegram. Подписку можно отменить в Telegram: «Настройки» → «Мои звёзды».
        </small>
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
