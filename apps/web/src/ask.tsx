// In-app confirmations instead of the browser's confirm/prompt/alert: those look foreign, block
// the page and cannot be styled. One <AskHost /> at the root shows whatever ask() requested.
import { useEffect, useState } from "react";

import { Dialog } from "./ui.js";

interface Request {
  title: string;
  text?: string | undefined;
  /** The confirming button; "OK" by default. */
  confirm?: string;
  /** Red confirming button for actions that are hard to undo. */
  danger?: boolean;
  /** A text field, e.g. the reason for a rejection; its value is the answer. */
  input?: { label: string; placeholder?: string; maxLength?: number };
  /** Only the confirming button, like alert(). */
  notice?: boolean;
}
interface Pending extends Request {
  resolve: (answer: string | null) => void;
}

let pending: Pending | null = null;
const listeners = new Set<(request: Pending | null) => void>();
const show = (next: Pending | null) => {
  pending = next;
  for (const listener of listeners) listener(next);
};

function open(request: Request): Promise<string | null> {
  // A new question replaces an unanswered one, which counts as cancelled.
  pending?.resolve(null);
  return new Promise((resolve) => show({ ...request, resolve }));
}

/** Resolves true when the user confirmed. */
export const ask = async (request: Omit<Request, "input" | "notice">) =>
  (await open(request)) !== null;

/** Resolves the entered text (possibly empty), or null when cancelled. */
export const askText = (request: Omit<Request, "notice"> & Required<Pick<Request, "input">>) =>
  open(request);

/** A message with one button. */
export const tell = async (title: string, text?: string) => {
  await open({ title, text, notice: true });
};

export function AskHost() {
  const [request, setRequest] = useState<Pending | null>(pending);
  const [value, setValue] = useState("");
  useEffect(() => {
    listeners.add(setRequest);
    return () => void listeners.delete(setRequest);
  }, []);
  useEffect(() => setValue(""), [request]);
  const answer = (result: string | null) => {
    if (!request) return;
    request.resolve(result);
    if (pending === request) show(null);
  };
  return (
    <Dialog open={Boolean(request)} title={request?.title ?? ""} onClose={() => answer(null)}>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          answer(value.trim());
        }}
      >
        {request?.text && <p>{request.text}</p>}
        {request?.input && (
          <label className="field-label">
            {request.input.label}
            <input
              autoFocus
              value={value}
              placeholder={request.input.placeholder}
              maxLength={request.input.maxLength}
              onChange={(event) => setValue(event.target.value)}
            />
          </label>
        )}
        <div className="row-actions">
          <button
            className={`button ${request?.danger ? "secondary danger" : "primary"}`}
            type="submit"
            autoFocus={!request?.input}
          >
            {request?.confirm ?? "OK"}
          </button>
          {!request?.notice && (
            <button className="button secondary" type="button" onClick={() => answer(null)}>
              Отмена
            </button>
          )}
        </div>
      </form>
    </Dialog>
  );
}
