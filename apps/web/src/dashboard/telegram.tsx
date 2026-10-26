// The Telegram card: connect the streamer's chat with the bot for notifications and summaries.
import { useEffect, useState } from "react";

import { api, post } from "../api.js";
import { Card, errorText } from "../ui.js";

interface TelegramStatus {
  configured: boolean;
  connected: boolean;
  username: string | null;
  bot: string | null;
}

export function TelegramCard() {
  const [status, setStatus] = useState<TelegramStatus>();
  const [notice, setNotice] = useState("");
  const load = () =>
    api<TelegramStatus>("/integrations/telegram")
      .then(setStatus)
      .catch(() => setStatus(undefined));
  useEffect(() => {
    void load();
  }, []);
  if (!status?.configured) return null;
  const connect = async () => {
    setNotice("");
    try {
      const { url } = await api<{ url: string }>("/integrations/telegram/link", post());
      window.open(url, "_blank", "noopener");
      setNotice("Нажмите «Запустить» в Telegram, потом обновите эту карточку.");
    } catch (reason) {
      setNotice(errorText(reason));
    }
  };
  const disconnect = async () => {
    if (!confirm("Отключить уведомления в Telegram?")) return;
    await api("/integrations/telegram/disconnect", post());
    await load();
  };
  return (
    <Card tour="telegram">
      <p className="label">TELEGRAM</p>
      <h2>Уведомления в Telegram</h2>
      <p>
        Бот {status.bot ? `@${status.bot}` : ""} напишет, когда квота почти кончится или Twitch
        откажет в подписке, и пришлёт итог после стрима: сколько роастов, кому доставалось чаще,
        лучший.
      </p>
      {status.connected ? (
        <div className="integration">
          <span>Подключено{status.username ? <strong> @{status.username}</strong> : null}</span>
          <button className="mini" onClick={() => void disconnect()}>
            Отключить
          </button>
        </div>
      ) : (
        <div className="auth-actions">
          <button className="button secondary" onClick={() => void connect()}>
            Подключить Telegram
          </button>
          <button className="mini" onClick={() => void load()}>
            Обновить
          </button>
        </div>
      )}
      {notice && <small className="hint below">{notice}</small>}
    </Card>
  );
}
