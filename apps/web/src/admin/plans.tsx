// Plans: how many roasts a month get the best model and voice, and what comes after.
import { useState } from "react";

import { api, put } from "../api.js";
import { Card, errorText } from "../ui.js";
import { ModelSelect, useAdmin } from "./common.js";
import { USD_PER_STAR } from "./payments.js";
import type { PlanRow } from "./types.js";

export function PlanSettings() {
  const { data, error, load } = useAdmin<PlanRow[]>("/admin/plans");
  const [notice, setNotice] = useState("");
  const save = async (plan: PlanRow) => {
    try {
      const { code, premiumRoasts, economyModel, economyVoice, starsPrice } = plan;
      await api(
        `/admin/plans/${code}`,
        put({ premiumRoasts, economyModel, economyVoice, starsPrice })
      );
      setNotice(`Тариф ${code} сохранён`);
      await load();
    } catch (reason) {
      setNotice(`Не сохранено: ${errorText(reason)}`);
    }
  };
  return (
    <Card>
      <div className="section-head">
        <div>
          <p className="label">ТАРИФЫ</p>
          <h2>Цена, модель и голос по тарифу</h2>
          <p>
            Цена — в звёздах Telegram за 30 дней, рядом — сколько придёт после вывода. Пусто — тариф
            не продаётся. Новая цена действует для новых оплат; уже оформленные подписки
            продлеваются по старой. Первые роасты месяца — на модели генерации и ElevenLabs, дальше
            — на модели и голосе попроще. Пусто в «Лучших» — все роасты лучшие. Роастов в месяц
            задаёт код, seed обновляет их при деплое.
          </p>
        </div>
        <span className="notice">{notice}</span>
      </div>
      {error && <p className="feedback">{error}</p>}
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Тариф</th>
              <th>Цена, ⭐</th>
              <th>Роастов в месяц</th>
              <th>Лучших</th>
              <th>Модель потом</th>
              <th>Голос потом</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {data?.map((plan) => (
              <PlanRowForm key={JSON.stringify(plan)} plan={plan} onSave={save} />
            ))}
          </tbody>
        </table>
      </div>
    </Card>
  );
}

function PlanRowForm({
  plan,
  onSave
}: {
  plan: PlanRow;
  onSave: (plan: PlanRow) => Promise<void>;
}) {
  const [premium, setPremium] = useState(
    plan.premiumRoasts === null ? "" : String(plan.premiumRoasts)
  );
  const [model, setModel] = useState(plan.economyModel);
  const [voice, setVoice] = useState(plan.economyVoice);
  const [price, setPrice] = useState(plan.starsPrice === null ? "" : String(plan.starsPrice));
  const premiumRoasts = premium.trim() === "" ? null : Math.max(0, Math.round(Number(premium)));
  const starsPrice =
    price.trim() === "" ? null : Math.min(10_000, Math.max(1, Math.round(Number(price)) || 1));
  const dirty =
    starsPrice !== plan.starsPrice ||
    premiumRoasts !== plan.premiumRoasts ||
    model !== plan.economyModel ||
    voice !== plan.economyVoice;
  return (
    <tr>
      <td>
        <strong>{plan.code}</strong>
      </td>
      <td>
        <input
          aria-label={`Цена в звёздах, ${plan.code}`}
          type="number"
          min={1}
          max={10_000}
          placeholder="не продаётся"
          value={price}
          onChange={(event) => setPrice(event.target.value)}
        />
        {starsPrice !== null && (
          <small className="hint">≈ ${(starsPrice * USD_PER_STAR).toFixed(2)}</small>
        )}
      </td>
      <td>{plan.monthlyRoastLimit}</td>
      <td>
        <input
          aria-label={`Лучших роастов, ${plan.code}`}
          type="number"
          min={0}
          placeholder="все"
          value={premium}
          onChange={(event) => setPremium(event.target.value)}
        />
      </td>
      <td>
        <ModelSelect label={`Модель потом, ${plan.code}`} value={model} onChange={setModel} />
      </td>
      <td>
        <select
          aria-label={`Голос потом, ${plan.code}`}
          value={voice}
          onChange={(event) => setVoice(event.target.value as PlanRow["economyVoice"])}
        >
          <option value="yandex">Яндекс</option>
          <option value="piper">Piper (бесплатно)</option>
        </select>
      </td>
      <td>
        <button
          className={dirty ? "mini primary" : "mini"}
          disabled={!dirty}
          onClick={() =>
            void onSave({
              ...plan,
              premiumRoasts,
              economyModel: model,
              economyVoice: voice,
              starsPrice
            })
          }
        >
          Сохранить
        </button>
      </td>
    </tr>
  );
}
