// Choice cards and named scales used by the panel settings.
import { CHARACTER_NAMES, type ChatFrequency, type Settings, type Triggers } from "../api.js";

export interface ScaleStep<T extends string | number = number> {
  value: T;
  label: string;
  note: string;
}
export const TOXICITY_STEPS: ScaleStep[] = [
  { value: 1, label: "Ирония", note: "Добродушная подколка без грубых слов." },
  { value: 2, label: "Колкость", note: "Колко, но без злобы." },
  { value: 3, label: "Сарказм", note: "Заметное раздражение и сарказм, без грубых слов." },
  {
    value: 4,
    label: "Жёстко",
    note: "Резкий сарказм, можно лёгкую грубость вроде «жопа» или «собака». Мата нет."
  },
  {
    value: 5,
    label: "Без пощады",
    note: "Максимум язвительности и лёгкая грубость. Мат, оскорбления и угрозы запрещены всегда."
  }
];
export const CHAT_FREQUENCY_STEPS: ScaleStep<ChatFrequency>[] = [
  {
    value: "rare",
    label: "Изредка",
    note: "Каждое 12-е сообщение со словом-триггером, каждая 3-я награда."
  },
  {
    value: "normal",
    label: "Нормально",
    note: "Каждое 9-е сообщение со словом-триггером, каждая 2-я награда."
  },
  {
    value: "often",
    label: "Часто",
    note: "Каждое 6-е сообщение со словом-триггером, каждая награда."
  }
];
export function targetSteps(tone: Settings["tone"]): ScaleStep<Triggers["targetMode"]>[] {
  const name = CHARACTER_NAMES[tone];
  return [
    {
      value: "author",
      label: "Автора",
      note: "Достаётся тому, кто написал, задонатил, зарейдил или подписался."
    },
    {
      value: "auto",
      label: `На усмотрение ${name}`,
      note: `${name} читает сообщение и событие и сама решает, кого подколоть: автора или стримера.`
    },
    { value: "streamer", label: "Стримера", note: "Любое событие — повод подколоть стримера." }
  ];
}

/** Named steps instead of a slider; a stored number between steps shows the nearest one. */
export function ScaleChoice<T extends string | number>({
  label,
  value,
  steps,
  onChange,
  tour
}: {
  label: string;
  value: T;
  steps: ScaleStep<T>[];
  onChange: (value: T) => void;
  tour?: string;
}) {
  const distance = (step: ScaleStep<T>) =>
    typeof value === "number" ? Math.abs(Number(step.value) - value) : step.value === value ? 0 : 1;
  const current = steps.reduce((best, step) => (distance(step) < distance(best) ? step : best));
  return (
    <fieldset data-tour={tour}>
      <legend>{label}</legend>
      <div
        className={`segment scale steps-${String(steps.length)}`}
        role="radiogroup"
        aria-label={label}
      >
        {steps.map((step) => (
          <button
            key={String(step.value)}
            type="button"
            role="radio"
            aria-checked={step === current}
            className={step === current ? "active" : ""}
            onClick={() => onChange(step.value)}
          >
            {step.label}
          </button>
        ))}
      </div>
      <small className="hint below">{current.note}</small>
    </fieldset>
  );
}

export function Choice({
  active,
  title,
  desc,
  onClick,
  icon
}: {
  active: boolean;
  title: string;
  desc: string;
  onClick: () => void;
  icon: string;
}) {
  return (
    <button className={`choice ${active ? "active" : ""}`} onClick={onClick} aria-pressed={active}>
      <i>{icon}</i>
      <span>
        <strong>{title}</strong>
        <small>{desc}</small>
      </span>
      <b>✓</b>
    </button>
  );
}
// Yandere easter eggs: a note for whoever opens the console, and a tab that misses you.
