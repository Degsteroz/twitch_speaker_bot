// Trigger cards: the channel-points reward, chat words and !роаст, Twitch events and donations.
import { useEffect, useState } from "react";

import {
  api,
  DONATIONALERTS_RESULT_TEXT,
  donationAlertsConnectUrl,
  post,
  REWARD_REASON_TEXT,
  type DonationAlertsStatus,
  type EventTriggers,
  type RewardsResponse,
  type Triggers,
  twitchLogin
} from "../api.js";
import { KEYWORD_CHANCE_STEPS, ScaleChoice } from "./controls.js";
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
    if (!confirm("Отключить DonationAlerts? Донаты перестанут приходить боту.")) return;
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
          жарит, решает переключатель «Кого жарить» в карточке персонажа.
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
            Команда <code>!роаст</code>{" "}
            <small>
              {commandAvailable
                ? "— «!роаст опять проиграл катку»"
                : "— доступна на тарифах Basic и Premium"}
            </small>
          </span>
        </label>
        {characterName && (
          <label className="check">
            <input
              type="checkbox"
              checked={triggers.nameMention}
              onChange={(event) => set({ nameMention: event.target.checked })}
            />
            <span>
              Откликаться на имя «{characterName}»{" "}
              <small>— как на слово-триггер: с тем же шансом и паузами</small>
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
          сообщения ботов пропускаются, на сообщение самого стримера достаётся стримеру. Проверяете
          сами — поставьте «Всегда» и учтите паузы из «Тонкой настройки».
        </small>
        {(triggers.keywords.length > 0 || (characterName && triggers.nameMention)) && (
          <ScaleChoice
            label="Как часто отвечать на слово"
            value={triggers.keywordChancePercent}
            steps={KEYWORD_CHANCE_STEPS}
            onChange={(keywordChancePercent) => set({ keywordChancePercent })}
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
          <code>!роаст</code>. Nightbot, StreamElements и другие известные боты пропускаются и так.
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
