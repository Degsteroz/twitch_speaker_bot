// /roasts/<id>: one roast with its input, reply and why it ended so.
import { useEffect, useState } from "react";

import {
  activityOutcome,
  api,
  ApiError,
  ROAST_STATUS_TEXT,
  SIMULATED_KINDS,
  SOURCE_TEXT,
  type RoastResult,
  type Session,
  type SimulatedKind
} from "./api.js";
import { Card, date, errorText, Link, Shell, State } from "./ui.js";
import { FavoriteButton } from "./dashboard/favorite.js";

export const TIER_TEXT = { premium: "лучшая модель и голос", economy: "попроще" } as const;
export const VOICE_TEXT = { elevenlabs: "ElevenLabs", yandex: "Яндекс", piper: "Piper" } as const;

/** /roasts/<id>: one roast with its input, reply and why it ended so; a link to share. */
export function RoastPage({ session, id }: { session: Session; id: string }) {
  const [roast, setRoast] = useState<RoastResult>();
  const [error, setError] = useState("");
  const owner = session.role === "owner";
  useEffect(() => {
    let active = true;
    setRoast(undefined);
    setError("");
    // The owner may open any channel's roast; the admin endpoint needs a fresh 2FA.
    api<RoastResult>(`/roasts/${id}`)
      .catch((reason: unknown) => {
        if (owner && reason instanceof ApiError && reason.status === 404) {
          return api<RoastResult>(`/admin/roasts/${id}`);
        }
        throw reason;
      })
      .then((value) => active && setRoast(value))
      .catch((reason: unknown) => active && setError(errorText(reason)));
    return () => {
      active = false;
    };
  }, [id, owner]);
  const outcome = roast ? activityOutcome(roast) : undefined;
  return (
    <Shell session={session}>
      <div className="page-title">
        <div>
          <p className="eyebrow">РОАСТ</p>
          <h1>Что было и чем закончилось</h1>
          <p>
            <Link href="/">← В панель</Link>
          </p>
        </div>
      </div>
      {error ? (
        <State title="Роаст не открылся" text={error} />
      ) : !roast || !outcome ? (
        <State title="Загружаем роаст…" busy />
      ) : (
        <Card className="roast-page">
          <p className="label">
            {SOURCE_TEXT[roast.source] ?? roast.source}
            {roast.testKind && roast.testKind !== "plain"
              ? ` · ${SIMULATED_KINDS[roast.testKind as SimulatedKind].label}`
              : ""}{" "}
            · #{roast.channelLogin} · {date(roast.createdAt)}
          </p>
          <h2>@{roast.viewerLogin ?? "—"}</h2>
          <dl className="roast-facts">
            <dt>Вход</dt>
            <dd>{roast.inputText || "— (пусто или удалён по сроку хранения)"}</dd>
            <dt>Ответ</dt>
            <dd>
              {roast.outputText ?? "—"}
              {roast.status === "done" && roast.channelLogin === session.channelLogin && (
                <FavoriteButton
                  id={roast.id}
                  favorite={roast.favorite}
                  onChange={() =>
                    setRoast({ ...roast, favorite: !roast.favorite, onShowcase: false })
                  }
                />
              )}
              {roast.onShowcase && <small> · на витрине сайта</small>}
            </dd>
            <dt>Итог</dt>
            <dd className={outcome.ok ? "good" : "bad"}>
              {ROAST_STATUS_TEXT[roast.status]} — {outcome.text}
              {roast.error && <small> ({roast.error})</small>}
            </dd>
            {roast.tier && (
              <>
                <dt>Чем</dt>
                <dd>
                  {TIER_TEXT[roast.tier]}
                  {roast.model && ` · ${roast.model}`}
                  {roast.voiceProvider && ` · голос ${VOICE_TEXT[roast.voiceProvider]}`}
                </dd>
              </>
            )}
            {roast.latencyMs !== null && (
              <>
                <dt>Время</dt>
                <dd>{(roast.latencyMs / 1000).toFixed(1)} с</dd>
              </>
            )}
            {owner && (
              <>
                <dt>Стоимость</dt>
                <dd>${roast.costUsd.toFixed(5)}</dd>
              </>
            )}
          </dl>
        </Card>
      )}
    </Shell>
  );
}
