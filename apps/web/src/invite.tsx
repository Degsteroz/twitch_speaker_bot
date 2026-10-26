// /i/<code>: an invite link. Shows what it gives, then sends the visitor through the Twitch login,
// which applies it (skips the review queue, adds the plan if the link has one).
import { useEffect, useState } from "react";

import { api, authUrl } from "./api.js";
import { Logo, State, errorText } from "./ui.js";

interface InviteLink {
  plan: "basic" | "premium" | null;
  planDays: number | null;
}

const PLAN_NAMES = { basic: "Basic", premium: "Premium" } as const;

export function InvitePage({ code, signedIn }: { code: string; signedIn: boolean }) {
  const [link, setLink] = useState<InviteLink | null>();
  const [error, setError] = useState("");
  useEffect(() => {
    api<InviteLink>(`/invite-links/${encodeURIComponent(code)}`)
      .then(setLink)
      .catch((reason: unknown) => {
        setLink(null);
        setError(errorText(reason));
      });
  }, [code]);
  if (link === undefined) return <State title="Проверяем приглашение…" busy />;
  const login = `${authUrl}?invite=${encodeURIComponent(code)}`;
  return (
    <main className="auth-page">
      <section className="card auth-card">
        <span className="brand">
          <Logo />
          <span>RoastBot</span>
        </span>
        {link ? (
          <>
            <p className="label">ПРИГЛАШЕНИЕ</p>
            <h2>Вас пригласили в RoastBot</h2>
            <p>
              Вход через Twitch — и панель откроется сразу, без заявки.
              {link.plan && link.planDays && (
                <>
                  {" "}
                  В подарок тариф <strong>{PLAN_NAMES[link.plan]}</strong> на {link.planDays} дн.
                </>
              )}
            </p>
            {signedIn && (
              <p className="fine-print">
                Вы уже вошли. Чтобы получить подарок, войдите через Twitch ещё раз по кнопке ниже.
              </p>
            )}
            <div className="auth-actions">
              <a className="button primary" href={login}>
                Войти через Twitch <span aria-hidden>↗</span>
              </a>
            </div>
          </>
        ) : (
          <>
            <p className="label">ПРИГЛАШЕНИЕ</p>
            <h2>Ссылка не работает</h2>
            <p>{error || "Она устарела или уже использована."} Можно войти и подать заявку.</p>
            <div className="auth-actions">
              <a className="button secondary" href="/">
                На главную
              </a>
            </div>
          </>
        )}
      </section>
    </main>
  );
}
