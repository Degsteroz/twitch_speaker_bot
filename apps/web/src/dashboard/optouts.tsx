// Viewers who wrote "!роаст-стоп": the bot leaves them alone; the streamer may clear an entry.
import { useEffect, useState } from "react";

import { ask } from "../ask.js";
import { api, del } from "../api.js";

export function OptOuts() {
  const [viewers, setViewers] = useState<{ viewerLogin: string }[]>();
  const load = () =>
    api<{ viewerLogin: string }[]>("/optouts")
      .then(setViewers)
      .catch(() => setViewers([]));
  useEffect(() => {
    void load();
  }, []);
  const remove = async (login: string) => {
    if (
      !(await ask({
        title: `Снова разрешить роасты для @${login}?`,
        text: "Обычно зритель сам пишет !роаст-старт.",
        confirm: "Разрешить"
      }))
    ) {
      return;
    }
    await api(`/optouts/${encodeURIComponent(login)}`, del());
    await load();
  };
  return (
    <fieldset>
      <legend>Зрители, которые попросили их не трогать</legend>
      <div className="tag-box">
        {viewers?.map(({ viewerLogin }) => (
          <span className="tag" key={viewerLogin}>
            @{viewerLogin}
            <button aria-label={`Убрать ${viewerLogin}`} onClick={() => void remove(viewerLogin)}>
              ×
            </button>
          </span>
        ))}
        {viewers?.length === 0 && <small>Пока никто.</small>}
      </div>
      <small className="hint below">
        Зритель пишет в чат <code>!роаст-стоп</code> — бот перестаёт отвечать на его сообщения, а
        его донаты и рейды подкалывают вас, а не его. <code>!роаст-старт</code> возвращает всё.
      </small>
    </fieldset>
  );
}
