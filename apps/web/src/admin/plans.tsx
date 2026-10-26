// Plans: how many roasts a month get the best model and voice, and what comes after.
import { useState } from "react";

import { api, put } from "../api.js";
import { Card, errorText } from "../ui.js";
import { ModelSelect, useAdmin } from "./common.js";
import type { PlanRow } from "./types.js";

export function PlanSettings() {
  const { data, error, load } = useAdmin<PlanRow[]>("/admin/plans");
  const [notice, setNotice] = useState("");
  const save = async (plan: PlanRow) => {
    try {
      const { code, premiumRoasts, economyModel, economyVoice } = plan;
      await api(`/admin/plans/${code}`, put({ premiumRoasts, economyModel, economyVoice }));
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
          <h2>Модель и голос по тарифу</h2>
          <p>
            Первые роасты месяца — на модели генерации и ElevenLabs, дальше — на модели и голосе
            попроще. Пусто в «Лучших» — все роасты лучшие. Роастов в месяц задаёт код, seed
            обновляет их при деплое.
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
  const premiumRoasts = premium.trim() === "" ? null : Math.max(0, Math.round(Number(premium)));
  const dirty =
    premiumRoasts !== plan.premiumRoasts ||
    model !== plan.economyModel ||
    voice !== plan.economyVoice;
  return (
    <tr>
      <td>
        <strong>{plan.code}</strong>
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
            void onSave({ ...plan, premiumRoasts, economyModel: model, economyVoice: voice })
          }
        >
          Сохранить
        </button>
      </td>
    </tr>
  );
}
