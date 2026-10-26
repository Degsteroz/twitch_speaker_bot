// What Telegram says about the bot's webhook: if the bot is silent, the reason is here.
import { useState } from "react";

import { api, post } from "../api.js";
import { Card, date, errorText } from "../ui.js";
import { useAdmin } from "./common.js";

interface WebhookStatus {
  configured: boolean;
  expected?: string;
  url?: string | null;
  pending?: number;
  lastError?: string | null;
  lastErrorAt?: string | null;
  ok?: boolean;
}

export function TelegramStatus() {
  const { data, error, load } = useAdmin<WebhookStatus>("/admin/telegram");
  const [notice, setNotice] = useState("");
  const register = async () => {
    try {
      await api("/admin/telegram/webhook", post());
      setNotice("Вебхук зарегистрирован заново");
      await load();
    } catch (reason) {
      setNotice(errorText(reason));
    }
  };
  return (
    <Card>
      <p className="label">TELEGRAM-БОТ</p>
      <h2>
        {!data
          ? "Проверяем…"
          : !data.configured
            ? "Бот не настроен"
            : data.ok
              ? "Вебхук работает"
              : "Telegram не может доставить сообщения"}
      </h2>
      {error && <p className="feedback">{error}</p>}
      {data && !data.configured && (
        <p>
          В <code>deploy/.env</code> нужны <code>TELEGRAM_BOT_TOKEN</code>,{" "}
          <code>TELEGRAM_BOT_USERNAME</code> и <code>TELEGRAM_WEBHOOK_SECRET</code>, затем
          перезапуск API.
        </p>
      )}
      {data?.configured && (
        <ul className="twitch-links">
          <li className={data.url === data.expected ? "good" : "bad"}>
            {data.url === data.expected ? "✓" : "✗"} Адрес у Telegram: {data.url ?? "не задан"}
            {data.url !== data.expected && <small> — ожидается {data.expected}</small>}
          </li>
          <li className={data.lastError ? "bad" : "good"}>
            {data.lastError ? "✗" : "✓"} Последняя ошибка доставки:{" "}
            {data.lastError ? `${data.lastError} (${date(data.lastErrorAt)})` : "нет"}
          </li>
          <li className={(data.pending ?? 0) > 0 ? "bad" : "good"}>
            {(data.pending ?? 0) > 0 ? "✗" : "✓"} Ждут доставки: {data.pending ?? 0}
          </li>
        </ul>
      )}
      {data?.configured && (
        <div className="group-actions">
          <button className="button secondary" onClick={() => void register()}>
            Зарегистрировать вебхук заново
          </button>
          <button className="mini" onClick={() => void load()}>
            Обновить
          </button>
          {notice && <span className="notice">{notice}</span>}
        </div>
      )}
    </Card>
  );
}
