import {
  StrictMode,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type SyntheticEvent
} from "react";
import { createRoot } from "react-dom/client";

import {
  ApiError,
  REWARD_REASON_TEXT,
  ROAST_STATUS_TEXT,
  SKIP_REASON_TEXT,
  STATE_TEXT,
  api,
  authUrl,
  normalizeSettings,
  overlayUrl,
  post,
  put,
  type RewardsResponse,
  type RoastResult,
  type Session,
  type Settings,
  type Status
} from "./api.js";
import "./styles.css";
import { Tour } from "./tour.js";
import { isTourDone, markTourDone } from "./tour-steps.js";

const date = (value: unknown) =>
  typeof value === "string" ? new Date(value).toLocaleString("ru-RU") : "—";
const errorText = (value: unknown) =>
  value instanceof Error ? value.message : "Неизвестная ошибка";
const AUTH_ERRORS: Record<string, string> = {
  access_denied: "Вход отменён в Twitch.",
  invalid_oauth_state: "Сессия входа устарела. Попробуйте ещё раз.",
  twitch_unavailable: "Twitch не ответил. Попробуйте позже."
};

function App() {
  const [session, setSession] = useState<Session | null>();
  const [error, setError] = useState("");
  useEffect(() => {
    const expired = () => setSession(null);
    window.addEventListener("roastbot:session-expired", expired);
    api<Session>("/me/session")
      .then(setSession)
      .catch((reason: unknown) => {
        if (reason instanceof ApiError && reason.status === 401) setSession(null);
        else setError(errorText(reason));
      });
    return () => window.removeEventListener("roastbot:session-expired", expired);
  }, []);
  if (error) return <State title="Не удалось открыть RoastBot" text={error} retry />;
  if (session === undefined) {
    return <State title="Разогреваем микрофон…" text="Проверяем Twitch-сессию" busy />;
  }
  if (!session) return <Landing />;
  if (location.pathname.replace(/\/$/u, "") === "/admin") {
    return session.role === "owner" ? (
      <Admin session={session} />
    ) : (
      <State title="Доступ закрыт" text="Эта страница доступна только владельцу." />
    );
  }
  return <Dashboard session={session} onSession={setSession} />;
}

function Landing() {
  const authError = new URLSearchParams(location.search).get("auth_error");
  return (
    <main className="landing">
      <nav className="brand">
        <Logo />
        <span>RoastBot</span>
      </nav>
      <section className="hero">
        <p className="eyebrow">ГОЛОСОВОЙ AI-РОАСТ ДЛЯ TWITCH</p>
        <h1>
          Чат сказал.
          <br />
          <em>RoastBot ответил.</em>
        </h1>
        <p className="lead">
          Награда или команда превращается в короткий персональный роаст — с характером, голосом и
          без опасных перегибов.
        </p>
        {authError && (
          <p className="feedback" role="alert">
            {AUTH_ERRORS[authError] ?? `Вход не удался: ${authError}`}
          </p>
        )}
        <a className="button primary big" href={authUrl}>
          Войти через Twitch <span aria-hidden>↗</span>
        </a>
        <p className="fine">Требуется доступ только к наградам канала</p>
      </section>
      <div className="demo-card">
        <span className="live-dot" /> LIVE ROAST
        <blockquote>
          «@viewer, твой aim — это современное искусство: никто не понимает, но все делают вид.»
        </blockquote>
        <small>Цундэрэ · Женский голос · 8 сек</small>
      </div>
    </main>
  );
}

function Shell({
  session,
  children,
  admin = false
}: {
  session: Session;
  children: React.ReactNode;
  admin?: boolean;
}) {
  const logout = async () => {
    await api("/auth/logout", post()).catch(() => undefined);
    location.href = "/";
  };
  return (
    <div className="shell">
      <header>
        <a className="brand" href="/">
          <Logo />
          <span>RoastBot</span>
        </a>
        <div className="header-right">
          {session.role === "owner" && (
            <a className="text-link" href={admin ? "/" : "/admin"}>
              {admin ? "Стримерская" : "Админка"}
            </a>
          )}
          <span className="avatar">{session.displayName.slice(0, 1).toUpperCase()}</span>
          <div>
            <strong>{session.displayName}</strong>
            <small>@{session.login}</small>
          </div>
          <button className="mini" onClick={() => void logout()}>
            Выйти
          </button>
        </div>
      </header>
      <main className="content">{children}</main>
    </div>
  );
}

function Dashboard({
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
  // First visit: start the onboarding tour once the panel has rendered.
  const ready = Boolean(settings && status);
  useEffect(() => {
    if (ready && !isTourDone()) setTourOpen(true);
  }, [ready]);
  const closeTour = useCallback(() => {
    markTourDone();
    setTourOpen(false);
  }, []);
  useEffect(() => {
    const timer = window.setInterval(() => void refreshStatus().catch(() => undefined), 30_000);
    return () => window.clearInterval(timer);
  }, [refreshStatus]);

  const patch = <K extends keyof Settings>(key: K, value: Settings[K]) =>
    setSettings((old) => (old ? { ...old, [key]: value } : old));
  const save = async () => {
    if (!settings) return;
    setSaving(true);
    setNotice("");
    try {
      const { tone, voice, toxicity, cooldownSec, userCooldownSec, triggers, stopWords } = settings;
      const raw = await api<Record<string, unknown>>("/settings", {
        method: "PATCH",
        body: JSON.stringify({
          tone,
          voice,
          toxicity,
          cooldownSec,
          userCooldownSec,
          triggers,
          stopWords
        })
      });
      setSettings(normalizeSettings(raw));
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
      patch("enabled", result.enabled);
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
  return (
    <Shell session={session}>
      <div className="page-title">
        <div>
          <p className="eyebrow">ПАНЕЛЬ СТРИМЕРА</p>
          <h1>Добрый вечер, {session.displayName}</h1>
          <p>Настрой характер бота перед эфиром.</p>
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
      <section className="status-grid">
        <Card className="status-card" tour="status">
          <span className={`status-pill ${status.state === "working" ? "" : "warn"}`}>
            {stateText.pill}
          </span>
          <h2>{stateText.title}</h2>
          <p>{statusDetail}</p>
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
        </Card>
      </section>
      <section className="dashboard-grid">
        <Card className="settings-card">
          <div className="section-head">
            <div>
              <p className="label">ХАРАКТЕР</p>
              <h2>Как сегодня жарим?</h2>
            </div>
            {notice && (
              <span role="status" className="notice">
                {notice}
              </span>
            )}
          </div>
          <div data-tour="character">
            <fieldset>
              <legend>Тон</legend>
              <div className="choice-grid">
                <Choice
                  active={settings.tone === "tsundere"}
                  title="Цундэрэ"
                  desc="Колюче, но с заботой"
                  onClick={() => patch("tone", "tsundere")}
                  icon="✦"
                />
                <Choice
                  active={settings.tone === "yandere"}
                  title="Яндэрэ"
                  desc="Мило и слегка пугающе"
                  onClick={() => patch("tone", "yandere")}
                  icon="♥"
                />
              </div>
            </fieldset>
            <fieldset>
              <legend>Голос</legend>
              <div className="segment">
                <button
                  className={settings.voice === "female" ? "active" : ""}
                  onClick={() => patch("voice", "female")}
                >
                  Женский
                </button>
                <button
                  className={settings.voice === "male" ? "active" : ""}
                  onClick={() => patch("voice", "male")}
                >
                  Мужской
                </button>
              </div>
            </fieldset>
            <fieldset>
              <legend>
                Токсичность <span>{settings.toxicity}/5</span>
              </legend>
              <input
                aria-label="Токсичность"
                type="range"
                min="1"
                max="5"
                value={settings.toxicity}
                onChange={(event) =>
                  patch("toxicity", Number(event.target.value) as Settings["toxicity"])
                }
              />
              <div className="range-labels">
                <span>Ирония</span>
                <span>Без пощады</span>
              </div>
            </fieldset>
          </div>
          <div className="two-fields" data-tour="cooldowns">
            <Field
              label="Кулдаун канала, сек."
              type="number"
              min={0}
              max={3600}
              value={settings.cooldownSec}
              onChange={(value) =>
                patch("cooldownSec", Math.max(0, Math.min(3600, Number(value) || 0)))
              }
            />
            <Field
              label="Кулдаун зрителя, сек."
              type="number"
              min={0}
              max={86400}
              value={settings.userCooldownSec}
              onChange={(value) =>
                patch("userCooldownSec", Math.max(0, Math.min(86400, Number(value) || 0)))
              }
            />
          </div>
          <fieldset>
            <legend>Триггеры</legend>
            <label className="check" data-tour="command">
              <input
                type="checkbox"
                checked={settings.triggers.command}
                onChange={(event) =>
                  patch("triggers", { ...settings.triggers, command: event.target.checked })
                }
              />
              <span>
                Команда <code>!роаст</code>
              </span>
            </label>
            <div data-tour="reward">
              <label className="field-label">
                Награда за баллы канала
                <select
                  value={settings.triggers.rewardId ?? ""}
                  disabled={!rewards?.available}
                  onChange={(event) =>
                    patch("triggers", {
                      ...settings.triggers,
                      rewardId: event.target.value || null
                    })
                  }
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
              {rewards === undefined && <small>Загружаем награды…</small>}
              {rewards?.reason && <small>{REWARD_REASON_TEXT[rewards.reason]}</small>}
              {rewards?.available && rewards.rewards.length === 0 && (
                <small>На канале нет наград. Создайте награду с полем ввода текста в Twitch.</small>
              )}
            </div>
          </fieldset>
          <div data-tour="stopwords">
            <Tags value={settings.stopWords} onChange={(value) => patch("stopWords", value)} />
          </div>
          <button
            data-tour="save"
            className="button primary"
            onClick={() => void save()}
            disabled={saving}
          >
            {saving ? "Сохраняем…" : "Сохранить настройки"}
          </button>
        </Card>
        <aside className="side-stack">
          <OverlaySetup
            token={session.overlayToken}
            onRotate={(overlayToken) => onSession({ ...session, overlayToken })}
          />
          <TestRoast onFinished={() => void refreshStatus().catch(() => undefined)} />
        </aside>
      </section>
      <Tour open={tourOpen} onClose={closeTour} />
    </Shell>
  );
}

function OverlaySetup({ token, onRotate }: { token: string; onRotate: (token: string) => void }) {
  const url = overlayUrl(token);
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    await navigator.clipboard.writeText(url);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1800);
  };
  const rotate = async () => {
    if (
      !confirm("Старая ссылка перестанет работать. В OBS нужно будет вставить новую. Продолжить?")
    )
      return;
    const result = await api<{ overlayToken: string }>("/me/overlay-token/rotate", post());
    onRotate(result.overlayToken);
  };
  return (
    <Card tour="overlay">
      <p className="label">OBS OVERLAY</p>
      <h2>Покажи роаст в эфире</h2>
      <div className="copy-row">
        <input aria-label="Ссылка оверлея" readOnly value={url} />
        <button onClick={() => void copy()}>{copied ? "Готово" : "Копировать"}</button>
      </div>
      <ol className="steps">
        <li>
          <b>1</b>
          <span>
            В OBS добавь источник <strong>«Браузер»</strong>.
          </span>
        </li>
        <li>
          <b>2</b>
          <span>
            Вставь ссылку выше. Размер: <strong>1920 × 1080</strong>.
          </span>
        </li>
        <li>
          <b>3</b>
          <span>
            Включи <strong>«Управлять звуком через OBS»</strong> и направь его в нужную дорожку.
          </span>
        </li>
      </ol>
      <p className="secret">Никому не показывай ссылку: в ней есть секретный токен.</p>
      <button
        className="mini danger"
        onClick={() => void rotate().catch((reason: unknown) => alert(errorText(reason)))}
      >
        Перевыпустить ссылку
      </button>
    </Card>
  );
}

function TestRoast({ onFinished }: { onFinished: () => void }) {
  const [viewerLogin, setViewer] = useState("test_viewer");
  const [inputText, setText] = useState("");
  const [result, setResult] = useState("");
  const [busy, setBusy] = useState(false);
  const cancelled = useRef(false);
  useEffect(() => () => void (cancelled.current = true), []);

  const poll = async (roastId: string) => {
    const started = Date.now();
    while (!cancelled.current && Date.now() - started < 30_000) {
      await new Promise((resolve) => window.setTimeout(resolve, 700));
      const roast = await api<RoastResult>(`/roasts/${roastId}`);
      if (roast.status === "queued") continue;
      const seconds =
        roast.latencyMs === null ? "" : ` за ${(roast.latencyMs / 1000).toFixed(1)} с`;
      const reason = roast.error ? ` (${SKIP_REASON_TEXT[roast.error] ?? roast.error})` : "";
      const text = roast.outputText ? ` — «${roast.outputText}»` : "";
      const overlay =
        roast.overlayStatus === "delivered"
          ? " Оверлей получил событие."
          : roast.overlayStatus === "pending"
            ? " Оверлей не подключён: откройте ссылку в OBS в течение 2 минут."
            : "";
      return `${ROAST_STATUS_TEXT[roast.status]}${seconds}${reason}${text}.${overlay}`;
    }
    return "Воркер не ответил за 30 секунд — проверьте, что сервис worker запущен.";
  };

  const submit = async (event: SyntheticEvent<HTMLFormElement>) => {
    event.preventDefault();
    setBusy(true);
    setResult("");
    try {
      const value = await api<{ roastId: string; status: string }>(
        "/roasts/test",
        post({ viewerLogin, inputText })
      );
      setResult("В очереди…");
      setResult(await poll(value.roastId));
      onFinished();
    } catch (reason) {
      setResult(`Ошибка: ${errorText(reason)}`);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Card tour="test">
      <p className="label">ТЕСТ</p>
      <h2>Прогони весь путь</h2>
      <p>
        Запрос уйдёт через генерацию, озвучку и настоящий overlay. Кулдауны не действуют, квота —
        да.
      </p>
      <form onSubmit={(event) => void submit(event)}>
        <Field label="Зритель" value={viewerLogin} maxLength={64} onChange={setViewer} />
        <label className="field-label">
          Текст зрителя
          <textarea
            value={inputText}
            maxLength={2000}
            onChange={(event) => setText(event.target.value)}
            placeholder="Например: опять проиграл катку"
          />
        </label>
        <button className="button secondary" disabled={busy || !viewerLogin.trim()}>
          {busy ? "Генерируем…" : "Запустить тест"}
        </button>
        {result && (
          <p className="feedback" role="status">
            {result}
          </p>
        )}
      </form>
    </Card>
  );
}

// ---- back-office --------------------------------------------------------------------------

interface UserRow {
  id: string;
  login: string;
  display_name: string;
  status: "active" | "suspended";
  role: string;
  twitch_login: string | null;
  plan: string;
  valid_until: string | null;
  used: number;
  limit: number;
  gifted: number;
  cost_usd: number;
  enabled: boolean | null;
}
interface Roast {
  id: string;
  channel_id: string;
  twitch_login?: string;
  viewer_login: string | null;
  input_text: string | null;
  output_text: string | null;
  status: string;
  cost_usd: string;
  latency_ms: number | null;
  error: string | null;
  created_at: string;
}
interface Overview {
  usersTotal: number;
  usersActive: number;
  activeChannelsHour: number;
  roastsToday: number;
  errorsToday: number;
  blockedToday: number;
  skippedToday: number;
  roastsMonth: number;
  spentMonth: number;
  roastCap: number;
  budget: number;
  killSwitch: boolean;
  pendingModeration: number;
}
type AnyRow = Record<string, unknown>;

function Admin({ session }: { session: Session }) {
  const [tab, setTab] = useState("overview");
  const tabs: [string, string][] = [
    ["overview", "Обзор"],
    ["users", "Пользователи"],
    ["roasts", "Роасты"],
    ["moderation", "Модерация"],
    ["settings", "Глобальные"],
    ["audit", "Аудит"]
  ];
  return (
    <Shell session={session} admin>
      <div className="page-title">
        <div>
          <p className="eyebrow">OWNER CONTROL</p>
          <h1>Центр управления</h1>
          <p>Состояние сервиса и ручные операции.</p>
        </div>
      </div>
      <nav className="tabs" aria-label="Разделы администратора">
        {tabs.map(([id, label]) => (
          <button key={id} className={tab === id ? "active" : ""} onClick={() => setTab(id)}>
            {label}
          </button>
        ))}
      </nav>
      {tab === "overview" && <AdminOverview />}
      {tab === "users" && <AdminUsers />}
      {tab === "roasts" && <AdminRoasts />}
      {tab === "moderation" && <Moderation />}
      {tab === "settings" && <GlobalSettings />}
      {tab === "audit" && <Audit />}
    </Shell>
  );
}

interface AdminResult<T> {
  data: T | undefined;
  error: string;
  load: () => Promise<void>;
}
function useAdmin<T>(path: string): AdminResult<T> {
  const [data, setData] = useState<T>();
  const [error, setError] = useState("");
  const load = useCallback(async () => {
    setError("");
    try {
      setData(await api<T>(path));
    } catch (reason) {
      setError(errorText(reason));
    }
  }, [path]);
  useEffect(() => {
    void load();
  }, [load]);
  return { data, error, load };
}

function AdminOverview() {
  const { data, error, load } = useAdmin<Overview>("/admin/overview");
  if (error) return <State title="Обзор недоступен" text={error} action={load} />;
  if (!data) return <State title="Считаем метрики…" busy />;
  const errorRate =
    data.roastsToday + data.errorsToday
      ? (data.errorsToday / (data.roastsToday + data.errorsToday)) * 100
      : 0;
  return (
    <div className="metric-grid">
      <Metric
        label="Каналы за час"
        value={data.activeChannelsHour}
        note={`${String(data.usersActive)} активных из ${String(data.usersTotal)}`}
      />
      <Metric
        label="Роасты сегодня"
        value={data.roastsToday}
        note={`${String(data.blockedToday)} заблокировано · ${String(data.skippedToday)} пропущено`}
      />
      <Metric
        label="Ошибки сегодня"
        value={data.errorsToday}
        note={`${errorRate.toFixed(1)}% (цель < 2%)`}
        warn={errorRate >= 2}
      />
      <Metric
        label="Расход за месяц"
        value={`$${data.spentMonth.toFixed(2)}`}
        note={`из $${data.budget.toFixed(2)}`}
        warn={data.spentMonth / Math.max(0.01, data.budget) > 0.8}
      />
      <Metric
        label="Роасты за месяц"
        value={data.roastsMonth}
        note={`лимит ${String(data.roastCap)}`}
        warn={data.roastsMonth / Math.max(1, data.roastCap) > 0.8}
      />
      <Metric
        label="Модерация"
        value={data.pendingModeration}
        note={data.killSwitch ? "KILL SWITCH ВКЛЮЧЁН" : "ждут проверки"}
        warn={data.killSwitch}
      />
    </div>
  );
}

function AdminUsers() {
  const [search, setSearch] = useState("");
  const { data, error, load } = useAdmin<UserRow[]>(
    `/admin/users?search=${encodeURIComponent(search)}`
  );
  const [notice, setNotice] = useState("");
  const mutate = async (user: UserRow, action: string, body?: unknown) => {
    try {
      await api(`/admin/users/${user.id}/${action}`, post(body));
      setNotice("Сохранено");
      await load();
    } catch (reason) {
      setNotice(errorText(reason));
    }
  };
  return (
    <Card>
      <div className="table-head">
        <div>
          <p className="label">ПОЛЬЗОВАТЕЛИ</p>
          <h2>Аккаунты и лимиты</h2>
          {notice && <span className="notice">{notice}</span>}
        </div>
        <input
          type="search"
          value={search}
          onChange={(event) => setSearch(event.target.value)}
          placeholder="Поиск по логину"
        />
      </div>
      {error ? (
        <State title="Список недоступен" text={error} action={load} />
      ) : (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Пользователь</th>
                <th>Статус</th>
                <th>Тариф</th>
                <th>Использование</th>
                <th>Подарок</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {data?.map((user) => (
                <tr key={user.id}>
                  <td>
                    <strong>{user.display_name}</strong>
                    <small>
                      @{user.login}
                      {user.role === "owner" ? " · owner" : ""}
                      {user.enabled === false ? " · бот выключен" : ""}
                    </small>
                  </td>
                  <td>
                    <span className={`status-pill ${user.status === "active" ? "" : "warn"}`}>
                      {user.status}
                    </span>
                  </td>
                  <td>
                    <select
                      aria-label={`Тариф ${user.login}`}
                      value={user.plan}
                      onChange={(event) =>
                        void mutate(user, "subscription", {
                          plan: event.target.value,
                          validUntil: null
                        })
                      }
                    >
                      {user.plan === "none" && <option value="none">нет</option>}
                      <option>free</option>
                      <option>basic</option>
                      <option>premium</option>
                    </select>
                    {user.valid_until && <small>до {date(user.valid_until)}</small>}
                  </td>
                  <td>
                    {user.used} / {user.limit + user.gifted}
                    <small>${Number(user.cost_usd).toFixed(4)}</small>
                  </td>
                  <td>
                    <button
                      className="mini"
                      onClick={() => {
                        const amount = Number(
                          prompt("Сколько роастов подарить на этот месяц?", "20")
                        );
                        if (Number.isInteger(amount) && amount > 0) {
                          void mutate(user, "gift", { amount, reason: "Owner dashboard" });
                        }
                      }}
                    >
                      + квота
                    </button>
                  </td>
                  <td>
                    <button
                      className="mini danger"
                      onClick={() =>
                        void mutate(user, user.status === "active" ? "suspend" : "activate")
                      }
                    >
                      {user.status === "active" ? "Приостановить" : "Возобновить"}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  );
}

function RoastTable({ rows }: { rows: Roast[] | undefined }) {
  const [open, setOpen] = useState<string>();
  return (
    <div className="table-wrap">
      <table>
        <thead>
          <tr>
            <th>Дата</th>
            <th>Зритель</th>
            <th>Статус</th>
            <th>Канал</th>
            <th>Стоимость</th>
            <th>Задержка</th>
          </tr>
        </thead>
        <tbody>
          {rows?.map((roast) => (
            <RoastRow
              key={roast.id}
              roast={roast}
              open={open === roast.id}
              onToggle={() => setOpen(open === roast.id ? undefined : roast.id)}
            />
          ))}
        </tbody>
      </table>
    </div>
  );
}

function RoastRow({
  roast,
  open,
  onToggle
}: {
  roast: Roast;
  open: boolean;
  onToggle: () => void;
}) {
  return (
    <>
      <tr className="clickable" onClick={onToggle}>
        <td>{date(roast.created_at)}</td>
        <td>@{roast.viewer_login ?? "—"}</td>
        <td>
          <span className={`status-pill ${roast.status === "done" ? "" : "warn"}`}>
            {roast.status}
          </span>
        </td>
        <td>{roast.twitch_login ? `#${roast.twitch_login}` : roast.channel_id.slice(0, 8)}</td>
        <td>${Number(roast.cost_usd).toFixed(5)}</td>
        <td>{roast.latency_ms === null ? "—" : `${String(roast.latency_ms)} мс`}</td>
      </tr>
      {open && (
        <tr>
          <td colSpan={6} className="details">
            <b>Вход:</b> {roast.input_text || "— (удалён по сроку хранения)"}
            <br />
            <b>Ответ:</b> {roast.output_text ?? "—"}
            {roast.error && (
              <>
                <br />
                <b>Причина:</b> {SKIP_REASON_TEXT[roast.error] ?? roast.error}
              </>
            )}
          </td>
        </tr>
      )}
    </>
  );
}

function AdminRoasts() {
  const [filter, setFilter] = useState({ channelId: "", status: "", from: "", to: "" });
  const query = useMemo(() => {
    const params = new URLSearchParams();
    if (/^[0-9a-f-]{36}$/iu.test(filter.channelId)) params.set("channelId", filter.channelId);
    if (filter.status) params.set("status", filter.status);
    if (filter.from) params.set("from", new Date(`${filter.from}T00:00:00`).toISOString());
    if (filter.to) params.set("to", new Date(`${filter.to}T23:59:59`).toISOString());
    params.set("limit", "200");
    return params.toString();
  }, [filter]);
  const { data, error } = useAdmin<Roast[]>(`/admin/roasts?${query}`);
  return (
    <Card>
      <div className="section-head">
        <div>
          <p className="label">ЛЕНТА</p>
          <h2>Все роасты</h2>
        </div>
        <div className="filters">
          <input
            placeholder="UUID канала"
            value={filter.channelId}
            onChange={(e) => setFilter({ ...filter, channelId: e.target.value.trim() })}
          />
          <select
            value={filter.status}
            onChange={(e) => setFilter({ ...filter, status: e.target.value })}
          >
            <option value="">Все статусы</option>
            {["queued", "blocked_input", "blocked_output", "done", "failed", "skipped"].map((x) => (
              <option key={x}>{x}</option>
            ))}
          </select>
          <input
            aria-label="С даты"
            type="date"
            value={filter.from}
            onChange={(e) => setFilter({ ...filter, from: e.target.value })}
          />
          <input
            aria-label="До даты"
            type="date"
            value={filter.to}
            onChange={(e) => setFilter({ ...filter, to: e.target.value })}
          />
        </div>
      </div>
      {error ? <p className="feedback">{error}</p> : <RoastTable rows={data} />}
    </Card>
  );
}

function Moderation() {
  const queue = useAdmin<Roast[]>("/admin/moderation/queue");
  const words = useAdmin<{ words: string[] }>("/admin/moderation");
  const list = words.data?.words ?? [];
  const [draft, setDraft] = useState("");
  const [notice, setNotice] = useState("");
  const save = async (next: string[]) => {
    try {
      await api("/admin/moderation", put(next));
      await words.load();
    } catch (reason) {
      setNotice(errorText(reason));
    }
  };
  const review = async (roast: Roast, withWord: boolean) => {
    let addStopWord: string | undefined;
    if (withWord) {
      const suggestion = (roast.output_text ?? roast.input_text ?? "").split(/\s+/u)[0] ?? "";
      addStopWord = prompt("Какое слово добавить в глобальный стоп-лист?", suggestion)?.trim();
      if (!addStopWord) return;
    }
    try {
      await api(`/admin/roasts/${roast.id}/review`, post(addStopWord ? { addStopWord } : {}));
      await Promise.all([queue.load(), words.load()]);
    } catch (reason) {
      setNotice(errorText(reason));
    }
  };
  return (
    <div className="dashboard-grid">
      <Card>
        <p className="label">ОЧЕРЕДЬ МОДЕРАЦИИ</p>
        <h2>Заблокированные роасты</h2>
        <p>
          Подтвердите блок или добавьте слово в глобальный стоп-лист. Запись остаётся в журнале.
        </p>
        {notice && <p className="feedback">{notice}</p>}
        {queue.error && <p className="feedback">{queue.error}</p>}
        {queue.data?.length === 0 && <p>Очередь пуста.</p>}
        {queue.data?.map((roast) => (
          <article className="moderation-item" key={roast.id}>
            <div>
              <strong>
                @{roast.viewer_login ?? "—"} · {roast.status === "blocked_input" ? "вход" : "ответ"}
                {roast.twitch_login ? ` · #${roast.twitch_login}` : ""}
              </strong>
              <p>Вход: {roast.input_text || "—"}</p>
              {roast.status === "blocked_output" && <p>Ответ модели не показан в эфире.</p>}
              <small>
                {date(roast.created_at)} · {roast.error ?? ""}
              </small>
            </div>
            <div>
              <button className="mini" onClick={() => void review(roast, false)}>
                Подтвердить блок
              </button>
              <button className="mini" onClick={() => void review(roast, true)}>
                + стоп-слово
              </button>
            </div>
          </article>
        ))}
      </Card>
      <Card>
        <p className="label">ГЛОБАЛЬНЫЙ СПИСОК</p>
        <h2>{list.length} стоп-слов</h2>
        <p>Дополняет встроенный список, стример его отключить не может.</p>
        <Tags value={list} onChange={(next) => void save(next)} draft={draft} setDraft={setDraft} />
      </Card>
    </div>
  );
}

function GlobalSettings() {
  const { data, error, load } = useAdmin<{ key: string; value: unknown }[]>("/admin/settings");
  if (error) return <State title="Настройки недоступны" text={error} action={load} />;
  if (!data) return <State title="Загружаем настройки…" busy />;
  // Remount the form on every reload so inputs always start from the stored values.
  return (
    <GlobalSettingsForm
      key={JSON.stringify(data)}
      values={Object.fromEntries(data.map((item) => [item.key, item.value]))}
      reload={load}
    />
  );
}

function GlobalSettingsForm({
  values,
  reload
}: {
  values: Record<string, unknown>;
  reload: () => Promise<void>;
}) {
  const [notice, setNotice] = useState("");
  const [form, setForm] = useState({
    global_monthly_limit: String(Number(values.global_monthly_limit ?? 4000)),
    monthly_budget_usd: String(Number(values.monthly_budget_usd ?? 5)),
    model: typeof values.model === "string" ? values.model : "",
    classifier_model: typeof values.classifier_model === "string" ? values.classifier_model : ""
  });
  const set = async (key: string, value: unknown) => {
    try {
      await api(`/admin/settings/${key}`, put(value));
      setNotice("Сохранено");
      await reload();
    } catch (reason) {
      setNotice(`Не сохранено: ${errorText(reason)}`);
    }
  };
  const killSwitch = values.kill_switch === true;
  return (
    <Card>
      <div className="section-head">
        <div>
          <p className="label">ГЛОБАЛЬНЫЕ НАСТРОЙКИ</p>
          <h2>Предохранители сервиса</h2>
        </div>
        <span className="notice">{notice}</span>
      </div>
      <div className="admin-form">
        <label className="check">
          <input
            type="checkbox"
            checked={killSwitch}
            onChange={(e) => {
              if (e.target.checked && !confirm("Остановить генерацию для всех каналов?")) return;
              void set("kill_switch", e.target.checked);
            }}
          />
          <span>Kill switch — остановить все генерации</span>
        </label>
        <Field
          label="Лимит роастов в месяц (на весь сервис)"
          type="number"
          min={0}
          value={form.global_monthly_limit}
          onChange={(value) => setForm({ ...form, global_monthly_limit: value })}
        />
        <Field
          label="Бюджет Anthropic в месяц, $"
          type="number"
          min={0}
          step="0.5"
          value={form.monthly_budget_usd}
          onChange={(value) => setForm({ ...form, monthly_budget_usd: value })}
        />
        <Field
          label="Модель генерации"
          value={form.model}
          onChange={(value) => setForm({ ...form, model: value.trim() })}
        />
        <Field
          label="Модель классификатора"
          value={form.classifier_model}
          onChange={(value) => setForm({ ...form, classifier_model: value.trim() })}
        />
        <button
          className="button primary"
          onClick={() =>
            void (async () => {
              await set("global_monthly_limit", Number(form.global_monthly_limit));
              await set("monthly_budget_usd", Number(form.monthly_budget_usd));
              await set("model", form.model);
              await set("classifier_model", form.classifier_model);
            })()
          }
        >
          Сохранить
        </button>
      </div>
      <p>
        Глобальные стоп-слова редактируются во вкладке «Модерация». Лимит в консоли Anthropic
        остаётся последней линией защиты.
      </p>
    </Card>
  );
}

function Audit() {
  const { data, error } = useAdmin<AnyRow[]>("/admin/audit?limit=200");
  return (
    <Card>
      <p className="label">AUDIT LOG</p>
      <h2>История действий</h2>
      {error ? (
        <p>{error}</p>
      ) : (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Дата</th>
                <th>Кто</th>
                <th>Действие</th>
                <th>Цель</th>
                <th>Payload</th>
              </tr>
            </thead>
            <tbody>
              {data?.map((row) => (
                <tr key={String(row.id)}>
                  <td>{date(row.created_at)}</td>
                  <td>{typeof row.actor_login === "string" ? `@${row.actor_login}` : "—"}</td>
                  <td>{String(row.action)}</td>
                  <td>{String(row.target)}</td>
                  <td>
                    <code>{JSON.stringify(row.payload)}</code>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  );
}

function Tags({
  value,
  onChange,
  draft: externalDraft,
  setDraft: externalSet
}: {
  value: string[];
  onChange: (value: string[]) => void;
  draft?: string;
  setDraft?: (value: string) => void;
}) {
  const [localDraft, setLocalDraft] = useState("");
  const draft = externalDraft ?? localDraft;
  const setDraft = externalSet ?? setLocalDraft;
  const add = () => {
    const word = draft.trim();
    if (word && !value.includes(word)) onChange([...value, word]);
    setDraft("");
  };
  return (
    <fieldset>
      <legend>Стоп-слова</legend>
      <div className="tag-box">
        {value.map((word) => (
          <span className="tag" key={word}>
            {word}
            <button
              aria-label={`Удалить ${word}`}
              onClick={() => onChange(value.filter((item) => item !== word))}
            >
              ×
            </button>
          </span>
        ))}
        <input
          value={draft}
          maxLength={100}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              add();
            }
          }}
          placeholder="Добавить слово ↵"
        />
      </div>
    </fieldset>
  );
}

function Logo() {
  return (
    <span className="logo" aria-hidden>
      R
    </span>
  );
}
function Card({
  children,
  className = "",
  tour
}: {
  children: React.ReactNode;
  className?: string;
  tour?: string;
}) {
  return (
    <section className={`card ${className}`} data-tour={tour}>
      {children}
    </section>
  );
}
function Choice({
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
function Field({
  label,
  onChange,
  ...props
}: Omit<React.InputHTMLAttributes<HTMLInputElement>, "onChange"> & {
  label: string;
  onChange?: (value: string) => void;
}) {
  return (
    <label className="field-label">
      {label}
      <input {...props} onChange={onChange ? (e) => onChange(e.target.value) : undefined} />
    </label>
  );
}
function Metric({
  label,
  value,
  note,
  warn
}: {
  label: string;
  value: string | number;
  note: string;
  warn?: boolean;
}) {
  return (
    <Card className={warn ? "metric warn-card" : "metric"}>
      <p className="label">{label}</p>
      <strong>{value}</strong>
      <span>{note}</span>
    </Card>
  );
}
function State({
  title,
  text,
  busy,
  retry,
  action
}: {
  title: string;
  text?: string;
  busy?: boolean;
  retry?: boolean;
  action?: () => void | Promise<void>;
}) {
  return (
    <div className="state" role={busy ? "status" : "alert"}>
      {busy && <span className="spinner" />}
      <h2>{title}</h2>
      {text && <p>{text}</p>}
      {(Boolean(retry) || Boolean(action)) && (
        <button
          className="button secondary"
          onClick={() => (action ? void action() : location.reload())}
        >
          Попробовать снова
        </button>
      )}
    </div>
  );
}

const root = document.getElementById("root");
if (!root) throw new Error("Root element is missing");
createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>
);
