// The Telegram card: connect the streamer's chat with the bot for notifications and summaries.
import { useEffect, useState } from "react";

import { ask } from "../ask.js";
import { api, post } from "../api.js";
import { Card, errorText } from "../ui.js";
import { usePolling } from "./poll.js";

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
      .then((value) => {
        setStatus(value);
        return value;
      })
      .catch(() => undefined);
  // After "Подключить" the streamer presses Start in Telegram; the card notices by itself.
  const polling = usePolling(async () => Boolean((await load())?.connected));
  useEffect(() => {
    void load();
  }, []);
  if (!status?.configured) return null;
  const connect = async () => {
    setNotice("");
    try {
      const { url } = await api<{ url: string }>("/integrations/telegram/link", post());
      window.open(url, "_blank", "noopener");
      polling.start();
    } catch (reason) {
      setNotice(errorText(reason));
    }
  };
  const disconnect = async () => {
    if (
      !(await ask({
        title: "Отключить уведомления в Telegram?",
        confirm: "Отключить",
        danger: true
      }))
    )
      return;
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
      {polling.waiting && (
        <p className="quota-estimate" role="status">
          Ждём, пока вы нажмёте «Запустить» в Telegram… Окно не открылось?{" "}
          <button className="mini" onClick={() => void connect()}>
            Открыть ещё раз
          </button>
        </p>
      )}
      {polling.timedOut && !status.connected && (
        <p className="quota-estimate warn" role="status">
          Бот не ответил. Если вы нажали «Запустить», а подключения нет, значит, Telegram не
          достучался до сервера: владельцу стоит проверить вкладку «Платежи» в админке — там видно,
          что говорит Telegram.
        </p>
      )}
      {notice && <small className="hint below">{notice}</small>}
    </Card>
  );
}
