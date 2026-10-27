// The streamer's panel: status, quota, character, triggers, overlay, test and activity.
import { useCallback, useEffect, useState } from "react";

import {
  api,
  authUrl,
  CHARACTER_NAMES,
  normalizeSettings,
  post,
  quotaMinutes,
  roastsPerMinute,
  STATE_TEXT,
  SUBSCRIPTION_TEXT,
  type RewardsResponse,
  type Session,
  type Settings,
  type Status
} from "../api.js";
import { ActivityLog } from "./activity.js";
import { BillingCard } from "./billing.js";
import { CustomCharacters } from "./characters.js";
import { Choice, ScaleChoice, targetSteps, TOXICITY_STEPS } from "./controls.js";
import { OptOuts } from "./optouts.js";
import { OverlaySetup } from "./overlay.js";
import { TelegramCard } from "./telegram.js";
import { TestRoast } from "./test-roast.js";
import { TriggerSettings } from "./triggers.js";
import { Tour } from "../tour.js";
import { isTourDone, markTourDone } from "../tour-steps.js";
import { Card, errorText, Field, Shell, State, Tags } from "../ui.js";

export const editable = ({
  tone,
  voice,
  toxicity,
  cooldownSec,
  userCooldownSec,
  triggers,
  stopWords
}: Settings) =>
  JSON.stringify({ tone, voice, toxicity, cooldownSec, userCooldownSec, triggers, stopWords });

/** "40 минут", "2 ч 30 мин", "больше суток". */
export function durationText(minutes: number) {
  if (minutes < 60) return `${String(minutes)} мин`;
  if (minutes >= 24 * 60) return "больше суток";
  const rest = minutes % 60;
  return `${String(Math.floor(minutes / 60))} ч${rest ? ` ${String(rest)} мин` : ""}`;
}

export function greeting(hour = new Date().getHours()) {
  if (hour < 5) return "Доброй ночи";
  if (hour < 12) return "Доброе утро";
  if (hour < 18) return "Добрый день";
  return "Добрый вечер";
}

/** Scrolls to the card named in the hash (#reward, #events) and opens it if it folds. */
export function revealHash() {
  const target = location.hash.slice(1);
  if (!target) return;
  const element = document.getElementById(target);
  if (element instanceof HTMLDetailsElement) element.open = true;
  element?.scrollIntoView({ behavior: "smooth", block: "start" });
}

export function Dashboard({
  session,
  onSession
}: {
  session: Session;
  onSession: (value: Session) => void;
}) {
  const [settings, setSettings] = useState<Settings>();
  const [status, setStatus] = useState<Status>();
  const [rewards, setRewards] = useState<RewardsResponse>();
  const [loadError, setLoadError] = useState("");
  const [notice, setNotice] = useState("");
  const [saving, setSaving] = useState(false);
  const [tourOpen, setTourOpen] = useState(false);
  const [activityReload, setActivityReload] = useState(0);
  // The premium character on air, if any: the chat card offers her name as a trigger.
  const [characterName, setCharacterName] = useState<string | null>(null);
  const refreshStatus = useCallback(async () => setStatus(await api<Status>("/status")), []);
  const load = useCallback(async () => {
    setLoadError("");
    try {
      const [raw, nextStatus] = await Promise.all([
        api<Record<string, unknown>>("/settings"),
        api<Status>("/status")
      ]);
      setSettings(normalizeSettings(raw));
      setStatus(nextStatus);
    } catch (reason) {
      setLoadError(errorText(reason));
    }
    // Rewards depend on Twitch and the channel's affiliate status; never let them block the page.
    api<RewardsResponse>("/rewards")
      .then(setRewards)
      .catch(() => setRewards({ available: false, reason: "twitch_unavailable", rewards: [] }));
  }, []);
  useEffect(() => {
    void load();
  }, [load]);
  // First visit or `/?tour=1`: start the onboarding tour once the panel has rendered. A hash
  // (#reward, #events) from a hint or a report scrolls to its card.
  const ready = Boolean(settings && status);
  useEffect(() => {
    if (!ready) return;
    const params = new URLSearchParams(location.search);
    if (params.get("tour") === "1") {
      params.delete("tour");
      const query = params.toString();
      history.replaceState(
        null,
        "",
        `${location.pathname}${query ? `?${query}` : ""}${location.hash}`
      );
      setTourOpen(true);
    } else if (!isTourDone()) setTourOpen(true);
    revealHash();
    window.addEventListener("hashchange", revealHash);
    return () => window.removeEventListener("hashchange", revealHash);
  }, [ready]);
  const closeTour = useCallback(() => {
    markTourDone();
    setTourOpen(false);
  }, []);
  useEffect(() => {
    const timer = window.setInterval(() => void refreshStatus().catch(() => undefined), 30_000);
    return () => window.clearInterval(timer);
  }, [refreshStatus]);

  // What the server has: the save bar compares the form with it to show unsaved edits.
  const [saved, setSaved] = useState("");
  useEffect(() => {
    if (settings && !saved) setSaved(editable(settings));
  }, [settings, saved]);
  const dirty = Boolean(settings && saved && editable(settings) !== saved);
  useEffect(() => {
    if (!dirty) return;
    const warn = (event: BeforeUnloadEvent) => event.preventDefault();
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty]);

  const patch = <K extends keyof Settings>(key: K, value: Settings[K]) => {
    setNotice("");
    setSettings((old) => (old ? { ...old, [key]: value } : old));
  };
  const save = async () => {
    if (!settings) return;
    setSaving(true);
    setNotice("");
    try {
      const raw = await api<Record<string, unknown>>("/settings", {
        method: "PATCH",
        body: editable(settings)
      });
      const next = normalizeSettings(raw);
      setSettings(next);
      setSaved(editable(next));
      setNotice("Настройки сохранены");
    } catch (reason) {
      setNotice(`Не сохранено: ${errorText(reason)}`);
    } finally {
      setSaving(false);
    }
  };
  // FR-8: the power switch writes only `enabled`, independent of unsaved edits in the form.
  const toggle = async () => {
    if (!settings) return;
    try {
      const result = await api<{ enabled: boolean }>(
        "/settings/enabled",
        post({ enabled: !settings.enabled })
      );
      setSettings((old) => (old ? { ...old, enabled: result.enabled } : old));
      await refreshStatus();
    } catch (reason) {
      setNotice(errorText(reason));
    }
  };

  if (loadError) {
    return (
      <Shell session={session}>
        <State title="Данные не загрузились" text={loadError} action={load} />
      </Shell>
    );
  }
  if (!settings || !status) {
    return (
      <Shell session={session}>
        <State title="Собираем панель…" text="Загружаем настройки и квоту" busy />
      </Shell>
    );
  }
  const stateText = STATE_TEXT[status.state];
  const statusDetail =
    status.state === "suspended"
      ? "Свяжитесь с владельцем сервиса."
      : status.killSwitch
        ? "Владелец сервиса временно остановил генерацию для всех."
        : !status.enabled
          ? "Бот выключен кнопкой справа."
          : status.globalLimitReached
            ? "Достигнут общий лимит сервиса на этот месяц."
            : status.remaining === 0
              ? "Квота канала на месяц закончилась."
              : `Канал #${session.channelLogin} подключён`;
  const total = status.limit + status.gifted;
  const minPause = status.minCooldownSec;
  const minutes = quotaMinutes(
    status.remaining,
    roastsPerMinute(settings.triggers, settings.cooldownSec, status.commandAvailable)
  );
  // A typical stream is a few hours; less than that means the quota burns out on air.
  const quotaShort = minutes !== null && status.remaining > 0 && minutes < 180;
  return (
    <Shell session={session}>
      <div className="page-title">
        <div>
          <p className="eyebrow">ПАНЕЛЬ СТРИМЕРА</p>
          <h1>
            {greeting()}, {session.displayName}
          </h1>
          <p>Настройте характер бота и то, на что он реагирует, до начала эфира.</p>
        </div>
        <div className="title-actions">
          <button className="button secondary" onClick={() => setTourOpen(true)}>
            Тур
          </button>
          <button
            data-tour="power"
            className={`power ${settings.enabled ? "on" : ""}`}
            onClick={() => void toggle()}
            aria-pressed={settings.enabled}
          >
            <span>●</span>
            {settings.enabled ? "Выключить бота" : "Включить бота"}
          </button>
        </div>
      </div>
      {session.missingScopes.length > 0 && (
        <div className="reauth" role="status">
          <span>
            Чтобы бот реагировал на битсы, подписки, фоллоу, прогнозы и рекламу, Twitch нужно выдать
            новые права.
          </span>
          <a className="button secondary" href={authUrl}>
            Перезайти через Twitch
          </a>
        </div>
      )}
      <section className="status-grid">
        <Card className="status-card" tour="status">
          <span className={`status-pill ${status.state === "working" ? "" : "warn"}`}>
            {stateText.pill}
          </span>
          <h2>{stateText.title}</h2>
          <p>{statusDetail}</p>
          <ul className="readiness">
            <li className={status.overlayConnected ? "good" : "bad"}>
              {status.overlayConnected ? "✓ Оверлей открыт" : "✗ Оверлей не открыт"}
              {!status.overlayConnected && (
                <small>
                  {" "}
                  — добавьте ссылку из карточки «Оверлей OBS» в OBS, иначе роасты не прозвучат
                </small>
              )}
            </li>
            {status.twitchEvents && (
              <li
                className={
                  status.twitchEvents.connected && !status.twitchEvents.failed.length
                    ? "good"
                    : "bad"
                }
              >
                {!status.twitchEvents.connected
                  ? "✗ Нет связи с Twitch, переподключаемся"
                  : status.twitchEvents.failed.length
                    ? `✗ Twitch отказал: ${status.twitchEvents.failed
                        .map((type) => SUBSCRIPTION_TEXT[type] ?? type)
                        .join(", ")}`
                    : "✓ Twitch присылает награду и события"}
                {status.twitchEvents.failed.length > 0 && (
                  <small> — перезайдите через Twitch</small>
                )}
              </li>
            )}
          </ul>
        </Card>
        <Card tour="quota">
          <p className="label">КВОТА · {status.month}</p>
          <div className="quota">
            <strong>{status.remaining}</strong>
            <span>
              осталось
              <br />
              из {total}
            </span>
          </div>
          <div className="progress">
            <i
              style={{
                width: `${String(Math.min(100, (status.used / Math.max(1, total)) * 100))}%`
              }}
            />
          </div>
          <small>
            Использовано {status.used}
            {status.gifted ? <> · подарено {status.gifted}</> : null}
          </small>
          {status.premium && (
            <small className="hint below">
              Лучшая модель и голос: осталось {status.premium.remaining} из {status.premium.total} в
              этом месяце, дальше героиня отвечает попроще.
            </small>
          )}
          {minutes !== null && status.remaining > 0 && (
            <p className={`quota-estimate ${quotaShort ? "warn" : ""}`} role="status">
              С такими триггерами квоты хватит примерно на <strong>{durationText(minutes)}</strong>{" "}
              эфира.
              {quotaShort && (
                <>
                  {" "}
                  Оставьте один-два триггера, уменьшите <a href="#command">шанс на слово</a> или
                  увеличьте <a href="#fine-tuning">паузу</a>. Проверить реакцию до эфира можно в
                  карточке <a href="#test">«Тест»</a>, квоту он не тратит.
                </>
              )}
            </p>
          )}
        </Card>
      </section>
      <section className="dashboard-grid">
        <div className="settings-stack">
          <Card tour="character">
            <p className="label">ХАРАКТЕР</p>
            <h2>Кто сегодня жарит?</h2>
            <div className="choice-grid">
              <Choice
                active={settings.tone === "tsundere"}
                title={CHARACTER_NAMES.tsundere}
                desc="Цундэрэ · колюче, но с заботой"
                onClick={() => patch("tone", "tsundere")}
                icon="✦"
              />
              <Choice
                active={settings.tone === "yandere"}
                title={CHARACTER_NAMES.yandere}
                desc="Яндэрэ · мило и слегка пугающе"
                onClick={() => patch("tone", "yandere")}
                icon="♥"
              />
            </div>
            <small className="hint below">
              {characterName
                ? `Сейчас вместо них на стриме ${characterName} — см. «Своя героиня». Токсичность и «Кого жарить» действуют и на неё.`
                : "У каждой свой голос и своя картинка на оверлее."}
            </small>
            <ScaleChoice
              label="Кого жарить"
              tour="target"
              value={settings.triggers.targetMode}
              steps={targetSteps(settings.tone)}
              onChange={(targetMode) => patch("triggers", { ...settings.triggers, targetMode })}
            />
            <ScaleChoice
              label="Токсичность"
              value={settings.toxicity}
              steps={TOXICITY_STEPS}
              onChange={(value) => patch("toxicity", value as Settings["toxicity"])}
            />
          </Card>
          <CustomCharacters onActiveName={setCharacterName} />
          <TriggerSettings
            triggers={settings.triggers}
            characterName={characterName}
            rewards={rewards}
            commandAvailable={status.commandAvailable}
            onChange={(triggers) => patch("triggers", triggers)}
          />
          <details className="card fine-tuning" id="fine-tuning">
            <summary>
              <span>
                <span className="label">ТОНКАЯ НАСТРОЙКА</span>
                <strong>Паузы и стоп-слова</strong>
              </span>
              <small>по умолчанию всё уже настроено</small>
            </summary>
            <fieldset data-tour="cooldowns">
              <legend>Паузы</legend>
              <div className="two-fields">
                <Field
                  label="Пауза между роастами, сек."
                  type="number"
                  min={minPause}
                  max={3600}
                  value={settings.cooldownSec}
                  onChange={(value) =>
                    patch("cooldownSec", Math.max(minPause, Math.min(3600, Number(value) || 0)))
                  }
                />
                <Field
                  label="Один зритель не чаще, сек."
                  type="number"
                  min={minPause}
                  max={86400}
                  value={settings.userCooldownSec}
                  onChange={(value) =>
                    patch(
                      "userCooldownSec",
                      Math.max(minPause, Math.min(86400, Number(value) || 0))
                    )
                  }
                />
              </div>
              <small className="hint below">
                Паузы действуют на чат, награду и фоллоу, на вашем тарифе — не меньше {minPause}{" "}
                сек. Кто зовёт бота во время паузы или чаще трёх раз за полчаса, слышит короткую
                заглушку. Битсы, сабы, рейды и донаты бот озвучивает всегда.
              </small>
            </fieldset>
            <div data-tour="stopwords">
              <Tags
                legend="Ваши стоп-слова"
                value={settings.stopWords}
                onChange={(value) => patch("stopWords", value)}
              />
              <small className="hint below">
                Имена, мемы, больные темы. Общий стоп-лист сервиса работает всегда и не отключается.
              </small>
            </div>
            <OptOuts />
          </details>
          <div className={`save-bar ${dirty ? "dirty" : ""}`} data-tour="save">
            <span role="status">
              {notice || (dirty ? "Есть несохранённые изменения" : "Все изменения сохранены")}
            </span>
            <button
              className={`button ${dirty ? "primary" : "secondary"}`}
              onClick={() => void save()}
              disabled={saving || !dirty}
            >
              {saving ? "Сохраняем…" : "Сохранить"}
            </button>
          </div>
        </div>
        <aside className="side-stack">
          <OverlaySetup
            token={session.overlayToken ?? ""}
            branding={status.branding}
            onRotate={(overlayToken) => onSession({ ...session, overlayToken })}
          />
          <TestRoast
            tests={status.tests}
            onFinished={() => {
              void refreshStatus().catch(() => undefined);
              setActivityReload((value) => value + 1);
            }}
          />
          <ActivityLog reload={activityReload} />
          <BillingCard onPaid={() => void refreshStatus().catch(() => undefined)} />
          <TelegramCard />
        </aside>
      </section>
      <Tour open={tourOpen} onClose={closeTour} />
    </Shell>
  );
}
