// Building blocks shared by the streamer panel and the owner's back-office.
import { useEffect, useRef, useState } from "react";

import { api, post, type Session } from "./api.js";

export const date = (value: unknown) =>
  typeof value === "string" ? new Date(value).toLocaleString("ru-RU") : "—";

export const errorText = (value: unknown) =>
  value instanceof Error ? value.message : "Неизвестная ошибка";

// ---- navigation ---------------------------------------------------------------------------
// history.pushState does not fire popstate; this event tells the app the address changed.
const NAVIGATE_EVENT = "roastbot:navigate";
export function navigate(url: string, replace = false) {
  if (replace) history.replaceState(null, "", url);
  else history.pushState(null, "", url);
  window.dispatchEvent(new Event(NAVIGATE_EVENT));
  if (!replace && !url.includes("#")) window.scrollTo(0, 0);
}
/** Re-renders the caller when the address changes; returns it for effect dependencies. */
export function useAddress(): string {
  const [address, setAddress] = useState(() => location.pathname + location.search);
  useEffect(() => {
    const update = () => setAddress(location.pathname + location.search);
    window.addEventListener("popstate", update);
    window.addEventListener(NAVIGATE_EVENT, update);
    return () => {
      window.removeEventListener("popstate", update);
      window.removeEventListener(NAVIGATE_EVENT, update);
    };
  }, []);
  return address;
}
/** An in-app link: a plain click moves the address without reloading the page. */
export function Link({
  href,
  className,
  children
}: {
  href: string;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <a
      href={href}
      className={className}
      onClick={(event) => {
        if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey) return;
        event.preventDefault();
        navigate(href);
      }}
    >
      {children}
    </a>
  );
}

export const logout = async () => {
  await api("/auth/logout", post()).catch(() => undefined);
  location.href = "/";
};

export function Shell({
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
        <Link className="brand" href="/">
          <Logo />
          <span>RoastBot</span>
        </Link>
        <div className="header-right">
          {session.role === "owner" && (
            <Link className="text-link" href={admin ? "/" : "/admin"}>
              {admin ? "Стримерская" : "Админка"}
            </Link>
          )}
          <Link className="text-link" href="/security">
            {session.mfaEnabled ? "Безопасность" : "Включить 2FA"}
          </Link>
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

export function Tags({
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

export function Logo() {
  return (
    <span className="logo" aria-hidden>
      R
    </span>
  );
}

export function Card({
  children,
  className = "",
  tour
}: {
  children: React.ReactNode;
  className?: string;
  tour?: string;
}) {
  return (
    <section className={`card ${className}`} data-tour={tour} id={tour}>
      {children}
    </section>
  );
}

export function Field({
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

/** A number with a note; `used` draws a limit bar (0–1), `href` makes the card a link. */
export function Metric({
  label,
  value,
  note,
  warn,
  used,
  href
}: {
  label: string;
  value: string | number;
  note: string;
  warn?: boolean;
  used?: number;
  href?: string;
}) {
  const body = (
    <>
      <p className="label">{label}</p>
      <strong>{value}</strong>
      {used !== undefined && (
        <div className="progress">
          <i style={{ width: `${String(Math.min(100, Math.max(0, used * 100)))}%` }} />
        </div>
      )}
      <span>{note}</span>
    </>
  );
  return (
    <Card className={`metric ${warn ? "warn-card" : ""} ${href ? "metric-link" : ""}`}>
      {href ? <Link href={href}>{body}</Link> : body}
    </Card>
  );
}

/** A modal on the native <dialog>: Esc and the backdrop close it, focus stays inside. */
export function Dialog({
  open,
  title,
  onClose,
  children
}: {
  open: boolean;
  title: string;
  onClose: () => void;
  children: React.ReactNode;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (open && !dialog.open) dialog.showModal();
    if (!open && dialog.open) dialog.close();
  }, [open]);
  return (
    <dialog
      ref={ref}
      className="dialog card"
      onClose={onClose}
      onClick={(event) => {
        if (event.target === ref.current) onClose();
      }}
    >
      {open && (
        <>
          <h2>{title}</h2>
          {children}
        </>
      )}
    </dialog>
  );
}

export function State({
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
