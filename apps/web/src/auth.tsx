// Screens around the login: waiting for approval, the second factor, the security page.
import { useState, type SyntheticEvent } from "react";
import QRCode from "qrcode";

import { api, post, type Session } from "./api.js";
import { Card, errorText, Field, logout, Shell } from "./ui.js";

export function Pending({ session }: { session: Session }) {
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

export function MfaChallenge({
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

export function RecoveryCodes({ codes, onDone }: { codes: string[]; onDone: () => void }) {
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

export function MfaSetup({
  mandatory = false,
  onDone
}: {
  mandatory?: boolean;
  onDone: () => void;
}) {
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

export function Security({ session, onChange }: { session: Session; onChange: () => void }) {
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
