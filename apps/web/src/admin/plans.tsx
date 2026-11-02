// Plans: N roasts in the good voice, then M in Yandex, the price in Stars. The model after the good
// roasts is a fine setting and lives under "Дополнительно".
import { useState } from "react";

import { api, put } from "../api.js";
import { Card, errorText } from "../ui.js";
import { ModelSelect } from "./common.js";
import { USD_PER_STAR } from "./payments.js";
import type { PlanRow } from "./types.js";

/** Plans as the admin page loaded them, shared by both tables so a save never sends stale rows. */
export interface PlansData {
  data: PlanRow[] | undefined;
  error: string;
  load: () => Promise<void>;
}

function usePlanSave(load: () => Promise<void>) {
  const [notice, setNotice] = useState("");
  const save = async (plan: PlanRow) => {
    try {
      const { code, monthlyRoastLimit, premiumRoasts, economyModel, economyVoice, starsPrice } =
        plan;
      await api(
        `/admin/plans/${code}`,
        put({ monthlyRoastLimit, premiumRoasts, economyModel, economyVoice, starsPrice })
      );
      setNotice(`Тариф ${code} сохранён`);
      await load();
    } catch (reason) {
      setNotice(`Не сохранено: ${errorText(reason)}`);
    }
  };
  return { notice, save };
}

const count = (value: string) => Math.max(0, Math.round(Number(value)) || 0);

export function PlanSettings({ plans }: { plans: PlansData }) {
  const { notice, save } = usePlanSave(plans.load);
  return (
    <Card>
      <div className="section-head">
        <div>
          <p className="label">ТАРИФЫ</p>
          <h2>Сколько роастов и за сколько</h2>
          <p>
            Сначала роасты хорошим голосом (ElevenLabs, потом Inworld), потом голосом Яндекса, потом
            стоп до следующего месяца. Цена — в звёздах Telegram за 30 дней, рядом — сколько придёт
            после вывода; пусто — тариф не продаётся. Новая цена действует для новых оплат.
          </p>
        </div>
        <span className="notice">{notice}</span>
      </div>
      {plans.error && <p className="feedback">{plans.error}</p>}
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Тариф</th>
              <th>Хорошим голосом</th>
              <th>Потом Яндексом</th>
              <th>Цена, ⭐</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {plans.data?.map((plan) => (
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
  const storedGood = Math.min(plan.premiumRoasts ?? plan.monthlyRoastLimit, plan.monthlyRoastLimit);
  const [good, setGood] = useState(String(storedGood));
  const [after, setAfter] = useState(String(plan.monthlyRoastLimit - storedGood));
  const [price, setPrice] = useState(plan.starsPrice === null ? "" : String(plan.starsPrice));
  const premiumRoasts = count(good);
  const monthlyRoastLimit = premiumRoasts + count(after);
  const starsPrice =
    price.trim() === "" ? null : Math.min(10_000, Math.max(1, Math.round(Number(price)) || 1));
  const dirty =
    starsPrice !== plan.starsPrice ||
    premiumRoasts !== storedGood ||
    monthlyRoastLimit !== plan.monthlyRoastLimit;
  return (
    <tr>
      <td>
        <strong>{plan.code}</strong>
      </td>
      <td>
        <input
          aria-label={`Роастов хорошим голосом, ${plan.code}`}
          type="number"
          min={0}
          value={good}
          onChange={(event) => setGood(event.target.value)}
        />
      </td>
      <td>
        <input
          aria-label={`Роастов Яндексом потом, ${plan.code}`}
          type="number"
          min={0}
          value={after}
          onChange={(event) => setAfter(event.target.value)}
        />
        <small className="hint">всего {monthlyRoastLimit}</small>
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
      <td>
        <button
          className={dirty ? "mini primary" : "mini"}
          disabled={!dirty}
          onClick={() => void onSave({ ...plan, premiumRoasts, monthlyRoastLimit, starsPrice })}
        >
          Сохранить
        </button>
      </td>
    </tr>
  );
}

/** Under "Дополнительно": the model that writes the roasts after the good ones. */
export function PlanModelSettings({ plans }: { plans: PlansData }) {
  const { notice, save } = usePlanSave(plans.load);
  return (
    <Card>
      <div className="section-head">
        <div>
          <p className="label">ТАРИФЫ · МОДЕЛЬ ПОТОМ</p>
          <p className="muted">
            Модель, которая пишет роасты после хороших. Голос после них всегда Яндекс; Piper звучит,
            только если отказали все облачные голоса.
          </p>
        </div>
        <span className="notice">{notice}</span>
      </div>
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Тариф</th>
              <th>Модель потом</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {plans.data?.map((plan) => (
              <PlanModelRow key={JSON.stringify(plan)} plan={plan} onSave={save} />
            ))}
          </tbody>
        </table>
      </div>
    </Card>
  );
}

function PlanModelRow({
  plan,
  onSave
}: {
  plan: PlanRow;
  onSave: (plan: PlanRow) => Promise<void>;
}) {
  const [model, setModel] = useState(plan.economyModel);
  const dirty = model !== plan.economyModel;
  return (
    <tr>
      <td>
        <strong>{plan.code}</strong>
      </td>
      <td>
        <ModelSelect label={`Модель потом, ${plan.code}`} value={model} onChange={setModel} />
      </td>
      <td>
        <button
          className={dirty ? "mini primary" : "mini"}
          disabled={!dirty}
          onClick={() => void onSave({ ...plan, economyModel: model })}
        >
          Сохранить
        </button>
      </td>
    </tr>
  );
}
