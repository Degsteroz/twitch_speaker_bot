// Settings: kill switch, limits and budget, models, voices; plans in their own file.
import { useState } from "react";

import { ask } from "../ask.js";
import { api, put } from "../api.js";
import { Card, Field, Link, State, errorText } from "../ui.js";
import { ModelSelect, useAdmin } from "./common.js";
import { PlanSettings } from "./plans.js";

interface SettingField {
  key: string;
  label: string;
  kind: "number" | "model";
  fallback: number | string;
  step?: string;
  hint?: string;
}

const LIMIT_FIELDS: SettingField[] = [
  {
    key: "monthly_budget_usd",
    label: "Бюджет Anthropic в месяц, $",
    kind: "number",
    fallback: 10,
    step: "0.5"
  },
  {
    key: "global_monthly_limit",
    label: "Роастов в месяц на весь сервис",
    kind: "number",
    fallback: 4000
  },
  {
    key: "input_retention_days",
    label: "Хранить тексты зрителей, дней",
    kind: "number",
    fallback: 30,
    hint: "От 1 до 30. Потом вход и ответ стираются, счётчики остаются."
  },
  {
    key: "demo_daily_limit",
    label: "Демо на лендинге, ответов в день",
    kind: "number",
    fallback: 30,
    hint: "На весь сервис, по 3 на посетителя. 0 скрывает демо. Деньги идут в общий бюджет."
  }
];
const MODEL_FIELDS: SettingField[] = [
  { key: "model", label: "Генерация", kind: "model", fallback: "claude-sonnet-5-5" },
  // Chat words on the premium tier; events, the command and rewards use "model".
  { key: "chat_model", label: "Слова в чате", kind: "model", fallback: "claude-haiku-5-5" },
  { key: "classifier_model", label: "Классификатор", kind: "model", fallback: "claude-sonnet-5-5" }
];
const VOICE_FIELDS: SettingField[] = [
  {
    key: "elevenlabs_monthly_char_limit",
    label: "ElevenLabs, символов в месяц",
    kind: "number",
    fallback: 70000,
    step: "1000"
  },
  {
    key: "yandex_tts_monthly_limit_rub",
    label: "Яндекс SpeechKit, ₽ в месяц",
    kind: "number",
    fallback: 300,
    step: "10"
  }
];

export function AdminSettings() {
  const { data, error, load } = useAdmin<{ key: string; value: unknown }[]>("/admin/settings");
  if (error) return <State title="Настройки недоступны" text={error} action={load} />;
  if (!data) return <State title="Загружаем настройки…" busy />;
  const values = Object.fromEntries(data.map((item) => [item.key, item.value]));
  // Remount the groups on every reload so inputs always start from the stored values.
  const key = JSON.stringify(data);
  return (
    <>
      <KillSwitch on={values.kill_switch === true} reload={load} />
      <div className="settings-grid">
        <SettingsGroup
          key={`limits${key}`}
          title="Лимиты и бюджет"
          note="Проверяются до вызова модели. Лимит в консоли Anthropic остаётся последней защитой."
          fields={LIMIT_FIELDS}
          values={values}
          reload={load}
        />
        <SettingsGroup
          key={`models${key}`}
          title="Модели"
          note="Генерация — для лучших роастов: события, команда и награды. Слова в чате — фоновая болтовня, её отвечает модель подешевле. Модель после лимита лучших роастов задают тарифы ниже. Классификатор проверяет каждый ответ на всех тарифах."
          fields={MODEL_FIELDS}
          values={values}
          reload={load}
        />
        <SettingsGroup
          key={`voices${key}`}
          title="Голоса"
          note="Жёсткие месячные лимиты: после них звучит следующий голос, последним — бесплатный Piper."
          fields={VOICE_FIELDS}
          values={values}
          reload={load}
        />
      </div>
      <PlanSettings />
      <p className="fine-print">
        Общие стоп-слова — во вкладке <Link href="/admin/moderation">«Модерация»</Link>.
      </p>
    </>
  );
}

function KillSwitch({ on, reload }: { on: boolean; reload: () => Promise<void> }) {
  const [notice, setNotice] = useState("");
  const toggle = async () => {
    if (
      !on &&
      !(await ask({
        title: "Остановить генерацию на всех каналах?",
        text: "Бот замолчит у всех стримеров, пока вы не включите его снова.",
        confirm: "Остановить",
        danger: true
      }))
    )
      return;
    try {
      await api("/admin/settings/kill_switch", put(!on));
      await reload();
    } catch (reason) {
      setNotice(errorText(reason));
    }
  };
  return (
    <Card className={on ? "warn-card kill-switch" : "kill-switch"}>
      <div>
        <p className="label">АВАРИЙНЫЙ СТОП</p>
        <h2>{on ? "Бот молчит на всех каналах" : "Бот работает"}</h2>
        <p>
          Kill switch останавливает все новые роасты сразу. Квоты и настройки каналов не меняются.
        </p>
        {notice && <p className="feedback">{notice}</p>}
      </div>
      <button
        className={`button ${on ? "primary" : "secondary danger"}`}
        onClick={() => void toggle()}
      >
        {on ? "Включить генерацию" : "Остановить всё"}
      </button>
    </Card>
  );
}

/** A card of global settings with its own save button: only changed keys are written. */
function SettingsGroup({
  title,
  note,
  fields,
  values,
  reload
}: {
  title: string;
  note: string;
  fields: SettingField[];
  values: Record<string, unknown>;
  reload: () => Promise<void>;
}) {
  const stored = (field: SettingField) => {
    const value = values[field.key];
    return typeof value === "number" || typeof value === "string"
      ? String(value)
      : String(field.fallback);
  };
  const [form, setForm] = useState(() =>
    Object.fromEntries(fields.map((field) => [field.key, stored(field)]))
  );
  const [notice, setNotice] = useState("");
  const changed = fields.filter((field) => form[field.key] !== stored(field));
  const save = async () => {
    try {
      // Sequential: each key has its own validation and audit entry.
      for (const field of changed) {
        const raw = form[field.key] ?? "";
        await api(`/admin/settings/${field.key}`, put(field.kind === "number" ? Number(raw) : raw));
      }
      await reload();
    } catch (reason) {
      setNotice(`Не сохранено: ${errorText(reason)}`);
    }
  };
  return (
    <Card>
      <p className="label">{title.toUpperCase()}</p>
      <p className="muted">{note}</p>
      <div className="admin-form">
        {fields.map((field) =>
          field.kind === "model" ? (
            <label className="field-label" key={field.key}>
              {field.label}
              <ModelSelect
                value={form[field.key] ?? ""}
                onChange={(value) => setForm({ ...form, [field.key]: value })}
              />
            </label>
          ) : (
            <div key={field.key}>
              <Field
                label={field.label}
                type="number"
                min={0}
                step={field.step}
                value={form[field.key]}
                onChange={(value) => setForm({ ...form, [field.key]: value })}
              />
              {field.hint && <small className="hint below">{field.hint}</small>}
            </div>
          )
        )}
      </div>
      <div className="group-actions">
        <button
          className={`button ${changed.length ? "primary" : "secondary"}`}
          disabled={!changed.length}
          onClick={() => void save()}
        >
          Сохранить
        </button>
        {notice && <span className="notice">{notice}</span>}
      </div>
    </Card>
  );
}
