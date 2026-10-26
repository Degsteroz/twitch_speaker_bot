// Invite links: roast.recursia.online/i/<code>, optionally with a plan for some days.
import { useState, type SyntheticEvent } from "react";

import { ask } from "../ask.js";
import { api, post } from "../api.js";
import { Card, Field, date, errorText } from "../ui.js";
import { useAdmin } from "./common.js";

interface InviteLinkRow {
  code: string;
  note: string | null;
  plan: string | null;
  planDays: number | null;
  maxUses: number;
  uses: number;
  expiresAt: string | null;
  revokedAt: string | null;
  usedBy: string[];
}

const linkUrl = (code: string) => `${location.origin}/i/${code}`;

export function InviteLinks() {
  const { data, error, load } = useAdmin<InviteLinkRow[]>("/admin/invite-links");
  const [form, setForm] = useState({
    note: "",
    plan: "",
    planDays: "30",
    maxUses: "1",
    expiresInDays: ""
  });
  const [notice, setNotice] = useState("");
  const create = async (event: SyntheticEvent<HTMLFormElement>) => {
    event.preventDefault();
    try {
      const result = await api<{ code: string }>(
        "/admin/invite-links",
        post({
          ...(form.note.trim() ? { note: form.note.trim() } : {}),
          plan: form.plan || null,
          planDays: form.plan ? Number(form.planDays) : null,
          maxUses: Number(form.maxUses) || 1,
          expiresInDays: form.expiresInDays ? Number(form.expiresInDays) : null
        })
      );
      await navigator.clipboard.writeText(linkUrl(result.code)).catch(() => undefined);
      setNotice(`Ссылка скопирована: ${linkUrl(result.code)}`);
      await load();
    } catch (reason) {
      setNotice(errorText(reason));
    }
  };
  const revoke = async (row: InviteLinkRow) => {
    if (
      !(await ask({
        title: "Отозвать ссылку?",
        text: "По ней больше никто не войдёт.",
        confirm: "Отозвать",
        danger: true
      }))
    )
      return;
    try {
      await api(`/admin/invite-links/${row.code}/revoke`, post());
      await load();
    } catch (reason) {
      setNotice(errorText(reason));
    }
  };
  return (
    <Card>
      <p className="label">ИНВАЙТ-ССЫЛКИ</p>
      <h2>Ссылка вместо заявки</h2>
      <p>
        По ссылке стример входит сразу, без одобрения. Можно приложить тариф на срок — например,
        Premium на 30 дней для промо-стримеров. Один аккаунт использует ссылку один раз.
      </p>
      <form className="admin-form" onSubmit={(event) => void create(event)}>
        <Field
          label="Для кого (видно только вам)"
          value={form.note}
          maxLength={200}
          onChange={(note) => setForm({ ...form, note })}
        />
        <label className="field-label">
          Тариф в подарок
          <select
            value={form.plan}
            onChange={(event) => setForm({ ...form, plan: event.target.value })}
          >
            <option value="">без тарифа</option>
            <option value="basic">Basic</option>
            <option value="premium">Premium</option>
          </select>
        </label>
        {form.plan && (
          <Field
            label="На сколько дней"
            type="number"
            min={1}
            max={365}
            value={form.planDays}
            onChange={(planDays) => setForm({ ...form, planDays })}
          />
        )}
        <Field
          label="Сколько аккаунтов могут войти"
          type="number"
          min={1}
          max={1000}
          value={form.maxUses}
          onChange={(maxUses) => setForm({ ...form, maxUses })}
        />
        <Field
          label="Действует дней (пусто — бессрочно)"
          type="number"
          min={1}
          max={365}
          value={form.expiresInDays}
          onChange={(expiresInDays) => setForm({ ...form, expiresInDays })}
        />
        <div className="group-actions">
          <button className="button primary">Создать ссылку</button>
        </div>
      </form>
      {notice && <p className="notice-bar">{notice}</p>}
      {error && <p className="feedback">{error}</p>}
      {data?.map((row) => {
        const active =
          !row.revokedAt &&
          row.uses < row.maxUses &&
          (!row.expiresAt || Date.parse(row.expiresAt) > Date.now());
        return (
          <div className="link-row" key={row.code}>
            <span>
              <code>{linkUrl(row.code)}</code>
              <small className="hint below">
                {row.note ? `${row.note} · ` : ""}
                {row.plan ? `${row.plan} на ${String(row.planDays)} дн. · ` : ""}
                использовано {row.uses} из {row.maxUses}
                {row.expiresAt ? ` · до ${date(row.expiresAt)}` : ""}
                {row.revokedAt ? " · отозвана" : ""}
                {row.usedBy.length ? ` · ${row.usedBy.map((login) => `@${login}`).join(", ")}` : ""}
              </small>
            </span>
            {active && (
              <span className="row-actions">
                <button
                  className="mini"
                  onClick={() => void navigator.clipboard.writeText(linkUrl(row.code))}
                >
                  Копировать
                </button>
                <button className="mini danger" onClick={() => void revoke(row)}>
                  Отозвать
                </button>
              </span>
            )}
          </div>
        );
      })}
    </Card>
  );
}
