import { StrictMode, useCallback, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";

import { AskHost } from "./ask.js";
import { Admin } from "./admin/index.js";
import { api, ApiError, type Session } from "./api.js";
import { MfaChallenge, MfaSetup, Pending, Security } from "./auth.js";
import { Dashboard } from "./dashboard/index.js";
import { InvitePage } from "./invite.js";
import { Landing } from "./landing.js";
import { RoastPage } from "./roast-page.js";
import { parseRoute } from "./routes.js";
import { errorText, Shell, State, useAddress } from "./ui.js";
import "./styles.css";

function App() {
  const [session, setSession] = useState<Session | null>();
  const [error, setError] = useState("");
  useAddress();
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
  const route = parseRoute(location.pathname);
  // An invite works with or without a session: a signed-in streamer may use it to get its plan.
  if (route.page === "invite") return <InvitePage code={route.code} signedIn={Boolean(session)} />;
  if (!session) return <Landing />;
  if (session.status === "pending") return <Pending session={session} />;
  if (session.mfaRequired) return <MfaChallenge session={session} onDone={loadSession} />;
  if (route.page === "admin") {
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
    return <Admin session={session} tab={route.tab} />;
  }
  if (route.page === "security") return <Security session={session} onChange={loadSession} />;
  if (route.page === "roast") return <RoastPage session={session} id={route.id} />;
  return <Dashboard session={session} onSession={setSession} />;
}

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
    <AskHost />
  </StrictMode>
);
