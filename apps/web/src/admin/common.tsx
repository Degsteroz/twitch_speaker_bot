// Pieces shared by the back-office tabs.
import { useCallback, useEffect, useState } from "react";

import { api } from "../api.js";
import { errorText } from "../ui.js";

export interface AdminResult<T> {
  data: T | undefined;
  error: string;
  load: () => Promise<void>;
}

/** GET an admin endpoint; reloads when the path changes. */
export function useAdmin<T>(path: string): AdminResult<T> {
  const [data, setData] = useState<T>();
  const [error, setError] = useState("");
  const load = useCallback(async () => {
    setError("");
    try {
      setData(await api<T>(path));
    } catch (reason) {
      setError(errorText(reason));
    }
  }, [path]);
  useEffect(() => {
    void load();
  }, [load]);
  return { data, error, load };
}

/** A titled group of cards on a tab. */
export function Section({
  title,
  note,
  children
}: {
  title: string;
  note?: string;
  children: React.ReactNode;
}) {
  return (
    <section className="admin-section">
      <div className="admin-section-head">
        <h2>{title}</h2>
        {note && <p>{note}</p>}
      </div>
      {children}
    </section>
  );
}

// Models with known prices (packages/prompts); an unknown one is billed at the highest rate.
export const MODELS = [
  ["claude-opus-5-5", "Opus 5.5 — умный, дороже"],
  ["claude-sonnet-5-5", "Sonnet 5.5 — середина"],
  ["claude-haiku-5-5", "Haiku 5.5 — дешёвый и быстрый"],
  ["claude-fable-5-1", "Fable 5.1 — самый дорогой"]
] as const;

/** A model select that keeps an unknown stored model as its own option. */
export function ModelSelect({
  value,
  onChange,
  label
}: {
  value: string;
  onChange: (value: string) => void;
  label?: string;
}) {
  return (
    <select aria-label={label} value={value} onChange={(event) => onChange(event.target.value)}>
      {!MODELS.some(([id]) => id === value) && <option value={value}>{value}</option>}
      {MODELS.map(([id, name]) => (
        <option key={id} value={id}>
          {name}
        </option>
      ))}
    </select>
  );
}
