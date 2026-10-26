// The star on a played roast: "the best of the stream". It goes to the stream summary, and the
// owner may show it on the landing page (without the viewer's name).
import { useState } from "react";

import { api, post } from "../api.js";

export function FavoriteButton({
  id,
  favorite,
  onChange
}: {
  id: string;
  favorite: boolean;
  onChange: () => void;
}) {
  const [busy, setBusy] = useState(false);
  return (
    <button
      type="button"
      className={`favorite ${favorite ? "on" : ""}`}
      aria-pressed={favorite}
      disabled={busy}
      title={
        favorite
          ? "Убрать из лучших"
          : "В лучшие: попадёт в итог стрима, может появиться на сайте RoastBot без ника зрителя"
      }
      onClick={() => {
        setBusy(true);
        void api(`/roasts/${id}/favorite`, post({ favorite: !favorite }))
          .then(onChange)
          .finally(() => setBusy(false));
      }}
    >
      {favorite ? "★" : "☆"}
    </button>
  );
}
