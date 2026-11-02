// One phrase from Mitsuki and Ai in every voice service, side by side: to decide which voice comes
// first without trying it on a live stream. The worker records it; each call spends a few dozen
// characters of that service's monthly cap.
import { useEffect, useRef, useState } from "react";

import { api, apiUrl, post } from "../api.js";
import { Card, errorText } from "../ui.js";
import { useAdmin } from "./common.js";

type Tone = "tsundere" | "yandere";
type Provider = "elevenlabs" | "inworld" | "yandex";
interface CompareRow {
  tone: Tone;
  provider: Provider;
  text: string;
  status: "pending" | "ready" | "failed" | "no_voice";
  updatedAt: string;
}
interface Comparison {
  defaultText: string;
  rows: CompareRow[];
}

const TONES: [Tone, string][] = [
  ["tsundere", "Мицуки"],
  ["yandere", "Аи"]
];
const PROVIDERS: [Provider, string][] = [
  ["elevenlabs", "ElevenLabs"],
  ["inworld", "Inworld"],
  ["yandex", "Яндекс"]
];
const STATUS_TEXT: Record<Exclude<CompareRow["status"], "ready">, string> = {
  pending: "записывается…",
  failed: "не записалось",
  no_voice: "голос не настроен"
};
const POLL_MS = 3_000;

/** Plays a recording through the API session (the audio route needs the owner's cookie). */
async function play(tone: Tone, provider: Provider) {
  const response = await fetch(apiUrl(`/admin/voice-compare/${tone}/${provider}`), {
    credentials: "include"
  });
  if (!response.ok) throw new Error("Записи нет");
  const url = URL.createObjectURL(await response.blob());
  const audio = new Audio(url);
  audio.addEventListener("ended", () => URL.revokeObjectURL(url));
  await audio.play();
}

export function VoiceCompare() {
  const { data, error, load } = useAdmin<Comparison>("/admin/voice-compare");
  const [text, setText] = useState("");
  const [notice, setNotice] = useState("");
  const touched = useRef(false);
  useEffect(() => {
    if (data && !touched.current) setText(data.rows[0]?.text ?? data.defaultText);
  }, [data]);
  // Reload while anything is still recording; stops by itself when all are done.
  const pending = data?.rows.some((row) => row.status === "pending") ?? false;
  useEffect(() => {
    if (!pending) return;
    const timer = setTimeout(() => void load(), POLL_MS);
    return () => clearTimeout(timer);
  }, [pending, data, load]);
  const row = (tone: Tone, provider: Provider) =>
    data?.rows.find((item) => item.tone === tone && item.provider === provider);
  return (
    <Card>
      <p className="label">СРАВНЕНИЕ ГОЛОСОВ</p>
      <h2>Одна фраза — три сервиса</h2>
      <p>
        Мицуки и Аи говорят одну фразу голосами ElevenLabs, Inworld и Яндекса. Запись тратит
        несколько десятков символов месячного лимита каждого сервиса; Piper не участвует.
      </p>
      <label className="field-label">
        Фраза
        <textarea
          value={text}
          maxLength={200}
          rows={2}
          onChange={(event) => {
            touched.current = true;
            setText(event.target.value);
          }}
        />
      </label>
      <button
        className="button primary"
        disabled={pending || !text.trim()}
        onClick={() =>
          void (async () => {
            setNotice("");
            try {
              await api("/admin/voice-compare", post({ text: text.trim() }));
              await load();
            } catch (reason) {
              setNotice(errorText(reason));
            }
          })()
        }
      >
        {pending ? "Записывается…" : "Записать"}
      </button>
      {(notice || error) && <p className="feedback">{notice || error}</p>}
      {data && data.rows.length > 0 && (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Героиня</th>
                {PROVIDERS.map(([, name]) => (
                  <th key={name}>{name}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {TONES.map(([tone, name]) => (
                <tr key={tone}>
                  <td>{name}</td>
                  {PROVIDERS.map(([provider]) => {
                    const item = row(tone, provider);
                    return (
                      <td key={provider}>
                        {item?.status === "ready" ? (
                          <button
                            className="mini"
                            onClick={() =>
                              void play(tone, provider).catch((reason: unknown) =>
                                setNotice(errorText(reason))
                              )
                            }
                          >
                            ▶ Слушать
                          </button>
                        ) : (
                          <small>{item ? STATUS_TEXT[item.status] : "—"}</small>
                        )}
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  );
}
