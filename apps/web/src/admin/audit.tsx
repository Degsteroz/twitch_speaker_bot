// Audit: who changed what, in words, with a filter by action kept in the address.
import { useEffect, useState } from "react";

import { Card, date, navigate } from "../ui.js";
import { useAdmin } from "./common.js";
import { AUDIT_ACTION_LIST, auditText, type AuditRow } from "./text.js";

type AuditEntry = AuditRow & { id: string; created_at: string; actor_login: string | null };

export function Audit() {
  const [action, setAction] = useState(
    () => new URLSearchParams(location.search).get("action") ?? ""
  );
  useEffect(() => {
    navigate(`/admin/audit${action ? `?action=${encodeURIComponent(action)}` : ""}`, true);
  }, [action]);
  const { data, error } = useAdmin<AuditEntry[]>(
    `/admin/audit?limit=200${action ? `&action=${encodeURIComponent(action)}` : ""}`
  );
  return (
    <Card>
      <div className="section-head">
        <div>
          <p className="label">АУДИТ</p>
          <h2>Кто что менял</h2>
          <p>Последние 200 записей.</p>
        </div>
        <div className="filters">
          <select
            aria-label="Действие"
            value={action}
            onChange={(event) => setAction(event.target.value)}
          >
            <option value="">Все действия</option>
            {AUDIT_ACTION_LIST.map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
        </div>
      </div>
      {error ? (
        <p className="feedback">{error}</p>
      ) : (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Когда</th>
                <th>Кто</th>
                <th>Что сделал</th>
                <th>Подробности</th>
              </tr>
            </thead>
            <tbody>
              {data?.map((row) => {
                const text = auditText(row);
                return (
                  <tr key={row.id}>
                    <td>{date(row.created_at)}</td>
                    <td>{row.actor_login ? `@${row.actor_login}` : "—"}</td>
                    <td>{text.action}</td>
                    <td>{text.detail}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          {data?.length === 0 && <p>Записей нет.</p>}
        </div>
      )}
    </Card>
  );
}
