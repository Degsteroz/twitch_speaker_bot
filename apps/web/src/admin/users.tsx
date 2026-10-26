// Users: requests waiting for approval, invites, accounts with plan and quota dialogs.
import { useEffect, useState } from "react";

import { api, post } from "../api.js";
import { Card, Dialog, Field, Link, State, date, errorText, navigate } from "../ui.js";
import { useAdmin } from "./common.js";
import { InviteLinks } from "./invite-links.js";
import { Invites } from "./invites.js";
import type { UserRow } from "./types.js";

const USER_STATUS_TEXT: Record<UserRow["status"], string> = {
  active: "активен",
  suspended: "приостановлен",
  pending: "заявка"
};
const PLAN_CODES = ["free", "basic", "premium"] as const;

export function AdminUsers({ selfId }: { selfId: string }) {
  const [search, setSearch] = useState(
    () => new URLSearchParams(location.search).get("search") ?? ""
  );
  useEffect(() => {
    const query = search ? `?search=${encodeURIComponent(search)}` : "";
    navigate(`/admin/users${query}`, true);
  }, [search]);
  const users = useAdmin<UserRow[]>(`/admin/users?limit=100&search=${encodeURIComponent(search)}`);
  const [notice, setNotice] = useState("");
  const [planFor, setPlanFor] = useState<UserRow>();
  const [giftFor, setGiftFor] = useState<UserRow>();
  const mutate = async (user: UserRow, action: string, body?: unknown, done = "Сохранено") => {
    try {
      await api(`/admin/users/${user.id}/${action}`, post(body));
      setNotice(`@${user.login}: ${done}`);
      await users.load();
    } catch (reason) {
      setNotice(errorText(reason));
    }
  };
  const pending = users.data?.filter((user) => user.status === "pending") ?? [];
  const accounts = users.data?.filter((user) => user.status !== "pending") ?? [];
  return (
    <>
      {notice && (
        <p className="notice-bar" role="status">
          {notice}
        </p>
      )}
      {pending.length > 0 && (
        <Requests
          users={pending}
          onApprove={(user) => void mutate(user, "activate", undefined, "доступ открыт")}
          onReject={(user) => void mutate(user, "suspend", undefined, "заявка отклонена")}
        />
      )}
      <InviteLinks />
      <Invites />
      <Card>
        <div className="table-head">
          <div>
            <p className="label">АККАУНТЫ</p>
            <h2>Стримеры и лимиты</h2>
          </div>
          <input
            type="search"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="Поиск по логину"
            aria-label="Поиск по логину"
          />
        </div>
        {users.error ? (
          <State title="Список недоступен" text={users.error} action={users.load} />
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Стример</th>
                  <th>Статус</th>
                  <th>Тариф</th>
                  <th>Роасты за месяц</th>
                  <th>Расход</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {accounts.map((user) => (
                  <AccountRow
                    key={user.id}
                    user={user}
                    self={user.id === selfId}
                    onPlan={() => setPlanFor(user)}
                    onGift={() => setGiftFor(user)}
                    onMutate={(action, done) => void mutate(user, action, undefined, done)}
                  />
                ))}
              </tbody>
            </table>
            {users.data && accounts.length === 0 && <p>Никого не нашли.</p>}
          </div>
        )}
      </Card>
      <PlanDialog
        user={planFor}
        onClose={() => setPlanFor(undefined)}
        onSave={async (user, body) => {
          setPlanFor(undefined);
          await mutate(user, "subscription", body, `тариф ${body.plan}`);
        }}
      />
      <GiftDialog
        user={giftFor}
        onClose={() => setGiftFor(undefined)}
        onSave={async (user, body) => {
          setGiftFor(undefined);
          await mutate(user, "gift", body, `+${String(body.amount)} роастов на месяц`);
        }}
      />
    </>
  );
}

function Requests({
  users,
  onApprove,
  onReject
}: {
  users: UserRow[];
  onApprove: (user: UserRow) => void;
  onReject: (user: UserRow) => void;
}) {
  return (
    <Card>
      <p className="label">ЗАЯВКИ</p>
      <h2>Ждут одобрения: {users.length}</h2>
      <ul className="requests">
        {users.map((user) => (
          <li key={user.id}>
            <span>
              <strong>{user.display_name}</strong>
              <small>
                <a href={`https://twitch.tv/${user.login}`} target="_blank" rel="noreferrer">
                  twitch.tv/{user.login}
                </a>{" "}
                · {date(user.created_at)}
              </small>
            </span>
            <span className="row-actions">
              <button className="button primary" onClick={() => onApprove(user)}>
                Одобрить
              </button>
              <button
                className="mini danger"
                onClick={() => {
                  if (confirm(`Отклонить заявку @${user.login}?`)) onReject(user);
                }}
              >
                Отклонить
              </button>
            </span>
          </li>
        ))}
      </ul>
    </Card>
  );
}

function AccountRow({
  user,
  self,
  onPlan,
  onGift,
  onMutate
}: {
  user: UserRow;
  self: boolean;
  onPlan: () => void;
  onGift: () => void;
  onMutate: (action: string, done: string) => void;
}) {
  const quota = `${String(user.used)} из ${String(user.limit + user.gifted)}`;
  return (
    <tr>
      <td>
        <strong>{user.display_name}</strong>
        <small>
          @{user.login}
          {user.role === "owner" ? " · владелец" : ""}
          {user.mfa_enabled ? " · 2FA" : ""}
          {user.enabled === false ? " · бот выключен" : ""}
        </small>
      </td>
      <td>
        <span className={`status-pill ${user.status === "active" ? "" : "warn"}`}>
          {USER_STATUS_TEXT[user.status]}
        </span>
      </td>
      <td>
        {user.plan === "none" ? "нет" : user.plan}
        {user.valid_until && <small>до {date(user.valid_until)}</small>}
      </td>
      <td>
        {user.twitch_login ? (
          <Link href={`/admin/roasts?channel=${encodeURIComponent(user.twitch_login)}`}>
            {quota}
          </Link>
        ) : (
          quota
        )}
        {user.gifted > 0 && <small>подарено {user.gifted}</small>}
      </td>
      <td>${Number(user.cost_usd).toFixed(3)}</td>
      <td className="row-actions">
        <button className="mini" onClick={onPlan}>
          Тариф
        </button>
        <button className="mini" onClick={onGift}>
          + квота
        </button>
        {!self && (
          <button
            className="mini danger"
            onClick={() => {
              const suspend = user.status === "active";
              if (!suspend) onMutate("activate", "доступ возвращён");
              else if (confirm(`Приостановить @${user.login}? Бот замолчит на его канале.`)) {
                onMutate("suspend", "приостановлен");
              }
            }}
          >
            {user.status === "active" ? "Приостановить" : "Вернуть"}
          </button>
        )}
        {user.mfa_enabled && !self && (
          <button
            className="mini"
            onClick={() => {
              if (
                confirm(
                  `Сбросить 2FA для @${user.login}? Делайте это, только убедившись, что пишет сам стример.`
                )
              ) {
                onMutate("mfa/reset", "2FA сброшена");
              }
            }}
          >
            Сбросить 2FA
          </button>
        )}
      </td>
    </tr>
  );
}

function PlanDialog({
  user,
  onClose,
  onSave
}: {
  user: UserRow | undefined;
  onClose: () => void;
  onSave: (user: UserRow, body: { plan: string; validUntil: string | null }) => Promise<void>;
}) {
  const [plan, setPlan] = useState("free");
  const [until, setUntil] = useState("");
  useEffect(() => {
    if (!user) return;
    setPlan(user.plan === "none" ? "free" : user.plan);
    setUntil(user.valid_until ? user.valid_until.slice(0, 10) : "");
  }, [user]);
  return (
    <Dialog open={Boolean(user)} title={`Тариф @${user?.login ?? ""}`} onClose={onClose}>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          if (!user) return;
          void onSave(user, {
            plan,
            validUntil: until ? new Date(`${until}T23:59:59`).toISOString() : null
          });
        }}
      >
        <label className="field-label">
          Тариф
          <select value={plan} onChange={(event) => setPlan(event.target.value)}>
            {PLAN_CODES.map((code) => (
              <option key={code}>{code}</option>
            ))}
          </select>
        </label>
        <Field
          label="Действует до (пусто — бессрочно)"
          type="date"
          value={until}
          onChange={setUntil}
        />
        <small className="hint below">
          Когда срок выйдет, канал вернётся на предыдущий бессрочный тариф.
        </small>
        <div className="auth-actions">
          <button className="button primary">Сохранить</button>
          <button type="button" className="button secondary" onClick={onClose}>
            Отмена
          </button>
        </div>
      </form>
    </Dialog>
  );
}

function GiftDialog({
  user,
  onClose,
  onSave
}: {
  user: UserRow | undefined;
  onClose: () => void;
  onSave: (user: UserRow, body: { amount: number; reason?: string }) => Promise<void>;
}) {
  const [amount, setAmount] = useState("20");
  const [reason, setReason] = useState("");
  useEffect(() => {
    if (user) {
      setAmount("20");
      setReason("");
    }
  }, [user]);
  const value = Math.round(Number(amount));
  return (
    <Dialog open={Boolean(user)} title={`Подарить роасты @${user?.login ?? ""}`} onClose={onClose}>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          if (user && value > 0) {
            void onSave(user, {
              amount: value,
              ...(reason.trim() ? { reason: reason.trim() } : {})
            });
          }
        }}
      >
        <Field
          label="Сколько роастов на этот месяц"
          type="number"
          min={1}
          max={100000}
          value={amount}
          onChange={setAmount}
        />
        <Field
          label="За что (видно в аудите)"
          value={reason}
          maxLength={500}
          onChange={setReason}
        />
        <div className="auth-actions">
          <button className="button primary" disabled={!(value > 0)}>
            Подарить
          </button>
          <button type="button" className="button secondary" onClick={onClose}>
            Отмена
          </button>
        </div>
      </form>
    </Dialog>
  );
}
