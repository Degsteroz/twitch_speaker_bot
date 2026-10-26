// The OBS overlay card: the secret link and how to add it.
import { useState } from "react";

import { ask, tell } from "../ask.js";
import { api, overlayUrl, post } from "../api.js";
import { Card, errorText } from "../ui.js";

export function OverlaySetup({
  token,
  branding,
  onRotate
}: {
  token: string;
  branding: boolean;
  onRotate: (token: string) => void;
}) {
  const url = overlayUrl(token);
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    await navigator.clipboard.writeText(url);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1800);
  };
  const rotate = async () => {
    if (
      !(await ask({
        title: "Перевыпустить ссылку оверлея?",
        text: "Старая ссылка перестанет работать. В OBS нужно будет вставить новую.",
        confirm: "Перевыпустить",
        danger: true
      }))
    )
      return;
    const result = await api<{ overlayToken: string }>("/me/overlay-token/rotate", post());
    onRotate(result.overlayToken);
  };
  return (
    <Card tour="overlay">
      <p className="label">ОВЕРЛЕЙ OBS</p>
      <h2>Покажите роаст в эфире</h2>
      <div className="copy-row">
        <input aria-label="Ссылка оверлея" readOnly value={url} />
        <button onClick={() => void copy()}>{copied ? "Готово" : "Копировать"}</button>
      </div>
      <ol className="steps">
        <li>
          <b>1</b>
          <span>
            В OBS добавьте источник <strong>«Браузер»</strong>.
          </span>
        </li>
        <li>
          <b>2</b>
          <span>
            Вставьте ссылку выше. Размер: <strong>1920 × 1080</strong>.
          </span>
        </li>
        <li>
          <b>3</b>
          <span>
            Включите <strong>«Управлять звуком через OBS»</strong> и направьте звук в нужную
            дорожку.
          </span>
        </li>
      </ol>
      <p className="secret">
        Кликать по оверлею не нужно: в OBS звук включается сам. Не показывайте ссылку на стриме, в
        ней секретный ключ.
      </p>
      {branding && (
        <small className="hint below">
          На бесплатном тарифе под роастом мелко видна подпись {location.hostname}.
        </small>
      )}
      <button
        className="mini danger"
        onClick={() =>
          void rotate().catch((reason: unknown) => tell("Не получилось", errorText(reason)))
        }
      >
        Перевыпустить ссылку
      </button>
    </Card>
  );
}
