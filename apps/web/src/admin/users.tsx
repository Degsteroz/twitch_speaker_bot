// Users: requests waiting for approval, invites, accounts with plan, quota and favourite dialogs.
import { useEffect, useState } from "react";

import { ask } from "../ask.js";
import { api, post, put } from "../api.js";
import { Card, Dialog, Field, Link, State, date, errorText, navigate } from "../ui.js";
import { ModelSelect, useAdmin } from "./common.js";
import { InviteLinks } from "./invite-links.js";
import { Invites } from "./invites.js";
import type { ChannelOverride, UserRow } from "./types.js";

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
  const [overrideFor, setOverrideFor] = useState<UserRow>();
  const mutate = async (
    user: UserRow,
    action: string,
    body?: unknown,
    done = "Сохранено",
    method = post
  ) => {
    try {
      await api(`/admin/users/${user.id}/${action}`, method(body));
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
                    onOverride={() => setOverrideFor(user)}
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
      <OverrideDialog
        user={overrideFor}
        onClose={() => setOverrideFor(undefined)}
        onSave={async (user, body) => {
          setOverrideFor(undefined);
          await mutate(user, "override", body, "настройки любимчика сохранены", put);
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
                onClick={() =>
                  void (async () => {
                    if (
                      await ask({
                        title: `Отклонить заявку @${user.login}?`,
                        confirm: "Отклонить",
                        danger: true
                      })
                    )
                      onReject(user);
                  })()
                }
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
  onOverride,
  onMutate
}: {
  user: UserRow;
  self: boolean;
  onPlan: () => void;
  onGift: () => void;
  onOverride: () => void;
  onMutate: (action: string, done: string) => void;
}) {
  const quota = user.unlimited
    ? `${String(user.used)} · без лимита`
    : `${String(user.used)} из ${String(user.limit + user.gifted)}`;
  return (
    <tr>
      <td>
        <strong>{user.display_name}</strong>
        <small>
          @{user.login}
          {user.role === "owner" ? " · владелец" : ""}
          {user.mfa_enabled ? " · 2FA" : ""}
          {user.enabled === false ? " · бот выключен" : ""}
          {user.override ? " · ★ любимчик" : ""}
        </small>
        {user.override?.note && <small>{user.override.note}</small>}
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
        {user.twitch_login && user.role !== "owner" && (
          <button className="mini" onClick={onOverride}>
            {user.override ? "★ Настроить" : "☆ Любимчик"}
          </button>
        )}
        {!self && (
          <button
            className="mini danger"
            onClick={() =>
              void (async () => {
                const suspend = user.status === "active";
                if (!suspend) onMutate("activate", "доступ возвращён");
                else if (
                  await ask({
                    title: `Приостановить @${user.login}?`,
                    text: "Бот замолчит на его канале.",
                    confirm: "Приостановить",
                    danger: true
                  })
                ) {
                  onMutate("suspend", "приостановлен");
                }
              })()
            }
          >
            {user.status === "active" ? "Приостановить" : "Вернуть"}
          </button>
        )}
        {user.mfa_enabled && !self && (
          <button
            className="mini"
            onClick={() =>
              void (async () => {
                if (
                  await ask({
                    title: `Сбросить 2FA для @${user.login}?`,
                    text: "Делайте это, только убедившись, что пишет сам стример.",
                    confirm: "Сбросить",
                    danger: true
                  })
                ) {
                  onMutate("mfa/reset", "2FA сброшена");
                }
              })()
            }
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

const EMPTY_OVERRIDE: ChannelOverride = {
  unlimited: false,
  zeroRegrets: false,
  monthlyRoastLimit: null,
  premiumRoasts: null,
  minCooldownSec: null,
  model: null,
  chatModel: null,
  economyModel: null,
  economyVoice: null,
  note: null
};
const INHERIT = "";

/** "" keeps the plan's value; anything else is a whole number. */
const numberOrNull = (value: string) => (value.trim() === "" ? null : Math.round(Number(value)));

/**
 * The owner's exceptions to the plan for one channel: limits, pauses, models and the economy voice.
 * Empty fields keep the plan's values; saving all of them empty removes the favourite.
 */
function OverrideDialog({
  user,
  onClose,
  onSave
}: {
  user: UserRow | undefined;
  onClose: () => void;
  onSave: (user: UserRow, body: ChannelOverride) => Promise<void>;
}) {
  const [form, setForm] = useState(EMPTY_OVERRIDE);
  const [numbers, setNumbers] = useState({ limit: "", premium: "", pause: "" });
  useEffect(() => {
    if (!user) return;
    const current = user.override ?? EMPTY_OVERRIDE;
    setForm(current);
    setNumbers({
      limit: current.monthlyRoastLimit === null ? "" : String(current.monthlyRoastLimit),
      premium: current.premiumRoasts === null ? "" : String(current.premiumRoasts),
      pause: current.minCooldownSec === null ? "" : String(current.minCooldownSec)
    });
  }, [user]);
  const set = (patch: Partial<ChannelOverride>) => setForm({ ...form, ...patch });
  const planPremium =
    user?.plan_premium_roasts === null || user?.plan_premium_roasts === undefined
      ? "все"
      : String(user.plan_premium_roasts);
  const modelField = (label: string, key: "model" | "chatModel" | "economyModel", hint: string) => (
    <label className="field-label">
      {label}
      <select
        value={form[key] === null ? INHERIT : "custom"}
        onChange={(event) =>
          set({ [key]: event.target.value === INHERIT ? null : "claude-sonnet-5-5" })
        }
      >
        <option value={INHERIT}>{hint}</option>
        <option value="custom">Своя модель</option>
      </select>
      {form[key] !== null && (
        <ModelSelect
          label={label}
          value={form[key] ?? ""}
          onChange={(value) => set({ [key]: value })}
        />
      )}
    </label>
  );
  return (
    <Dialog open={Boolean(user)} title={`Любимчик @${user?.login ?? ""}`} onClose={onClose}>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          if (!user) return;
          void onSave(user, {
            ...form,
            monthlyRoastLimit: numberOrNull(numbers.limit),
            premiumRoasts: numberOrNull(numbers.premium),
            minCooldownSec: numberOrNull(numbers.pause),
            note: form.note?.trim() ? form.note.trim() : null
          });
        }}
      >
        <p className="muted">
          Только для этого канала. Пустое поле — как в тарифе {user?.plan ?? ""}. Стоп-лист,
          классификатор, kill switch и общий бюджет действуют всегда.
        </p>
        <label className="check">
          <input
            type="checkbox"
            checked={form.unlimited}
            onChange={(event) => set({ unlimited: event.target.checked })}
          />
          <span>
            Без ограничений
            <small>
              Ни квоты, ни пауз, ни частоты, ни лимита тестов; команда и своя героиня на любом
              тарифе, всегда лучшая модель и голос (по умолчанию Sonnet 5.5).
            </small>
          </span>
        </label>
        <label className="check">
          <input
            type="checkbox"
            checked={form.zeroRegrets}
            onChange={(event) => set({ zeroRegrets: event.target.checked })}
          />
          <span>
            Токсичность «Ноль сожалений»
            <small>
              В панели стримера появится шестой уровень: свободный мат и злой тон. Донаты, команда,
              обращение по имени и награды идут к Sonnet, обычные слова в чате — к модели чата.
              Слюры, угрозы и всё, за что банит Twitch, блокируются по-прежнему.
            </small>
          </span>
        </label>
        {!form.unlimited && (
          <>
            <Field
              label={`Роастов в месяц (тариф: ${String(user?.plan_limit ?? 0)})`}
              type="number"
              min={0}
              max={100000}
              value={numbers.limit}
              onChange={(value) => setNumbers({ ...numbers, limit: value })}
            />
            <Field
              label={`Лучших роастов в месяц (тариф: ${planPremium})`}
              type="number"
              min={0}
              max={100000}
              value={numbers.premium}
              onChange={(value) => setNumbers({ ...numbers, premium: value })}
            />
            <Field
              label="Минимальная пауза, секунд (тариф: 40–60)"
              type="number"
              min={0}
              max={3600}
              value={numbers.pause}
              onChange={(value) => setNumbers({ ...numbers, pause: value })}
            />
          </>
        )}
        {modelField("Модель лучших роастов", "model", form.unlimited ? "Sonnet 5.5" : "Как у всех")}
        {modelField(
          "Модель слов в чате",
          "chatModel",
          form.unlimited ? "Как лучшие роасты" : "Как у всех"
        )}
        {!form.unlimited && (
          <>
            {modelField("Модель после лимита лучших", "economyModel", "Как в тарифе")}
            <label className="field-label">
              Голос после лимита лучших
              <select
                value={form.economyVoice ?? INHERIT}
                onChange={(event) =>
                  set({
                    economyVoice:
                      event.target.value === INHERIT
                        ? null
                        : (event.target.value as "yandex" | "piper")
                  })
                }
              >
                <option value={INHERIT}>Как в тарифе</option>
                <option value="yandex">Яндекс</option>
                <option value="piper">Piper (бесплатный)</option>
              </select>
            </label>
          </>
        )}
        <Field
          label="Заметка (видна только вам)"
          value={form.note ?? ""}
          maxLength={500}
          onChange={(value) => set({ note: value })}
        />
        <div className="auth-actions">
          <button className="button primary">Сохранить</button>
          {user?.override && (
            <button
              type="button"
              className="button secondary danger"
              onClick={() => void onSave(user, EMPTY_OVERRIDE)}
            >
              Убрать из любимчиков
            </button>
          )}
          <button type="button" className="button secondary" onClick={onClose}>
            Отмена
          </button>
        </div>
      </form>
    </Dialog>
  );
}
