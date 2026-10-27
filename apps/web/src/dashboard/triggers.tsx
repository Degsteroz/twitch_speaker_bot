// Trigger cards: the channel-points reward, chat words and the command, Twitch events and
// donations.
import { useEffect, useState } from "react";

import {
  api,
  DEFAULT_COMMAND,
  DONATIONALERTS_RESULT_TEXT,
  donationAlertsConnectUrl,
  post,
  REWARD_REASON_TEXT,
  type DonationAlertsStatus,
  type EventTriggers,
  REWARD_EVERY,
  type RewardsResponse,
  type Triggers,
  twitchLogin
} from "../api.js";
import { ask } from "../ask.js";
import { CHAT_FREQUENCY_STEPS, ScaleChoice } from "./controls.js";
import { Card, Tags } from "../ui.js";

export type EventKey = keyof EventTriggers;
export interface EventRow {
  key: EventKey;
  title: string;
  hint: string;
  /** Each rendered inline: "{before} [input] {after}". */
  thresholds?: { field: string; before: string; after: string; min: number; max: number }[];
}
export const EVENT_ROWS: EventRow[] = [
  {
    key: "cheer",
    title: "Битсы",
    hint: "по тексту cheer",
    thresholds: [{ field: "minBits", before: "от", after: "битсов", min: 1, max: 1_000_000 }]
  },
  { key: "subscription", title: "Подписки и ресабы", hint: "учитывает стаж" },
  {
    key: "giftSub",
    title: "Подарочные сабы",
    hint: "привет щедрому дарителю",
    thresholds: [{ field: "minCount", before: "от", after: "сабов", min: 1, max: 1_000 }]
  },
  {
    key: "raid",
    title: "Рейды",
    hint: "встречает рейдера",
    thresholds: [{ field: "minViewers", before: "от", after: "зрителей", min: 0, max: 1_000_000 }]
  },
  {
    key: "follow",
    title: "Фоллоу",
    hint: "фоллоу бывает много, шанс лучше держать небольшим",
    thresholds: [{ field: "chancePercent", before: "шанс", after: "%", min: 0, max: 100 }]
  },
  { key: "prediction", title: "Итоги прогнозов", hint: "про главного проигравшего" },
  { key: "adBreak", title: "Реклама", hint: "пока идёт реклама" },
  {
    key: "donation",
    title: "Донаты DonationAlerts",
    hint: "по тексту доната",
    thresholds: [
      { field: "minAmount", before: "от", after: "в валюте доната", min: 0, max: 10_000_000 },
      // The time to read the message is added on top (donationDelaySeconds in packages/shared).
      {
        field: "delaySec",
        before: "пауза после алерта",
        after: "сек + время на чтение текста",
        min: 0,
        max: 60
      }
    ]
  }
];

export function DonationAlertsLink() {
  const [status, setStatus] = useState<DonationAlertsStatus>();
  const [notice] = useState(() => {
    const result = new URLSearchParams(location.search).get("donationalerts");
    return result ? (DONATIONALERTS_RESULT_TEXT[result] ?? result) : "";
  });
  useEffect(() => {
    api<DonationAlertsStatus>("/integrations/donationalerts")
      .then(setStatus)
      .catch(() => setStatus({ configured: false, connected: false, name: null }));
  }, []);
  if (!status?.configured) return null;
  const disconnect = async () => {
    if (
      !(await ask({
        title: "Отключить DonationAlerts?",
        text: "Донаты перестанут приходить боту.",
        confirm: "Отключить",
        danger: true
      }))
    )
      return;
    await api("/integrations/donationalerts/disconnect", post());
    setStatus({ ...status, connected: false, name: null });
  };
  return (
    <div className="integration">
      <span>
        {status.connected ? (
          <>
            DonationAlerts: <strong>{status.name}</strong>
          </>
        ) : (
          "DonationAlerts не подключён"
        )}
        {notice && <small> · {notice}</small>}
      </span>
      {status.connected ? (
        <button className="mini" onClick={() => void disconnect()}>
          Отключить
        </button>
      ) : (
        <a className="mini" href={donationAlertsConnectUrl}>
          Подключить
        </a>
      )}
    </div>
  );
}

// Mirrors commandSchema in packages/shared: "!" and 2–20 letters, digits, "_" or "-".
const COMMAND_PATTERN = /^![\p{L}\p{N}_-]{2,20}$/u;
const RESERVED_COMMANDS = new Set([
  "!song",
  "!sr",
  "!uptime",
  "!followage",
  "!commands",
  "!discord",
  "!points",
  "!top",
  "!help",
  "!роаст-стоп",
  "!роаст-старт",
  "!roast-stop",
  "!roast-start"
]);

/** Why a command cannot be saved, or null. */
export function commandProblem(command: string): string | null {
  const value = command.trim().toLocaleLowerCase("ru-RU");
  if (!value.startsWith("!")) return "Команда начинается с «!»";
  if (!COMMAND_PATTERN.test(value)) return "От 2 до 20 букв или цифр после «!», без пробелов";
  if (RESERVED_COMMANDS.has(value)) return "Эту команду занимают другие боты";
  return null;
}

/** The streamer's own command; saved only when valid, so a half-typed one never breaks a save. */
function CommandField({
  value,
  disabled,
  onChange
}: {
  value: string;
  disabled: boolean;
  onChange: (command: string) => void;
}) {
  const [draft, setDraft] = useState(value);
  useEffect(() => setDraft(value), [value]);
  const problem = commandProblem(draft);
  return (
    <label className="field-label">
      Команда в чате
      <input
        value={draft}
        disabled={disabled}
        maxLength={21}
        placeholder={DEFAULT_COMMAND}
        onChange={(event) => {
          setDraft(event.target.value);
          if (!commandProblem(event.target.value)) {
            onChange(event.target.value.trim().toLocaleLowerCase("ru-RU"));
          }
        }}
        onBlur={() => problem && setDraft(value)}
      />
      {problem && draft !== value && <small className="hint below danger">{problem}</small>}
    </label>
  );
}

export function TriggerSettings({
  triggers,
  rewards,
  commandAvailable,
  characterName,
  onChange
}: {
  triggers: Triggers;
  rewards: RewardsResponse | undefined;
  commandAvailable: boolean;
  /** The premium character on air; her name can work as a trigger word. */
  characterName: string | null;
  onChange: (triggers: Triggers) => void;
}) {
  const set = (patch: Partial<Triggers>) => onChange({ ...triggers, ...patch });
  const setEvent = (key: EventKey, patch: Record<string, unknown>) =>
    set({ events: { ...triggers.events, [key]: { ...triggers.events[key], ...patch } } });
  return (
    <>
      <Card tour="reward">
        <p className="label">БАЛЛЫ КАНАЛА</p>
        <h2>Награда с текстом</h2>
        <label className="field-label">
          Награда
          <select
            value={triggers.rewardId ?? ""}
            disabled={!rewards?.available}
            onChange={(event) => set({ rewardId: event.target.value || null })}
          >
            <option value="">Не выбрана</option>
            {rewards?.rewards.map((reward) => (
              <option key={reward.id} value={reward.id}>
                {reward.title} · {reward.cost}
                {reward.is_enabled ? "" : " (выключена)"}
              </option>
            ))}
          </select>
        </label>
        {rewards === undefined && <small className="hint below">Загружаем награды…</small>}
        {rewards?.reason && (
          <small className="hint below">{REWARD_REASON_TEXT[rewards.reason]}</small>
        )}
        {rewards?.available && rewards.rewards.length === 0 && (
          <small className="hint below">
            На канале нет наград. Создайте награду с полем ввода текста в Twitch.
          </small>
        )}
        <small className="hint below">
          Зритель пишет текст в награде, героиня читает его и отвечает по смыслу. Кого она при этом
          жарит, решает переключатель «Кого жарить» в карточке персонажа.{" "}
          {REWARD_EVERY[triggers.chatFrequency] === 1
            ? "Отвечает на каждую награду"
            : `Отвечает на каждую ${REWARD_EVERY[triggers.chatFrequency]}-ю награду`}{" "}
          (частота — в карточке «Чат»), остальным и тем, кто частит, — «Мммммм, нет!».
        </small>
      </Card>
      <Card tour="command">
        <p className="label">ЧАТ</p>
        <h2>На что отвечать в чате</h2>
        <label className={`check ${commandAvailable ? "" : "locked"}`}>
          <input
            type="checkbox"
            checked={commandAvailable && triggers.command}
            disabled={!commandAvailable}
            onChange={(event) => set({ command: event.target.checked })}
          />
          <span>
            Команда <code>{triggers.commandName}</code>{" "}
            <small>
              {commandAvailable
                ? `— «${triggers.commandName} опять проиграл катку»`
                : "— доступна на тарифах Basic и Premium"}
            </small>
          </span>
        </label>
        {commandAvailable && triggers.command && (
          <>
            <CommandField
              value={triggers.commandName}
              disabled={!commandAvailable}
              onChange={(commandName) => set({ commandName })}
            />
            <small className="hint below">
              Своё слово понятнее зрителям, например <code>!прожарь</code> или имя героини. Кто
              зовёт слишком часто, слышит короткую заглушку вроде «Опять ты? Жди очереди».
            </small>
          </>
        )}
        {characterName && (
          <label className="check">
            <input
              type="checkbox"
              checked={triggers.nameMention}
              onChange={(event) => set({ nameMention: event.target.checked })}
            />
            <span>
              Откликаться на имя «{characterName}»{" "}
              <small>— как на слово-триггер: с той же частотой и паузами</small>
            </span>
          </label>
        )}
        <Tags
          legend="Слова-триггеры"
          placeholder="Например: слился ↵"
          value={triggers.keywords}
          onChange={(keywords) => set({ keywords })}
        />
        <small className="hint below">
          Слово срабатывает в начале любого слова: «слил» поймает «слился». Команды на «!» и
          сообщения ботов пропускаются, на сообщение самого стримера достаётся стримеру. Проверить
          ответ проще кнопкой теста в панели: слово срабатывает не каждый раз.
        </small>
        {(triggers.keywords.length > 0 ||
          (characterName && triggers.nameMention) ||
          triggers.rewardId) && (
          <ScaleChoice
            label="Как часто отвечать на слова и награды"
            value={triggers.chatFrequency}
            steps={CHAT_FREQUENCY_STEPS}
            onChange={(chatFrequency) => set({ chatFrequency })}
          />
        )}
        <Tags
          legend="Игнорировать в чате"
          placeholder="Логин бота, например: moobot ↵"
          value={triggers.ignoredUsers}
          onChange={(list) =>
            set({
              ignoredUsers: [
                ...new Set(list.map(twitchLogin).filter((login): login is string => !!login))
              ]
            })
          }
        />
        <small className="hint below">
          Боты канала и спамеры: их сообщения не запускают роаст, даже если в них слово-триггер или{" "}
          <code>{triggers.commandName}</code>. Nightbot, StreamElements и другие известные боты
          пропускаются и так.
        </small>
      </Card>
      <Card tour="events">
        <p className="label">СОБЫТИЯ</p>
        <h2>Twitch и донаты</h2>
        <DonationAlertsLink />
        {EVENT_ROWS.map((row) => {
          const value = triggers.events[row.key] as { enabled: boolean } & Record<string, number>;
          return (
            <div className="event-row" key={row.key}>
              <label className="check">
                <input
                  type="checkbox"
                  checked={value.enabled}
                  onChange={(event) => setEvent(row.key, { enabled: event.target.checked })}
                />
                <span>
                  {row.title} <small>— {row.hint}</small>
                </span>
              </label>
              {value.enabled &&
                row.thresholds?.map((threshold) => (
                  <label className="threshold" key={threshold.field}>
                    {threshold.before}
                    <input
                      type="number"
                      min={threshold.min}
                      max={threshold.max}
                      value={value[threshold.field]}
                      onChange={(event) =>
                        setEvent(row.key, {
                          [threshold.field]: Math.max(
                            threshold.min,
                            Math.min(threshold.max, Math.round(Number(event.target.value) || 0))
                          )
                        })
                      }
                    />
                    {threshold.after}
                  </label>
                ))}
            </div>
          );
        })}
      </Card>
    </>
  );
}
