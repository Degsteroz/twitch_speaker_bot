// Spend: where the month's money went, how fast it goes and why roasts did not play. Replaces the
// SQL the owner used to run on the server.
import { useState } from "react";

import { ROAST_STATUS_TEXT, SKIP_REASON_TEXT } from "../api.js";
import { Card, Metric, State } from "../ui.js";
import { Section, useAdmin } from "./common.js";
import type { Spend, SpendGroup } from "./types.js";

const KIND_TEXT: Record<SpendGroup["kind"], string> = {
  roast: "Роасты",
  stub: "Заглушки",
  failed: "Ошибки",
  blocked: "Блоки"
};
const TIER_TEXT: Record<string, string> = { premium: "хороший", economy: "экономичный" };
const MODEL_TEXT: Record<string, string> = {
  "claude-sonnet-5-5": "Sonnet",
  "claude-haiku-5-5": "Haiku"
};
const VOICE_TEXT: Record<string, string> = {
  elevenlabs: "ElevenLabs",
  inworld: "Inworld",
  yandex: "Яндекс",
  piper: "Piper"
};
// Days of the pace: the last week says more than the whole month.
const PACE_DAYS = 7;

const usd = (value: number, digits = 2) => `$${value.toFixed(digits)}`;

/** This month and the two before it, newest first, as yyyy-mm (UTC like the counters). */
function recentMonths(now = new Date()) {
  return [0, 1, 2].map((back) =>
    new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - back, 1)).toISOString().slice(0, 7)
  );
}

const reasonText = (reason: string | null) => {
  if (!reason) return "—";
  if (reason.startsWith("stop_word:")) return `стоп-слово «${reason.slice(10)}»`;
  return (
    SKIP_REASON_TEXT[reason] ??
    {
      classifier_block: "классификатор забраковал ответ",
      prompt_injection: "попытка инъекции",
      echo_input: "ответ повторял вход",
      viewer_opted_out: "зритель отказался от роастов",
      top_board: "табло !топ",
      top_cooldown: "!топ чаще раза в 5 минут"
    }[reason] ??
    reason
  );
};

export function AdminSpend() {
  const months = recentMonths();
  const [month, setMonth] = useState(months[0]!);
  const { data, error, load } = useAdmin<Spend>(`/admin/spend?month=${month}`);
  return (
    <>
      <div className="table-head">
        <label className="field-label">
          Месяц
          <select value={month} onChange={(event) => setMonth(event.target.value)}>
            {months.map((value) => (
              <option key={value} value={value}>
                {value}
              </option>
            ))}
          </select>
        </label>
      </div>
      {error ? (
        <State title="Расходы недоступны" text={error} action={load} />
      ) : !data || data.month !== month ? (
        <State title="Считаем расходы…" busy />
      ) : (
        <SpendView data={data} current={month === months[0]} />
      )}
    </>
  );
}

function SpendView({ data, current }: { data: Spend; current: boolean }) {
  const recent = data.days.slice(-PACE_DAYS);
  const perDay = recent.length ? recent.reduce((sum, day) => sum + day.usd, 0) / recent.length : 0;
  const now = new Date();
  const daysInMonth = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 0)
  ).getUTCDate();
  const daysLeft = daysInMonth - now.getUTCDate() + 1;
  const forecast = data.usd + perDay * daysLeft;
  const budgetDays = perDay > 0 ? Math.floor((data.budget - data.usd) / perDay) : null;
  const roasts = data.groups.filter((group) => group.kind === "roast");
  const roastCount = roasts.reduce((sum, group) => sum + group.count, 0);
  return (
    <>
      <Section
        title="Итог"
        note="ElevenLabs оплачен подпиской заранее: бюджет считает его по прайсу, сверху за него не платится."
      >
        <div className="metric-grid">
          <Metric
            label="Всего по бюджету"
            value={usd(data.usd)}
            note={`из ${usd(data.budget)} · демо ${usd(data.demoUsd)}`}
            used={data.usd / Math.max(data.budget, 0.000_001)}
            warn={data.usd > data.budget * 0.8}
          />
          <Metric
            label="Из них ElevenLabs"
            value={`≈${usd(data.elevenLabsUsd)}`}
            note="предоплачено, по прайсу $0.08 за 1000 символов"
          />
          <Metric
            label="Платим сверху"
            value={`≈${usd(Math.max(0, data.usd - data.elevenLabsUsd))}`}
            note="Anthropic, Inworld и Яндекс"
          />
          <Metric
            label="Роастов"
            value={roastCount}
            note={
              roastCount
                ? `≈${usd(
                    roasts.reduce((sum, group) => sum + group.usd, 0) / roastCount,
                    4
                  )} за роаст с голосом`
                : "в этом месяце ещё не было"
            }
          />
          {current && (
            <Metric
              label="Темп"
              value={`${usd(perDay)} в день`}
              note={`за последние ${String(recent.length)} дн. · к концу месяца ≈${usd(forecast)}${
                budgetDays !== null
                  ? budgetDays >= daysLeft
                    ? " · бюджета хватит"
                    : ` · бюджет кончится через ${String(Math.max(0, budgetDays))} дн.`
                  : ""
              }`}
              warn={forecast > data.budget}
            />
          )}
        </div>
      </Section>
      <Section
        title="На что ушло"
        note="Роасты по тиру, модели и голосу; заглушки, блоки и ошибки отдельно."
      >
        <Card>
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Что</th>
                  <th>Модель</th>
                  <th>Голос</th>
                  <th>Штук</th>
                  <th>Всего</th>
                  <th>За штуку</th>
                  <th>Символов голоса</th>
                </tr>
              </thead>
              <tbody>
                {data.groups.map((group) => (
                  <tr
                    key={`${group.kind}/${group.tier ?? ""}/${group.model ?? ""}/${group.voice ?? ""}`}
                  >
                    <td>
                      {KIND_TEXT[group.kind]}
                      {group.tier ? `, ${TIER_TEXT[group.tier] ?? group.tier}` : ""}
                    </td>
                    <td>{group.model ? (MODEL_TEXT[group.model] ?? group.model) : "—"}</td>
                    <td>{group.voice ? (VOICE_TEXT[group.voice] ?? group.voice) : "без голоса"}</td>
                    <td>{group.count}</td>
                    <td>{usd(group.usd, 3)}</td>
                    <td>{usd(group.usd / Math.max(group.count, 1), 4)}</td>
                    <td>{group.chars.toLocaleString("ru-RU")}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            {data.groups.length === 0 && <p>Расходов нет.</p>}
          </div>
        </Card>
      </Section>
      <Section
        title="Почему не прозвучало"
        note="Отказы лимитов, блоки модерации и ошибки. Заглушки — это ответ вместо роаста."
      >
        <Card>
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Статус</th>
                  <th>Причина</th>
                  <th>Штук</th>
                </tr>
              </thead>
              <tbody>
                {data.reasons.map((row) => (
                  <tr key={`${row.status}/${row.reason ?? ""}`}>
                    <td>
                      {ROAST_STATUS_TEXT[row.status as keyof typeof ROAST_STATUS_TEXT] ??
                        row.status}
                    </td>
                    <td>{reasonText(row.reason)}</td>
                    <td>{row.count}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            {data.reasons.length === 0 && <p>Всё прозвучало.</p>}
          </div>
        </Card>
      </Section>
      <Section title="По дням" note="UTC. Деньги — вместе с демо на лендинге.">
        <Card>
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>День</th>
                  <th>Роастов</th>
                  <th>Расход</th>
                </tr>
              </thead>
              <tbody>
                {[...data.days].reverse().map((day) => (
                  <tr key={day.day}>
                    <td>{new Date(`${day.day}T00:00:00Z`).toLocaleDateString("ru-RU")}</td>
                    <td>{day.roasts}</td>
                    <td>{usd(day.usd, 3)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      </Section>
    </>
  );
}
