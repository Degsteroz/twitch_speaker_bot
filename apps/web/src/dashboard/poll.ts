import { useEffect, useRef, useState } from "react";

/**
 * Runs `check` every few seconds until it returns true or the time is up. `start()` begins,
 * `waiting` tells the card to show "waiting…". Used after the streamer leaves for Telegram:
 * linking the chat or paying happens there, and the card catches up on its own.
 */
export function usePolling(check: () => Promise<boolean>, intervalMs = 3_000, maxMs = 180_000) {
  const [waiting, setWaiting] = useState(false);
  const [timedOut, setTimedOut] = useState(false);
  const checkRef = useRef(check);
  checkRef.current = check;
  useEffect(() => {
    if (!waiting) return;
    const started = Date.now();
    let busy = false;
    const timer = window.setInterval(() => {
      if (busy) return;
      if (Date.now() - started > maxMs) {
        setWaiting(false);
        setTimedOut(true);
        return;
      }
      busy = true;
      checkRef
        .current()
        .then((done) => done && setWaiting(false))
        .catch(() => undefined)
        .finally(() => (busy = false));
    }, intervalMs);
    return () => window.clearInterval(timer);
  }, [waiting, intervalMs, maxMs]);
  return {
    waiting,
    timedOut,
    start: () => {
      setTimedOut(false);
      setWaiting(true);
    },
    stop: () => setWaiting(false)
  };
}
