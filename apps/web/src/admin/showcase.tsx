// Showcase: roasts the streamers starred, waiting for the owner's approval for the landing page.
import { useState } from "react";

import { CHARACTER_NAMES, api, post } from "../api.js";
import { Card, Link, date, errorText } from "../ui.js";
import { useAdmin } from "./common.js";

interface ShowcaseRow {
  id: string;
  text: string;
  inputText: string | null;
  tone: "tsundere" | "yandere";
  characterName: string | null;
  channel: string;
  favoriteAt: string;
  approvedAt: string | null;
}

export function ShowcaseReview() {
  const { data, error, load } = useAdmin<ShowcaseRow[]>("/admin/showcase");
  const [notice, setNotice] = useState("");
  const review = async (row: ShowcaseRow, approved: boolean) => {
    try {
      await api(`/admin/roasts/${row.id}/showcase`, post({ approved }));
      await load();
    } catch (reason) {
      setNotice(errorText(reason));
    }
  };
  return (
    <Card>
      <p className="label">ВИТРИНА</p>
      <h2>Лучшие роасты для сайта</h2>
      <p>
        Стримеры отмечают удачные роасты звёздочкой. Одобренные показываются на главной без ника
        зрителя, с названием канала. Звёздочку стример может снять сам — роаст пропадёт с сайта.
      </p>
      {notice && <p className="feedback">{notice}</p>}
      {error && <p className="feedback">{error}</p>}
      {data?.length === 0 && <p>Отмеченных роастов пока нет.</p>}
      {data?.map((row) => (
        <article className="moderation-item" key={row.id}>
          <div>
            <strong>«{row.text}»</strong>
            {row.inputText && <p className="muted">Зритель: {row.inputText}</p>}
            <small>
              {row.characterName ?? CHARACTER_NAMES[row.tone]} · #{row.channel} · отмечен{" "}
              {date(row.favoriteAt)} · <Link href={`/roasts/${row.id}`}>подробнее</Link>
            </small>
          </div>
          <div>
            {row.approvedAt ? (
              <button className="mini" onClick={() => void review(row, false)}>
                Убрать с сайта
              </button>
            ) : (
              <button className="mini primary" onClick={() => void review(row, true)}>
                На сайт
              </button>
            )}
          </div>
        </article>
      ))}
    </Card>
  );
}
