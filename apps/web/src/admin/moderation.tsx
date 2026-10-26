// Moderation: blocked roasts to confirm, and the service-wide stop list.
import { useState } from "react";

import { api, post, put } from "../api.js";
import { Card, Link, Tags, date, errorText } from "../ui.js";
import { useAdmin } from "./common.js";
import { ShowcaseReview } from "./showcase.js";
import { reasonText, statusText } from "./text.js";
import type { Roast } from "./types.js";

export function Moderation() {
  const queue = useAdmin<Roast[]>("/admin/moderation/queue");
  const words = useAdmin<{ words: string[] }>("/admin/moderation");
  const list = words.data?.words ?? [];
  const [draft, setDraft] = useState("");
  const [notice, setNotice] = useState("");
  // The roast whose word is being added, and the word.
  const [adding, setAdding] = useState<{ id: string; word: string }>();
  const save = async (next: string[]) => {
    try {
      await api("/admin/moderation", put(next));
      await words.load();
    } catch (reason) {
      setNotice(errorText(reason));
    }
  };
  const review = async (roast: Roast, addStopWord?: string) => {
    try {
      await api(`/admin/roasts/${roast.id}/review`, post(addStopWord ? { addStopWord } : {}));
      setAdding(undefined);
      await Promise.all([queue.load(), words.load()]);
    } catch (reason) {
      setNotice(errorText(reason));
    }
  };
  return (
    <>
      <div className="dashboard-grid">
        <Card>
          <p className="label">ОЧЕРЕДЬ</p>
          <h2>Заблокированные роасты</h2>
          <p>
            Посмотрите, за что сработал блок. «Всё верно» убирает запись из очереди, «+ стоп-слово»
            ещё и добавляет слово в общий список. Журнал роастов при этом не меняется.
          </p>
          {notice && <p className="feedback">{notice}</p>}
          {queue.error && <p className="feedback">{queue.error}</p>}
          {queue.data?.length === 0 && <p>Очередь пуста.</p>}
          {queue.data?.map((roast) => (
            <article className="moderation-item" key={roast.id}>
              <div>
                <strong>
                  {statusText(roast.status)} · {reasonText(roast.error)}
                </strong>
                <p>
                  @{roast.viewer_login ?? "—"}
                  {roast.twitch_login ? ` на #${roast.twitch_login}` : ""}:{" "}
                  {roast.input_text || "—"}
                </p>
                {roast.status === "blocked_output" && roast.output_text && (
                  <p className="muted">Модель ответила: {roast.output_text}</p>
                )}
                <small>
                  {date(roast.created_at)} · <Link href={`/roasts/${roast.id}`}>подробнее</Link>
                </small>
                {adding?.id === roast.id && (
                  <form
                    className="invite-form"
                    onSubmit={(event) => {
                      event.preventDefault();
                      if (adding.word.trim()) void review(roast, adding.word.trim());
                    }}
                  >
                    <input
                      aria-label="Стоп-слово"
                      autoFocus
                      value={adding.word}
                      maxLength={100}
                      onChange={(event) => setAdding({ id: roast.id, word: event.target.value })}
                    />
                    <button className="button primary" disabled={!adding.word.trim()}>
                      Добавить
                    </button>
                  </form>
                )}
              </div>
              <div>
                <button className="mini" onClick={() => void review(roast)}>
                  Всё верно
                </button>
                <button
                  className="mini"
                  onClick={() =>
                    setAdding({
                      id: roast.id,
                      word: (roast.output_text ?? roast.input_text ?? "").split(/\s+/u)[0] ?? ""
                    })
                  }
                >
                  + стоп-слово
                </button>
              </div>
            </article>
          ))}
        </Card>
        <Card>
          <p className="label">ОБЩИЙ СТОП-ЛИСТ</p>
          <h2>{list.length} слов</h2>
          <p>Дополняет встроенный список на всех каналах. Стример его не видит и не отключит.</p>
          <Tags
            value={list}
            onChange={(next) => void save(next)}
            draft={draft}
            setDraft={setDraft}
          />
        </Card>
      </div>
      <ShowcaseReview />
    </>
  );
}
