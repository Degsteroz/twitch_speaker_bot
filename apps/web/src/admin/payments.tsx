// Payments: Telegram Stars subscriptions, with a refund that also stops the renewals.
import { useState } from "react";

import { ask } from "../ask.js";
import { api, post } from "../api.js";
import { Card, State, date, errorText } from "../ui.js";
import { useAdmin } from "./common.js";
import { TelegramStatus } from "./telegram-status.js";

interface Payment {
  chargeId: string;
  plan: string;
  stars: number;
  recurring: boolean;
  validUntil: string;
  refundedAt: string | null;
  createdAt: string;
  channel: string | null;
  telegramUserId: string;
}

// What a Star brings after Fragment and the TON exchange (README, «Оплата звёздами»).
export const USD_PER_STAR = 0.0124;

export function Payments() {
  const { data, error, load } = useAdmin<Payment[]>("/admin/payments");
  const [notice, setNotice] = useState("");
  if (error) return <State title="Платежи недоступны" text={error} action={load} />;
  if (!data) return <State title="Загружаем платежи…" busy />;
  const month = new Date().toISOString().slice(0, 7);
  const thisMonth = data.filter((row) => !row.refundedAt && row.createdAt.startsWith(month));
  const stars = thisMonth.reduce((sum, row) => sum + row.stars, 0);
  const refund = async (row: Payment) => {
    if (
      !(await ask({
        title: `Вернуть ${String(row.stars)} ⭐ за #${row.channel ?? "?"}?`,
        text: "Тариф закончится сразу, продления прекратятся.",
        confirm: "Вернуть звёзды",
        danger: true
      }))
    ) {
      return;
    }
    try {
      await api(`/admin/payments/${encodeURIComponent(row.chargeId)}/refund`, post());
      setNotice("Звёзды возвращены");
      await load();
    } catch (reason) {
      setNotice(errorText(reason));
    }
  };
  return (
    <>
      <TelegramStatus />
      <Card>
        <div className="section-head">
          <div>
            <p className="label">ПЛАТЕЖИ</p>
            <h2>Звёзды Telegram</h2>
            <p>
              За {month}: {stars} ⭐ ≈ ${(stars * USD_PER_STAR).toFixed(2)} на вывод. Вывод — через
              Fragment, от 1000 ⭐ и через 21 день после оплаты.
            </p>
          </div>
          {notice && <span className="notice">{notice}</span>}
        </div>
        {data.length === 0 ? (
          <p>Оплат пока не было.</p>
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Когда</th>
                  <th>Канал</th>
                  <th>Тариф</th>
                  <th>Звёзды</th>
                  <th>До</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {data.map((row) => (
                  <tr key={row.chargeId}>
                    <td>{date(row.createdAt)}</td>
                    <td>{row.channel ? `#${row.channel}` : "канал удалён"}</td>
                    <td>
                      {row.plan}
                      {row.recurring && <small>продление</small>}
                    </td>
                    <td>{row.stars} ⭐</td>
                    <td>{date(row.validUntil)}</td>
                    <td>
                      {row.refundedAt ? (
                        <small>возвращено {date(row.refundedAt)}</small>
                      ) : (
                        <button className="mini danger" onClick={() => void refund(row)}>
                          Вернуть
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </>
  );
}
