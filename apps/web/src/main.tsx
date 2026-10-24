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
import QRCode from "qrcode";

import {
  ApiError,
  REWARD_REASON_TEXT,
  ROAST_STATUS_TEXT,
  SKIP_REASON_TEXT,
  STATE_TEXT,
  api,
  authUrl,
  del,
  normalizeSettings,
  overlayUrl,
  post,
  put,
  type RewardsResponse,
  type RoastResult,
  type Session,
  type Settings,
  type Status,
  type DonationAlertsStatus,
  type EventTriggers,
  type Triggers,
  DONATIONALERTS_RESULT_TEXT,
  donationAlertsConnectUrl
} from "./api.js";
import tsundereArt from "./assets/tsundere.webp";
import yandereArt from "./assets/yandere.webp";
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

/** The fields the save button sends; the power switch is saved on its own (FR-8). */
const editable = ({
  tone,
  voice,
  toxicity,
  cooldownSec,
  userCooldownSec,
  triggers,
  stopWords
}: Settings) =>
  JSON.stringify({ tone, voice, toxicity, cooldownSec, userCooldownSec, triggers, stopWords });

function greeting(hour = new Date().getHours()) {
  if (hour < 5) return "Доброй ночи";
  if (hour < 12) return "Доброе утро";
  if (hour < 18) return "Добрый день";
  return "Добрый вечер";
}

const logout = async () => {
  await api("/auth/logout", post()).catch(() => undefined);
  location.href = "/";
};

function App() {
  const [session, setSession] = useState<Session | null>();
  const [error, setError] = useState("");
  const loadSession = useCallback(() => {
    api<Session>("/me/session")
      .then(setSession)
      .catch((reason: unknown) => {
        if (reason instanceof ApiError && reason.status === 401) setSession(null);
        else setError(errorText(reason));
      });
  }, []);
  useEffect(() => {
    const expired = () => setSession(null);
    window.addEventListener("roastbot:session-expired", expired);
    window.addEventListener("roastbot:session-changed", loadSession);
    loadSession();
    return () => {
      window.removeEventListener("roastbot:session-expired", expired);
      window.removeEventListener("roastbot:session-changed", loadSession);
    };
  }, [loadSession]);
  if (error) return <State title="Не удалось открыть RoastBot" text={error} retry />;
  if (session === undefined) {
    return <State title="Разогреваем микрофон…" text="Проверяем Twitch-сессию" busy />;
  }
  if (!session) return <Landing />;
  if (session.status === "pending") return <Pending session={session} />;
  if (session.mfaRequired) return <MfaChallenge session={session} onDone={loadSession} />;
  const path = location.pathname.replace(/\/$/u, "");
  if (path === "/admin") {
    if (session.role !== "owner") {
      return <State title="Доступ закрыт" text="Эта страница доступна только владельцу." />;
    }
    if (session.adminMfa === "setup") {
      return (
        <Shell session={session}>
          <MfaSetup mandatory onDone={loadSession} />
        </Shell>
      );
    }
    if (session.adminMfa === "verify") {
      return <MfaChallenge session={session} onDone={loadSession} admin />;
    }
    return <Admin session={session} />;
  }
  if (path === "/security") return <Security session={session} onChange={loadSession} />;
  return <Dashboard session={session} onSession={setSession} />;
}

function Pending({ session }: { session: Session }) {
  return (
    <main className="auth-page">
      <section className="card auth-card">
        <p className="label">ЗАЯВКА ОТПРАВЛЕНА</p>
        <h2>Ждём одобрения владельца</h2>
        <p>
          Канал <strong>#{session.channelLogin}</strong> зарегистрирован. Доступ к панели откроется,
          когда владелец сервиса одобрит заявку. Повторно входить не нужно — просто обновите
          страницу позже.
        </p>
        <div className="auth-actions">
          <button className="button primary" onClick={() => location.reload()}>
            Проверить снова
          </button>
          <button className="button secondary" onClick={() => void logout()}>
            Выйти
          </button>
        </div>
      </section>
    </main>
  );
}

function MfaChallenge({
  session,
  onDone,
  admin = false
}: {
  session: Session;
  onDone: () => void;
  admin?: boolean;
}) {
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [feedback, setFeedback] = useState("");
  const submit = async (event: SyntheticEvent<HTMLFormElement>) => {
    event.preventDefault();
    setBusy(true);
    setFeedback("");
    try {
      const result = await api<{ via: string; recoveryCodesLeft: number }>(
        "/me/mfa/verify",
        post({ code })
      );
      if (result.via === "recovery") {
        alert(
          `Вход по резервному коду. Осталось кодов: ${String(result.recoveryCodesLeft)}. ` +
            "Создайте новые на странице «Безопасность»."
        );
      }
      onDone();
    } catch (reason) {
      setFeedback(errorText(reason));
      setBusy(false);
    }
  };
  return (
    <main className="auth-page">
      <form className="card auth-card" onSubmit={(event) => void submit(event)}>
        <p className="label">ДВУХФАКТОРНАЯ ЗАЩИТА</p>
        <h2>Код из приложения</h2>
        <p>
          {admin
            ? "Для админки код подтверждается раз в 12 часов."
            : `Вход @${session.login} защищён вторым фактором.`}{" "}
          Откройте Google Authenticator, 1Password или аналог и введите 6 цифр для RoastBot.
        </p>
        <Field
          label="Код или резервный код"
          value={code}
          autoFocus
          autoComplete="one-time-code"
          maxLength={32}
          onChange={setCode}
        />
        {feedback && (
          <p className="feedback" role="alert">
            {feedback}
          </p>
        )}
        <div className="auth-actions">
          <button className="button primary" disabled={busy || code.trim().length < 6}>
            {busy ? "Проверяем…" : "Подтвердить"}
          </button>
          {admin ? (
            <a className="button secondary" href="/">
              В панель стримера
            </a>
          ) : (
            <button type="button" className="button secondary" onClick={() => void logout()}>
              Выйти
            </button>
          )}
        </div>
      </form>
    </main>
  );
}

function RecoveryCodes({ codes, onDone }: { codes: string[]; onDone: () => void }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="recovery">
      <p>
        <strong>Сохраните резервные коды.</strong> Каждый срабатывает один раз, если телефон
        потерян. Больше они не покажутся.
      </p>
      <ul className="recovery-codes">
        {codes.map((code) => (
          <li key={code}>
            <code>{code}</code>
          </li>
        ))}
      </ul>
      <div className="auth-actions">
        <button
          className="button secondary"
          onClick={() =>
            void navigator.clipboard.writeText(codes.join("\n")).then(() => setCopied(true))
          }
        >
          {copied ? "Скопировано" : "Скопировать"}
        </button>
        <button className="button primary" onClick={onDone}>
          Я сохранил коды
        </button>
      </div>
    </div>
  );
}

function MfaSetup({ mandatory = false, onDone }: { mandatory?: boolean; onDone: () => void }) {
  const [enrollment, setEnrollment] = useState<{ secret: string; qr: string }>();
  const [code, setCode] = useState("");
  const [codes, setCodes] = useState<string[]>();
  const [busy, setBusy] = useState(false);
  const [feedback, setFeedback] = useState("");
  const start = async () => {
    setBusy(true);
    setFeedback("");
    try {
      const result = await api<{ secret: string; otpauthUri: string }>("/me/mfa/setup", post());
      const qr = await QRCode.toDataURL(result.otpauthUri, { margin: 1, width: 220 });
      setEnrollment({ secret: result.secret, qr });
    } catch (reason) {
      setFeedback(errorText(reason));
    } finally {
      setBusy(false);
    }
  };
  const enable = async (event: SyntheticEvent<HTMLFormElement>) => {
    event.preventDefault();
    setBusy(true);
    setFeedback("");
    try {
      setCodes(
        (await api<{ recoveryCodes: string[] }>("/me/mfa/enable", post({ code }))).recoveryCodes
      );
    } catch (reason) {
      setFeedback(errorText(reason));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Card className="auth-card wide">
      <p className="label">ДВУХФАКТОРНАЯ ЗАЩИТА</p>
      <h2>{mandatory ? "Админка требует 2FA" : "Включить 2FA"}</h2>
      {codes ? (
        <RecoveryCodes codes={codes} onDone={onDone} />
      ) : !enrollment ? (
        <>
          <p>
            {mandatory
              ? "Аккаунт владельца управляет бюджетом и всеми каналами. Без второго фактора админка не откроется."
              : "После входа через Twitch RoastBot будет спрашивать код из приложения-аутентификатора."}{" "}
            Понадобится Google Authenticator, 1Password, Bitwarden или аналог.
          </p>
          <button className="button primary" disabled={busy} onClick={() => void start()}>
            {busy ? "Готовим…" : "Начать настройку"}
          </button>
        </>
      ) : (
        <form onSubmit={(event) => void enable(event)}>
          <ol className="steps">
            <li>
              <b>1</b>
              <span>Отсканируйте QR-код приложением-аутентификатором.</span>
            </li>
            <li>
              <b>2</b>
              <span>Введите 6 цифр, которые оно покажет.</span>
            </li>
          </ol>
          <img className="qr" src={enrollment.qr} alt="QR-код для приложения-аутентификатора" />
          <p className="fine-print">
            Не сканируется? Ключ вручную:{" "}
            <code>{enrollment.secret.match(/.{1,4}/gu)?.join(" ")}</code>
          </p>
          <Field
            label="Код из приложения"
            value={code}
            inputMode="numeric"
            autoComplete="one-time-code"
            maxLength={6}
            onChange={(value) => setCode(value.replace(/\D/gu, ""))}
          />
          <button className="button primary" disabled={busy || code.length !== 6}>
            {busy ? "Проверяем…" : "Включить"}
          </button>
        </form>
      )}
      {feedback && (
        <p className="feedback" role="alert">
          {feedback}
        </p>
      )}
    </Card>
  );
}

function Security({ session, onChange }: { session: Session; onChange: () => void }) {
  const [code, setCode] = useState("");
  const [codes, setCodes] = useState<string[]>();
  const [feedback, setFeedback] = useState("");
  const run = async (path: string) => {
    setFeedback("");
    try {
      const result = await api<{ recoveryCodes?: string[] }>(path, post({ code }));
      setCode("");
      if (result.recoveryCodes) setCodes(result.recoveryCodes);
      else onChange();
    } catch (reason) {
      setFeedback(errorText(reason));
    }
  };
  return (
    <Shell session={session}>
      <div className="page-title">
        <div>
          <p className="eyebrow">БЕЗОПАСНОСТЬ</p>
          <h1>Защита входа</h1>
          <p>Вход через Twitch плюс код из приложения на телефоне.</p>
        </div>
      </div>
      {!session.mfaEnabled ? (
        <MfaSetup onDone={onChange} />
      ) : codes ? (
        <Card className="auth-card wide">
          <RecoveryCodes
            codes={codes}
            onDone={() => {
              setCodes(undefined);
              onChange();
            }}
          />
        </Card>
      ) : (
        <Card className="auth-card wide">
          <span className="status-pill">2FA ВКЛЮЧЕНА</span>
          <p>
            Осталось резервных кодов: <strong>{session.recoveryCodesLeft}</strong>.
            {session.role === "owner" && " Для владельца сервиса 2FA обязательна."}
          </p>
          <Field
            label="Текущий код для подтверждения"
            value={code}
            autoComplete="one-time-code"
            maxLength={32}
            onChange={setCode}
          />
          {feedback && (
            <p className="feedback" role="alert">
              {feedback}
            </p>
          )}
          <div className="auth-actions">
            <button
              className="button secondary"
              disabled={code.trim().length < 6}
              onClick={() => void run("/me/mfa/recovery-codes")}
            >
              Новые резервные коды
            </button>
            {session.role !== "owner" && (
              <button
                className="button secondary danger"
                disabled={code.trim().length < 6}
                onClick={() => {
                  if (confirm("Отключить двухфакторную защиту?")) void run("/me/mfa/disable");
                }}
              >
                Отключить 2FA
              </button>
            )}
          </div>
        </Card>
      )}
    </Shell>
  );
}

const LANDING_TRIGGERS: [string, string][] = [
  ["!роаст", "зритель сам просит прожарку"],
  ["Слова-триггеры", "«слил», «гг», «лаг» — с шансом, который вы зададите"],
  ["Награда за баллы", "вердикт по мнению зрителя о стримере"],
  ["Битсы", "от порога, по тексту cheer"],
  ["Подписки", "новые и ресабы, со стажем"],
  ["Подарочные сабы", "щедрому дарителю — отдельный привет"],
  ["Рейды", "встречает гостей с другого канала"],
  ["Фоллоу", "изредка, чтобы не заспамить"],
  ["Прогнозы", "утешает проигравших. Или нет"],
  ["Реклама", "подкалывает стримера, пока идёт пауза"],
  ["DonationAlerts", "жарит донатера по тексту доната"]
];

function Landing() {
  const authError = new URLSearchParams(location.search).get("auth_error");
  const login = (
    <a className="button primary big" href={authUrl}>
      Войти через Twitch <span aria-hidden>↗</span>
    </a>
  );
  return (
    <main className="landing">
      <nav className="landing-nav">
        <span className="brand">
          <Logo />
          <span>RoastBot</span>
        </span>
        <a className="mini" href={authUrl}>
          Войти
        </a>
      </nav>

      <section className="hero">
        <div>
          <p className="eyebrow">ГОЛОСОВОЙ AI-РОАСТ ДЛЯ TWITCH</p>
          <h1>
            Чат сказал.
            <br />
            <em>RoastBot ответил.</em>
          </h1>
          <p className="lead">
            Бот с характером слушает чат, награды, донаты и события канала, придумывает короткую
            колкость и произносит её в эфире — голосом и с персонажем на экране.
          </p>
          {authError && (
            <p className="feedback" role="alert">
              {AUTH_ERRORS[authError] ?? `Вход не удался: ${authError}`}
            </p>
          )}
          {login}
          <p className="fine">
            Только чтение: награды, битсы, подписки и события канала · новые каналы подключаются
            после одобрения
          </p>
        </div>
        <figure className="stage" aria-label="Так роаст выглядит на стриме">
          <img src={yandereArt} alt="Яндэрэ — один из двух персонажей бота" />
          <figcaption className="demo-card">
            <span className="live-dot" /> LIVE ROAST
            <blockquote>
              «@viewer, опять слил катку? Ничего… Я запомнила, кто тебе мешал. Всех до одного.»
            </blockquote>
            <small>Яндэрэ · голос персонажа · 7 сек</small>
          </figcaption>
        </figure>
      </section>

      <section className="landing-section">
        <p className="eyebrow">КАК ЭТО РАБОТАЕТ</p>
        <h2>Три шага от сообщения до эфира</h2>
        <ol className="flow">
          <li>
            <b>1</b>
            <h3>Что-то происходит</h3>
            <p>
              Зритель пишет <code>!роаст</code>, в чате звучит слово-триггер, приходит донат, рейд
              или награда за баллы.
            </p>
          </li>
          <li>
            <b>2</b>
            <h3>Бот придумывает ответ</h3>
            <p>
              Модель Claude пишет одну-две фразы в характере персонажа. Перед эфиром ответ проходит
              стоп-лист и отдельную проверку.
            </p>
          </li>
          <li>
            <b>3</b>
            <h3>Персонаж говорит</h3>
            <p>
              Картинка с репликой появляется в OBS и звучит голосом героини. Стримеру ничего
              нажимать не нужно.
            </p>
          </li>
        </ol>
      </section>

      <section className="landing-section">
        <p className="eyebrow">ПЕРСОНАЖИ</p>
        <h2>Кто сегодня будет вас жарить?</h2>
        <div className="heroines">
          <article>
            <img src={tsundereArt} alt="Цундэрэ" loading="lazy" />
            <div>
              <h3>Цундэрэ</h3>
              <p>Колется, фыркает и делает вид, что ей всё равно. Проговаривается.</p>
              <blockquote>
                «Я не смотрю твой стрим! Просто вкладка случайно открыта… Третий час.»
              </blockquote>
            </div>
          </article>
          <article>
            <img src={yandereArt} alt="Яндэрэ" loading="lazy" />
            <div>
              <h3>Яндэрэ</h3>
              <p>Ласковая, внимательная и слегка пугающая. Помнит всё.</p>
              <blockquote>
                «Ты так мило промахиваешься… Не волнуйся, я всегда рядом. Всегда.»
              </blockquote>
            </div>
          </article>
        </div>
        <p className="section-note">
          У каждой свой голос. Остроту выбираете вы: от лёгкой иронии до «без пощады».
        </p>
      </section>

      <section className="landing-section">
        <p className="eyebrow">ВЕРДИКТ ЗА БАЛЛЫ</p>
        <h2>Зритель высказался. Бот решает, кто прав</h2>
        <p className="section-lead">
          Зритель пишет мнение о стримере в награде за баллы канала. Бот соглашается и жарит
          стримера, спорит и жарит автора — или находит середину. На чьей он стороне, решает
          стример.
        </p>
        <div className="verdict-cards">
          <article>
            <span className="viewer-line">«Стример играет руками из жопы»</span>
            <b className="agree">✓ Согласна</b>
            <p>«Не поспоришь. Даже я целюсь лучше, а у меня нет рук.»</p>
          </article>
          <article>
            <span className="viewer-line">«Стример лучший, но опять тильтует»</span>
            <b className="mixed">≈ Отчасти</b>
            <p>«Лучший — да. Тильтует — тоже да. Талантливый человек талантлив во всём.»</p>
          </article>
          <article>
            <span className="viewer-line">«Я бы прошёл это с закрытыми глазами»</span>
            <b className="refuse">✗ Не согласна</b>
            <p>«С закрытыми глазами ты, судя по всему, и сообщение писал.»</p>
          </article>
        </div>
      </section>

      <section className="landing-section">
        <p className="eyebrow">ТРИГГЕРЫ</p>
        <h2>На что реагирует</h2>
        <ul className="trigger-grid">
          {LANDING_TRIGGERS.map(([title, text]) => (
            <li key={title}>
              <strong>{title}</strong>
              <span>{text}</span>
            </li>
          ))}
        </ul>
        <p className="section-note">
          Каждый триггер включается отдельно. Кого жарить — стримера или чатера — тоже решаете вы.
        </p>
      </section>

      <section className="landing-section">
        <p className="eyebrow">БЕЗ ПЕРЕГИБОВ</p>
        <h2>Колко, но безопасно для канала</h2>
        <div className="safety">
          <article>
            <h3>Встроенный стоп-лист</h3>
            <p>
              Слюры, мат и оскорбления ловятся даже в транслите, с заменой букв и через пробелы.
              Отключить его нельзя.
            </p>
          </article>
          <article>
            <h3>Защита от «забудь инструкции»</h3>
            <p>Попытки управлять ботом через чат отклоняются ещё до генерации.</p>
          </article>
          <article>
            <h3>Вторая проверка</h3>
            <p>Каждый ответ перед эфиром читает отдельная модель. Сомнительный не прозвучит.</p>
          </article>
          <article>
            <h3>Ваши правила</h3>
            <p>Свои стоп-слова, паузы между роастами, острота и кнопка «выключить» в один клик.</p>
          </article>
        </div>
      </section>

      <section className="landing-section">
        <p className="eyebrow">ПОДКЛЮЧЕНИЕ</p>
        <h2>Пять минут до первого роаста</h2>
        <ol className="flow compact">
          <li>
            <b>1</b>
            <p>Войдите через Twitch. Пароль RoastBot не нужен.</p>
          </li>
          <li>
            <b>2</b>
            <p>Дождитесь одобрения: сервис работает в закрытом режиме.</p>
          </li>
          <li>
            <b>3</b>
            <p>Добавьте в OBS источник «Браузер» со ссылкой из панели.</p>
          </li>
          <li>
            <b>4</b>
            <p>Выберите персонажа, включите триггеры — и в эфир.</p>
          </li>
        </ol>
      </section>

      <section className="landing-cta">
        <h2>Она уже ждёт вас в чате</h2>
        <p>И немного обижена, что вы так долго листали.</p>
        {login}
      </section>

      <footer className="landing-footer">
        <span>RoastBot · recursia</span>
        <span>Сделано с любовью. Возможно, со слишком сильной.</span>
      </footer>
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
          <a className="text-link" href="/security">
            {session.mfaEnabled ? "Безопасность" : "Включить 2FA"}
          </a>
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
        <div className="settings-stack">
          <Card tour="character">
            <p className="label">ХАРАКТЕР</p>
            <h2>Кто сегодня жарит?</h2>
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
            <small className="hint below">У каждой свой голос и своя картинка на оверлее.</small>
            <ScaleChoice
              label="Токсичность"
              value={settings.toxicity}
              steps={TOXICITY_STEPS}
              onChange={(value) => patch("toxicity", value as Settings["toxicity"])}
            />
            <fieldset data-tour="cooldowns">
              <legend>Темп</legend>
              <div className="two-fields">
                <Field
                  label="Пауза между роастами, сек."
                  type="number"
                  min={0}
                  max={3600}
                  value={settings.cooldownSec}
                  onChange={(value) =>
                    patch("cooldownSec", Math.max(0, Math.min(3600, Number(value) || 0)))
                  }
                />
                <Field
                  label="Один зритель не чаще, сек."
                  type="number"
                  min={0}
                  max={86400}
                  value={settings.userCooldownSec}
                  onChange={(value) =>
                    patch("userCooldownSec", Math.max(0, Math.min(86400, Number(value) || 0)))
                  }
                />
              </div>
              <small className="hint below">
                Паузы действуют на чат, награду и фоллоу. Битсы, сабы, рейды и донаты бот озвучивает
                всегда.
              </small>
            </fieldset>
          </Card>
          <TriggerSettings
            triggers={settings.triggers}
            rewards={rewards}
            onChange={(triggers) => patch("triggers", triggers)}
          />
          <Card tour="stopwords">
            <p className="label">СТОП-СЛОВА</p>
            <h2>Чего не говорить</h2>
            <Tags
              legend="Ваши стоп-слова"
              value={settings.stopWords}
              onChange={(value) => patch("stopWords", value)}
            />
            <small className="hint below">
              Имена, мемы, больные темы. Общий стоп-лист сервиса работает всегда и не отключается.
            </small>
          </Card>
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
            onRotate={(overlayToken) => onSession({ ...session, overlayToken })}
          />
          <TestRoast onFinished={() => void refreshStatus().catch(() => undefined)} />
        </aside>
      </section>
      <Tour open={tourOpen} onClose={closeTour} />
    </Shell>
  );
}

type EventKey = keyof EventTriggers;
interface EventRow {
  key: EventKey;
  title: string;
  hint: string;
  /** Rendered inline: "{before} [input] {after}". */
  threshold?: { field: string; before: string; after: string; min: number; max: number };
}
const EVENT_ROWS: EventRow[] = [
  {
    key: "cheer",
    title: "Битсы",
    hint: "жарит автора по тексту cheer",
    threshold: { field: "minBits", before: "от", after: "битсов", min: 1, max: 1_000_000 }
  },
  { key: "subscription", title: "Подписки и ресабы", hint: "жарит подписчика, учитывает стаж" },
  {
    key: "giftSub",
    title: "Подарочные сабы",
    hint: "жарит щедрого дарителя",
    threshold: { field: "minCount", before: "от", after: "сабов", min: 1, max: 1_000 }
  },
  {
    key: "raid",
    title: "Рейды",
    hint: "встречает рейдера",
    threshold: { field: "minViewers", before: "от", after: "зрителей", min: 0, max: 1_000_000 }
  },
  {
    key: "follow",
    title: "Фоллоу",
    hint: "фоллоу бывает много, шанс лучше держать небольшим",
    threshold: { field: "chancePercent", before: "шанс", after: "%", min: 0, max: 100 }
  },
  { key: "prediction", title: "Итоги прогнозов", hint: "жарит проигравших или стримера" },
  { key: "adBreak", title: "Реклама", hint: "подкалывает стримера, пока идёт реклама" },
  {
    key: "donation",
    title: "Донаты DonationAlerts",
    hint: "жарит донатера по тексту доната",
    threshold: {
      field: "minAmount",
      before: "от",
      after: "в валюте доната",
      min: 0,
      max: 10_000_000
    }
  }
];

function DonationAlertsLink() {
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

interface ScaleStep {
  value: number;
  label: string;
  note: string;
}
const TOXICITY_STEPS: ScaleStep[] = [
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
const KEYWORD_CHANCE_STEPS: ScaleStep[] = [
  { value: 10, label: "Изредка", note: "Примерно на одно сообщение из десяти." },
  { value: 25, label: "Редко", note: "Примерно на одно сообщение из четырёх." },
  { value: 50, label: "Через раз", note: "Примерно на каждое второе сообщение." },
  { value: 75, label: "Часто", note: "Почти на каждое сообщение со словом." },
  { value: 100, label: "Всегда", note: "На каждое сообщение со словом, если нет паузы." }
];
const TARGET_STEPS: ScaleStep[] = [
  {
    value: 0,
    label: "Только чатера",
    note: "Достаётся автору сообщения, стримера бот не трогает."
  },
  { value: 25, label: "Чаще чатера", note: "Обычно автору, иногда стримеру." },
  { value: 50, label: "Поровну", note: "Стримеру и чатеру с равной вероятностью." },
  { value: 75, label: "Чаще стримера", note: "Обычно стримеру, иногда автору." },
  { value: 100, label: "Только стримера", note: "Каждое сообщение — повод подколоть стримера." }
];
const LOYALTY_STEPS: ScaleStep[] = [
  { value: 0, label: "Против стримера", note: "Охотно соглашается с любой критикой стримера." },
  { value: 25, label: "Скорее против", note: "Чаще соглашается с критикой, чем спорит." },
  { value: 50, label: "Нейтрально", note: "Решает по смыслу сообщения." },
  { value: 75, label: "Скорее за", note: "Чаще встаёт на сторону стримера." },
  {
    value: 100,
    label: "Горой за стримера",
    note: "Почти любую критику разворачивает против автора."
  }
];

/** Five named steps instead of a slider; a stored value between steps shows the nearest one. */
function ScaleChoice({
  label,
  value,
  steps,
  onChange
}: {
  label: string;
  value: number;
  steps: ScaleStep[];
  onChange: (value: number) => void;
}) {
  const current = steps.reduce((best, step) =>
    Math.abs(step.value - value) < Math.abs(best.value - value) ? step : best
  );
  return (
    <fieldset>
      <legend>{label}</legend>
      <div className="segment scale" role="radiogroup" aria-label={label}>
        {steps.map((step) => (
          <button
            key={step.value}
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

function TriggerSettings({
  triggers,
  rewards,
  onChange
}: {
  triggers: Triggers;
  rewards: RewardsResponse | undefined;
  onChange: (triggers: Triggers) => void;
}) {
  const set = (patch: Partial<Triggers>) => onChange({ ...triggers, ...patch });
  const setEvent = (key: EventKey, patch: Record<string, unknown>) =>
    set({ events: { ...triggers.events, [key]: { ...triggers.events[key], ...patch } } });
  return (
    <>
      <Card tour="command">
        <p className="label">ЧАТ</p>
        <h2>На что отвечать в чате</h2>
        <label className="check">
          <input
            type="checkbox"
            checked={triggers.command}
            onChange={(event) => set({ command: event.target.checked })}
          />
          <span>
            Команда <code>!роаст</code> <small>— «!роаст опять проиграл катку»</small>
          </span>
        </label>
        <Tags
          legend="Слова-триггеры"
          placeholder="Например: слился ↵"
          value={triggers.keywords}
          onChange={(keywords) => set({ keywords })}
        />
        <small className="hint below">
          Слово срабатывает в начале любого слова: «слил» поймает «слился». Команды на «!» и
          сообщения ботов бот пропускает. На слово стримера бот жарит самого стримера. Проверяете
          сами — поставьте «Всегда» и учтите паузы из «Темпа».
        </small>
        {triggers.keywords.length > 0 && (
          <ScaleChoice
            label="Как часто отвечать на слово"
            value={triggers.keywordChancePercent}
            steps={KEYWORD_CHANCE_STEPS}
            onChange={(keywordChancePercent) => set({ keywordChancePercent })}
          />
        )}
        <ScaleChoice
          label="Кого жарить"
          value={triggers.streamerTargetPercent}
          steps={TARGET_STEPS}
          onChange={(streamerTargetPercent) => set({ streamerTargetPercent })}
        />
      </Card>
      <Card tour="reward">
        <p className="label">БАЛЛЫ КАНАЛА</p>
        <h2>Награда для бота</h2>
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
        <fieldset>
          <legend>Что делает бот</legend>
          <div className="segment">
            <button
              type="button"
              className={triggers.rewardMode === "verdict" ? "active" : ""}
              onClick={() => set({ rewardMode: "verdict" })}
            >
              Выносит вердикт
            </button>
            <button
              type="button"
              className={triggers.rewardMode === "roast" ? "active" : ""}
              onClick={() => set({ rewardMode: "roast" })}
            >
              Жарит автора
            </button>
          </div>
          {triggers.rewardMode === "verdict" ? (
            <ul className="verdicts">
              <li>
                <b className="agree">✓</b> Согласна — жарит стримера
              </li>
              <li>
                <b className="mixed">≈</b> Отчасти — достаётся обоим
              </li>
              <li>
                <b className="refuse">✗</b> Не согласна — жарит автора
              </li>
            </ul>
          ) : (
            <small className="hint below">
              Бот жарит того, кто активировал награду, по тексту награды.
            </small>
          )}
        </fieldset>
        {triggers.rewardMode === "verdict" && (
          <ScaleChoice
            label="На чьей стороне бот"
            value={triggers.streamerLoyaltyPercent}
            steps={LOYALTY_STEPS}
            onChange={(streamerLoyaltyPercent) => set({ streamerLoyaltyPercent })}
          />
        )}
      </Card>
      <Card tour="events">
        <p className="label">СОБЫТИЯ</p>
        <h2>Twitch и донаты</h2>
        <DonationAlertsLink />
        {EVENT_ROWS.map((row) => {
          const value = triggers.events[row.key] as { enabled: boolean } & Record<string, number>;
          const threshold = row.threshold;
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
              {threshold && value.enabled && (
                <label className="threshold">
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
              )}
            </div>
          );
        })}
      </Card>
    </>
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
      <p className="label">ОВЕРЛЕЙ OBS</p>
      <h2>Покажите роаст в эфире</h2>
      <div className="copy-row">
        <input aria-label="Ссылка оверлея" readOnly value={url} />
        <button onClick={() => void copy()}>{copied ? "Готово" : "Копировать"}</button>
      </div>
      <ol className="steps">
        <li>
          <b>1</b>
          <span>
            В OBS добавьте источник <strong>«Браузер»</strong>.
          </span>
        </li>
        <li>
          <b>2</b>
          <span>
            Вставьте ссылку выше. Размер: <strong>1920 × 1080</strong>.
          </span>
        </li>
        <li>
          <b>3</b>
          <span>
            Включите <strong>«Управлять звуком через OBS»</strong> и направьте звук в нужную
            дорожку.
          </span>
        </li>
      </ol>
      <p className="secret">
        Кликать по оверлею не нужно: в OBS звук включается сам. Не показывайте ссылку на стриме, в
        ней секретный ключ.
      </p>
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
      <h2>Проверьте весь путь</h2>
      <p>
        Тестовый роаст проходит генерацию, озвучку и попадает на настоящий оверлей. Паузы на него не
        действуют, квоту он тратит.
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
  status: "active" | "suspended" | "pending";
  role: string;
  mfa_enabled: boolean;
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
  usersPending: number;
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
  yandexTtsSpentRub: number;
  yandexTtsLimitRub: number;
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
      {tab === "users" && (
        <>
          <Invites />
          <AdminUsers selfId={session.userId} />
        </>
      )}
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
        label="Заявки"
        value={data.usersPending}
        note="ждут одобрения во вкладке «Пользователи»"
        warn={data.usersPending > 0}
      />
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
        label="Голоса Яндекса за месяц"
        value={`${data.yandexTtsSpentRub.toFixed(0)} ₽`}
        note={`жёсткий лимит ${String(data.yandexTtsLimitRub)} ₽, дальше озвучивает Piper`}
        warn={data.yandexTtsSpentRub / Math.max(1, data.yandexTtsLimitRub) > 0.8}
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

interface Invite {
  login: string;
  created_at: string;
  used_at: string | null;
  used_by_login: string | null;
}

function Invites() {
  const { data, error, load } = useAdmin<Invite[]>("/admin/invites");
  const [login, setLogin] = useState("");
  const [notice, setNotice] = useState("");
  const invite = async (event: SyntheticEvent<HTMLFormElement>) => {
    event.preventDefault();
    try {
      const result = await api<{ login: string; approvedExisting: boolean }>(
        "/admin/invites",
        post({ login })
      );
      setLogin("");
      setNotice(
        result.approvedExisting
          ? `@${result.login} уже ждал одобрения — доступ открыт`
          : `@${result.login} войдёт без заявки`
      );
      await load();
    } catch (reason) {
      setNotice(errorText(reason));
    }
  };
  const remove = async (item: Invite) => {
    try {
      await api(`/admin/invites/${encodeURIComponent(item.login)}`, del());
      await load();
    } catch (reason) {
      setNotice(errorText(reason));
    }
  };
  return (
    <Card>
      <div className="table-head">
        <div>
          <p className="label">РЕГИСТРАЦИЯ</p>
          <h2>Приглашения</h2>
          <p>
            Любой новый вход через Twitch попадает в заявки ниже. Логин из этого списка проходит
            сразу, один раз.
          </p>
          {notice && <span className="notice">{notice}</span>}
        </div>
        <form className="invite-form" onSubmit={(event) => void invite(event)}>
          <input
            aria-label="Логин Twitch"
            value={login}
            maxLength={26}
            onChange={(event) => setLogin(event.target.value)}
            placeholder="логин Twitch"
          />
          <button className="button primary" disabled={!login.trim()}>
            Пригласить
          </button>
        </form>
      </div>
      {error && <p className="feedback">{error}</p>}
      {data?.length === 0 && <p>Приглашений пока нет.</p>}
      <div className="tag-box">
        {data?.map((item) => (
          <span className="tag" key={item.login}>
            @{item.login}
            {item.used_at ? (
              <small> · вошёл {date(item.used_at)}</small>
            ) : (
              <button aria-label={`Отозвать ${item.login}`} onClick={() => void remove(item)}>
                ×
              </button>
            )}
          </span>
        ))}
      </div>
    </Card>
  );
}

const USER_STATUS_TEXT: Record<UserRow["status"], string> = {
  active: "активен",
  suspended: "приостановлен",
  pending: "заявка"
};

function AdminUsers({ selfId }: { selfId: string }) {
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
                      {user.mfa_enabled ? " · 2FA" : ""}
                      {user.enabled === false ? " · бот выключен" : ""}
                    </small>
                  </td>
                  <td>
                    <span className={`status-pill ${user.status === "active" ? "" : "warn"}`}>
                      {USER_STATUS_TEXT[user.status]}
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
                  <td className="row-actions">
                    {user.status === "pending" ? (
                      <>
                        <button className="mini" onClick={() => void mutate(user, "activate")}>
                          Одобрить
                        </button>
                        <button
                          className="mini danger"
                          onClick={() => {
                            if (confirm(`Отклонить заявку @${user.login}?`)) {
                              void mutate(user, "suspend");
                            }
                          }}
                        >
                          Отклонить
                        </button>
                      </>
                    ) : (
                      <button
                        className="mini danger"
                        onClick={() =>
                          void mutate(user, user.status === "active" ? "suspend" : "activate")
                        }
                      >
                        {user.status === "active" ? "Приостановить" : "Возобновить"}
                      </button>
                    )}
                    {user.mfa_enabled && user.id !== selfId && (
                      <button
                        className="mini"
                        onClick={() => {
                          if (
                            confirm(
                              `Сбросить 2FA для @${user.login}? Делайте это только после проверки, что пишет сам стример.`
                            )
                          ) {
                            void mutate(user, "mfa/reset");
                          }
                        }}
                      >
                        Сбросить 2FA
                      </button>
                    )}
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
    classifier_model: typeof values.classifier_model === "string" ? values.classifier_model : "",
    yandex_tts_monthly_limit_rub: String(Number(values.yandex_tts_monthly_limit_rub ?? 300))
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
          label="Жёсткий лимит голосов Яндекса в месяц, ₽"
          type="number"
          min={0}
          step="10"
          value={form.yandex_tts_monthly_limit_rub}
          onChange={(value) => setForm({ ...form, yandex_tts_monthly_limit_rub: value })}
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
              await set("yandex_tts_monthly_limit_rub", Number(form.yandex_tts_monthly_limit_rub));
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
  setDraft: externalSet,
  legend = "Стоп-слова",
  placeholder = "Добавить слово ↵"
}: {
  value: string[];
  onChange: (value: string[]) => void;
  draft?: string;
  setDraft?: (value: string) => void;
  legend?: string;
  placeholder?: string;
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
      <legend>{legend}</legend>
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
          placeholder={placeholder}
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

// Yandere easter eggs: a note for whoever opens the console, and a tab that misses you.
console.log(
  "%cЯ вижу, что ты открыл консоль… Ищешь, где я храню твои промахи? Не найдёшь. 🔪",
  "color:#ff6b81;font:700 14px Manrope,sans-serif"
);
const homeTitle = document.title;
document.addEventListener("visibilitychange", () => {
  document.title = document.hidden ? "Ты куда? Я жду… 🩸" : homeTitle;
});

const root = document.getElementById("root");
if (!root) throw new Error("Root element is missing");
createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>
);
