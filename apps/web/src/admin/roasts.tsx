// Roasts: the feed of every channel with a filter kept in the address.
import { useMemo, useState } from "react";

import { SOURCE_TEXT } from "../api.js";
import {
  roastFilterFromSearch,
  roastFilterQuery,
  roastFilterSearch,
  type RoastFilter
} from "../routes.js";
import { Card, Link, date, navigate } from "../ui.js";
import { useAdmin } from "./common.js";
import { ROAST_STATUSES, reasonText, statusText } from "./text.js";
import type { Roast } from "./types.js";

export function AdminRoasts() {
  // A link to "failed roasts of #channel" can be shared.
  const [filter, setFilterState] = useState<RoastFilter>(() =>
    roastFilterFromSearch(location.search)
  );
  const setFilter = (next: RoastFilter) => {
    setFilterState(next);
    navigate(`/admin/roasts${roastFilterSearch(next)}`, true);
  };
  const query = useMemo(() => roastFilterQuery(filter), [filter]);
  const { data, error } = useAdmin<Roast[]>(`/admin/roasts?${query}`);
  return (
    <Card>
      <div className="section-head">
        <div>
          <p className="label">ЛЕНТА</p>
          <h2>Все роасты</h2>
          <p>Нажмите на строку, чтобы увидеть вход и ответ. Фильтр сохраняется в ссылке.</p>
        </div>
        <div className="filters">
          <input
            placeholder="Канал: логин или UUID"
            aria-label="Канал"
            value={filter.channel}
            onChange={(e) => setFilter({ ...filter, channel: e.target.value.trim() })}
          />
          <select
            aria-label="Итог"
            value={filter.status}
            onChange={(e) => setFilter({ ...filter, status: e.target.value })}
          >
            <option value="">Любой итог</option>
            {ROAST_STATUSES.map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
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

function RoastTable({ rows }: { rows: Roast[] | undefined }) {
  const [open, setOpen] = useState<string>();
  if (rows?.length === 0) return <p>Ничего не нашли.</p>;
  return (
    <div className="table-wrap">
      <table>
        <thead>
          <tr>
            <th>Когда</th>
            <th>Канал</th>
            <th>Что</th>
            <th>Итог</th>
            <th>Стоимость</th>
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
  const reason = reasonText(roast.error);
  return (
    <>
      <tr className="clickable" onClick={onToggle}>
        <td>{date(roast.created_at)}</td>
        <td>{roast.twitch_login ? `#${roast.twitch_login}` : roast.channel_id.slice(0, 8)}</td>
        <td>
          {SOURCE_TEXT[roast.source] ?? roast.source}
          <small>@{roast.viewer_login ?? "—"}</small>
        </td>
        <td>
          <span className={`status-pill ${roast.status === "done" ? "" : "warn"}`}>
            {statusText(roast.status)}
          </span>
          {reason && <small>{reason}</small>}
        </td>
        <td>
          ${Number(roast.cost_usd).toFixed(4)}
          {roast.latency_ms !== null && <small>{(roast.latency_ms / 1000).toFixed(1)} с</small>}
        </td>
      </tr>
      {open && (
        <tr>
          <td colSpan={5} className="details">
            <b>Вход:</b> {roast.input_text || "— (пусто или удалён по сроку хранения)"}
            <br />
            <b>Ответ:</b> {roast.output_text ?? "—"}
            {roast.tier && (
              <>
                <br />
                <b>Чем:</b> {roast.tier === "premium" ? "лучшая связка" : "попроще"}
                {roast.model && ` · ${roast.model}`}
                {roast.voice_provider && ` · ${roast.voice_provider}`}
              </>
            )}
            <br />
            <Link href={`/roasts/${roast.id}`}>Ссылка на роаст</Link>
          </td>
        </tr>
      )}
    </>
  );
}
