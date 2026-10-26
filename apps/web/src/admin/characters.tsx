// Premium characters: what streamers offer to the shop (their pictures would appear on other
// people's streams, so nothing reaches the shop unchecked) and the ElevenLabs voices on offer.
import { useState } from "react";

import {
  api,
  apiUrl,
  ARCHETYPE_TEXT,
  del,
  post,
  voiceSampleUrl,
  type CharacterView
} from "../api.js";
import { Card, errorText, Field } from "../ui.js";
import { useAdmin } from "./common.js";

interface AdminCharacter extends CharacterView {
  usedBy: number;
}
interface AdminVoice {
  id: string;
  label: string;
  description: string;
  enabled: boolean;
  sort: number;
  sampleStatus: "pending" | "ready" | "failed";
  usedBy: number;
}
const SAMPLE_TEXT = {
  pending: "сэмпл записывается…",
  ready: "сэмпл готов",
  failed: "сэмпл не записался"
};

export function AdminCharacters() {
  return (
    <>
      <ShopReview />
      <Voices />
    </>
  );
}

function ShopReview() {
  const { data, error, load } = useAdmin<AdminCharacter[]>("/admin/characters");
  const [notice, setNotice] = useState("");
  const review = async (row: AdminCharacter, approve: boolean) => {
    const note = approve ? undefined : (prompt("Причина для автора (необязательно)") ?? undefined);
    try {
      await api(`/admin/characters/${row.id}/review`, post({ approve, ...(note ? { note } : {}) }));
      await load();
    } catch (reason) {
      setNotice(errorText(reason));
    }
  };
  return (
    <Card>
      <p className="label">МАГАЗИН</p>
      <h2>Героини стримеров</h2>
      <p>
        Своей героиней автор пользуется сразу. В магазин для всех Premium-каналов она попадает
        только после одобрения: проверьте картинку и имя. Опубликованную можно снять — каналы,
        которые её выбрали, вернутся к встроенной героине.
      </p>
      {notice && <p className="feedback">{notice}</p>}
      {error && <p className="feedback">{error}</p>}
      {data?.length === 0 && <p>Заявок нет.</p>}
      {data?.map((row) => (
        <article className="moderation-item character-tile" key={row.id}>
          {row.imagePath && (
            <img className="character-portrait" src={apiUrl(row.imagePath)} alt={row.name} />
          )}
          <div className="character-info">
            <strong>{row.name}</strong>
            <small className="archetype">
              {ARCHETYPE_TEXT[row.archetype].title} — {ARCHETYPE_TEXT[row.archetype].desc}
            </small>
            <small>
              {row.voiceLabel ?? "стандартный голос"} · #{row.author} ·{" "}
              {row.status === "pending"
                ? "ждёт проверки"
                : `в магазине, выбрали ${String(row.usedBy)}`}
            </small>
            <div className="character-actions">
              {row.status === "pending" && (
                <button className="mini primary" onClick={() => void review(row, true)}>
                  В магазин
                </button>
              )}
              <button className="mini" onClick={() => void review(row, false)}>
                {row.status === "pending" ? "Отклонить" : "Снять с магазина"}
              </button>
              {row.imagePath && (
                <a className="mini" href={apiUrl(row.imagePath)} target="_blank" rel="noreferrer">
                  Картинка целиком
                </a>
              )}
            </div>
          </div>
        </article>
      ))}
    </Card>
  );
}

function Voices() {
  const { data, error, load } = useAdmin<AdminVoice[]>("/admin/voices");
  const [notice, setNotice] = useState("");
  const [form, setForm] = useState({ id: "", label: "", description: "" });
  const run = async (action: () => Promise<unknown>) => {
    setNotice("");
    try {
      await action();
      await load();
    } catch (reason) {
      setNotice(errorText(reason));
    }
  };
  return (
    <Card>
      <p className="label">ГОЛОСА</p>
      <h2>Голоса ElevenLabs для героинь</h2>
      <p>
        Добавьте voice ID из библиотеки ElevenLabs. Воркер сам запишет короткий сэмпл, чтобы
        стримеры послушали голос перед выбором; сэмпл тратит около 70 символов месячного лимита
        ElevenLabs. Выключенный или удалённый голос героини заменяет стандартный голос её характера.
      </p>
      {notice && <p className="feedback">{notice}</p>}
      {error && <p className="feedback">{error}</p>}
      {data?.map((voice) => (
        <article className="moderation-item" key={voice.id}>
          <div>
            <strong>{voice.label}</strong>{" "}
            {voice.description && <span className="muted">— {voice.description}</span>}
            <small>
              {" "}
              <code>{voice.id}</code> · {SAMPLE_TEXT[voice.sampleStatus]} · героинь с ним:{" "}
              {voice.usedBy}
              {voice.enabled ? "" : " · выключен"}
            </small>
          </div>
          <div className="character-actions">
            {voice.sampleStatus === "ready" && (
              <button
                className="mini"
                onClick={() => void new Audio(voiceSampleUrl(voice.id)).play()}
              >
                ▶
              </button>
            )}
            <button
              className="mini"
              onClick={() => void run(() => api(`/admin/voices/${voice.id}/sample`, post()))}
            >
              Перезаписать сэмпл
            </button>
            <button
              className="mini"
              onClick={() =>
                void run(() =>
                  api(`/admin/voices/${voice.id}`, {
                    method: "PATCH",
                    body: JSON.stringify({ enabled: !voice.enabled })
                  })
                )
              }
            >
              {voice.enabled ? "Выключить" : "Включить"}
            </button>
            <button
              className="mini"
              onClick={() => {
                if (confirm(`Удалить голос «${voice.label}»?`)) {
                  void run(() => api(`/admin/voices/${voice.id}`, del()));
                }
              }}
            >
              Удалить
            </button>
          </div>
        </article>
      ))}
      <form
        className="character-form"
        onSubmit={(event) => {
          event.preventDefault();
          void run(async () => {
            await api("/admin/voices", post(form));
            setForm({ id: "", label: "", description: "" });
          });
        }}
      >
        <div className="two-fields">
          <Field
            label="Voice ID"
            required
            pattern="[A-Za-z0-9]{10,40}"
            value={form.id}
            onChange={(id) => setForm({ ...form, id: id.trim() })}
          />
          <Field
            label="Название для стримеров"
            required
            maxLength={40}
            value={form.label}
            onChange={(label) => setForm({ ...form, label })}
          />
        </div>
        <Field
          label="Описание"
          placeholder="Например: звонкий, дерзкий"
          maxLength={200}
          value={form.description}
          onChange={(description) => setForm({ ...form, description })}
        />
        <button className="button primary" type="submit">
          Добавить голос
        </button>
      </form>
    </Card>
  );
}
