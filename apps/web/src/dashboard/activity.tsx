// The activity log: what reached the bot lately and how it ended.
import { useCallback, useEffect, useState } from "react";

import {
  activityOutcome,
  api,
  SIMULATED_KINDS,
  SOURCE_TEXT,
  SUBSCRIPTION_TEXT,
  type Activity,
  type SimulatedKind
} from "../api.js";
import { Card, errorText, Link } from "../ui.js";
import { FavoriteButton } from "./favorite.js";

export function ActivityLog({ reload }: { reload: number }) {
  const [activity, setActivity] = useState<Activity>();
  const [error, setError] = useState("");
  const load = useCallback(() => {
    api<Activity>("/activity")
      .then((value) => {
        setActivity(value);
        setError("");
      })
      .catch((reason: unknown) => setError(errorText(reason)));
  }, []);
  useEffect(() => {
    load();
    const timer = window.setInterval(load, 15_000);
    return () => window.clearInterval(timer);
  }, [load, reload]);
  const subscriptions = Object.entries(activity?.eventsub?.subscriptions ?? {});
  return (
    <Card tour="activity">
      <p className="label">ЖУРНАЛ</p>
      <h2>Что происходило</h2>
      {activity?.eventsub && (
        <ul className="twitch-links">
          {!activity.eventsub.connected && (
            <li className="bad">Нет связи с Twitch, переподключаемся…</li>
          )}
          {subscriptions.map(([type, result]) => (
            <li key={type} className={result === "ok" ? "good" : "bad"}>
              {result === "ok" ? "✓" : "✗"} {SUBSCRIPTION_TEXT[type] ?? type}
              {result !== "ok" && (
                <small> — Twitch отказал ({result}). Перезайдите через Twitch.</small>
              )}
            </li>
          ))}
        </ul>
      )}
      {error && <p className="feedback">{error}</p>}
      {activity?.roasts.length === 0 && (
        <p>Пока ничего не приходило. Запустите тест или активируйте награду на канале.</p>
      )}
      <ol className="activity">
        {activity?.roasts.map((roast) => {
          const outcome = activityOutcome(roast);
          return (
            <li key={roast.id}>
              <div>
                <b>
                  {SOURCE_TEXT[roast.source] ?? roast.source}
                  {roast.testKind && roast.testKind !== "plain"
                    ? ` · ${SIMULATED_KINDS[roast.testKind as SimulatedKind]?.label ?? roast.testKind}`
                    : ""}
                </b>
                {roast.viewerLogin && <span> · {roast.viewerLogin}</span>}
                <time>
                  {new Date(roast.createdAt).toLocaleTimeString("ru-RU", {
                    hour: "2-digit",
                    minute: "2-digit"
                  })}
                </time>
              </div>
              {roast.inputText && <q>{roast.inputText}</q>}
              {roast.status === "done" && roast.outputText && (
                <p className="activity-reply">
                  «{roast.outputText}»
                  <FavoriteButton id={roast.id} favorite={roast.favorite} onChange={load} />
                </p>
              )}
              <small className={outcome.ok ? "good" : "bad"}>
                {outcome.text} · <Link href={`/roasts/${roast.id}`}>подробнее</Link>
              </small>
            </li>
          );
        })}
      </ol>
    </Card>
  );
}
