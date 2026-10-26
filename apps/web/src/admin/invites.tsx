// Invites: a Twitch login that passes without a request, once.
import { useState, type SyntheticEvent } from "react";

import { api, del, post } from "../api.js";
import { Card, date, errorText } from "../ui.js";
import { useAdmin } from "./common.js";
import type { Invite } from "./types.js";

export function Invites() {
  const { data, error, load } = useAdmin<Invite[]>("/admin/invites");
  const [login, setLogin] = useState("");
  const [notice, setNotice] = useState("");
  const invite = async (event: SyntheticEvent<HTMLFormElement>) => {
    event.preventDefault();
    try {
      const result = await api<{ login: string; approvedExisting: boolean }>(
        "/admin/invites",
        post({ login })
      );
      setLogin("");
      setNotice(
        result.approvedExisting
          ? `@${result.login} уже ждал одобрения — доступ открыт`
          : `@${result.login} войдёт без заявки`
      );
      await load();
    } catch (reason) {
      setNotice(errorText(reason));
    }
  };
  const remove = async (item: Invite) => {
    try {
      await api(`/admin/invites/${encodeURIComponent(item.login)}`, del());
      await load();
    } catch (reason) {
      setNotice(errorText(reason));
    }
  };
  const open = data?.filter((item) => !item.used_at) ?? [];
  const used = data?.filter((item) => item.used_at) ?? [];
  return (
    <Card>
      <div className="table-head">
        <div>
          <p className="label">ПРИГЛАШЕНИЯ</p>
          <h2>Вход без заявки</h2>
          <p>Логин из списка один раз проходит сразу. Остальные новые входы попадают в заявки.</p>
          {notice && <span className="notice">{notice}</span>}
        </div>
        <form className="invite-form" onSubmit={(event) => void invite(event)}>
          <input
            aria-label="Логин Twitch"
            value={login}
            maxLength={26}
            onChange={(event) => setLogin(event.target.value)}
            placeholder="логин Twitch"
          />
          <button className="button primary" disabled={!login.trim()}>
            Пригласить
          </button>
        </form>
      </div>
      {error && <p className="feedback">{error}</p>}
      <div className="tag-box">
        {open.map((item) => (
          <span className="tag" key={item.login}>
            @{item.login}
            <button aria-label={`Отозвать ${item.login}`} onClick={() => void remove(item)}>
              ×
            </button>
          </span>
        ))}
        {data && open.length === 0 && <small>Открытых приглашений нет.</small>}
      </div>
      {used.length > 0 && (
        <details className="used-invites">
          <summary>Использованные: {used.length}</summary>
          <ul>
            {used.map((item) => (
              <li key={item.login}>
                @{item.login} · вошёл {date(item.used_at)}
              </li>
            ))}
          </ul>
        </details>
      )}
    </Card>
  );
}
