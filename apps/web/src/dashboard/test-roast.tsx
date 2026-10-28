// The test card: an event simulator that never spends the stream quota.
import { useEffect, useRef, useState, type SyntheticEvent } from "react";

import {
  api,
  post,
  ROAST_STATUS_TEXT,
  SIMULATED_KINDS,
  SKIP_REASON_TEXT,
  type RoastResult,
  type SimulatedKind,
  type Status
} from "../api.js";
import { Card, errorText, Field, Link } from "../ui.js";

export function TestRoast({
  tests,
  onFinished
}: {
  tests: Status["tests"];
  onFinished: () => void;
}) {
  const [kind, setKind] = useState<SimulatedKind>("plain");
  const [viewerLogin, setViewer] = useState("test_viewer");
  const [inputText, setText] = useState("");
  const [amount, setAmount] = useState(String(SIMULATED_KINDS.plain.amount?.value ?? ""));
  const [result, setResult] = useState<{ text: string; roastId?: string }>();
  const [busy, setBusy] = useState(false);
  const cancelled = useRef(false);
  // StrictMode mounts twice in dev: reset the flag on every mount, not only on the first.
  useEffect(() => {
    cancelled.current = false;
    return () => void (cancelled.current = true);
  }, []);
  const info = SIMULATED_KINDS[kind];

  const poll = async (roastId: string) => {
    const started = Date.now();
    while (!cancelled.current && Date.now() - started < 30_000) {
      await new Promise((resolve) => window.setTimeout(resolve, 700));
      const roast = await api<RoastResult>(`/roasts/${roastId}`);
      if (roast.status === "queued") continue;
      const seconds =
        roast.latencyMs === null ? "" : ` за ${(roast.latencyMs / 1000).toFixed(1)} с`;
      const reason = roast.error ? ` (${SKIP_REASON_TEXT[roast.error] ?? roast.error})` : "";
      const text = roast.outputText ? ` — «${roast.outputText}»` : "";
      const overlay =
        roast.overlayStatus === "delivered"
          ? " Оверлей получил событие."
          : roast.overlayStatus === "pending"
            ? " Оверлей не подключён: откройте ссылку в OBS в течение 2 минут."
            : "";
      return `${ROAST_STATUS_TEXT[roast.status]}${seconds}${reason}${text}.${overlay}`;
    }
    return "Воркер не ответил за 30 секунд — проверьте, что сервис worker запущен.";
  };

  const submit = async (event: SyntheticEvent<HTMLFormElement>) => {
    event.preventDefault();
    setBusy(true);
    setResult(undefined);
    try {
      const value = await api<{ roastId: string; status: string }>(
        "/roasts/test",
        post({
          kind,
          viewerLogin,
          inputText: info.text ? inputText || (info.placeholder ?? "") : "",
          ...(info.amount ? { amount: Math.max(0, Math.round(Number(amount) || 0)) } : {})
        })
      );
      setResult({ text: "В очереди…", roastId: value.roastId });
      setResult({ text: await poll(value.roastId), roastId: value.roastId });
      onFinished();
    } catch (reason) {
      setResult({ text: `Ошибка: ${errorText(reason)}` });
    } finally {
      setBusy(false);
    }
  };
  return (
    <Card tour="test">
      <p className="label">ТЕСТ</p>
      <h2>Проверьте до эфира</h2>
      <p>
        Изобразите событие — награду, слово в чате, донат, рейд — и услышите, как героиня ответит на
        стриме. Тест проходит тот же путь: генерация, проверка, озвучка, оверлей. Паузы на него не
        действуют, квоту эфира он не тратит.
      </p>
      <form onSubmit={(event) => void submit(event)}>
        <label className="field-label">
          Что произошло
          <select
            value={kind}
            onChange={(event) => {
              const next = event.target.value as SimulatedKind;
              setKind(next);
              setAmount(String(SIMULATED_KINDS[next].amount?.value ?? ""));
            }}
          >
            {Object.entries(SIMULATED_KINDS).map(([key, value]) => (
              <option key={key} value={key}>
                {value.label}
              </option>
            ))}
          </select>
        </label>
        <Field label={info.who} value={viewerLogin} maxLength={64} onChange={setViewer} />
        {info.amount && (
          <Field
            label={info.amount.label}
            type="number"
            min={0}
            max={1_000_000}
            value={amount}
            onChange={setAmount}
          />
        )}
        {info.text && (
          <label className="field-label">
            Текст зрителя
            <textarea
              value={inputText}
              maxLength={2000}
              onChange={(event) => setText(event.target.value)}
              placeholder={info.placeholder ? `Например: ${info.placeholder}` : "Можно пусто"}
            />
          </label>
        )}
        <button
          className="button secondary"
          disabled={busy || !viewerLogin.trim() || tests?.remaining === 0}
        >
          {busy ? "Генерируем…" : "Запустить тест"}
        </button>
        <small className="hint below">
          {!tests
            ? "Тесты без ограничений."
            : tests.remaining === 0
              ? `Тесты на сегодня закончились (${String(tests.limit)} в день). Завтра будут новые.`
              : `Сегодня осталось ${String(tests.remaining)} из ${String(tests.limit)} тестов.`}
        </small>
        {result && (
          <p className="feedback" role="status">
            {result.text}
            {result.roastId && result.text !== "В очереди…" && (
              <>
                {" "}
                <Link href={`/roasts/${result.roastId}`}>Подробнее</Link>
              </>
            )}
          </p>
        )}
      </form>
    </Card>
  );
}
