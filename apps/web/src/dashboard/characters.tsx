// Premium characters: the streamer's own heroines (name, temperament, voice, picture) and the shop
// of heroines other streamers offered and the owner approved. Choosing one applies at once, like
// the power switch, independent of the form's save bar.
import { useCallback, useEffect, useRef, useState } from "react";

import {
  api,
  apiUrl,
  ARCHETYPE_TEXT,
  CHARACTER_IMAGE_TYPES,
  CHARACTER_STATUS_TEXT,
  del,
  MAX_CHARACTER_UPLOAD_BYTES,
  post,
  put,
  uploadCharacterImage,
  voiceSampleUrl,
  type Archetype,
  type CharactersResponse,
  type CharacterView,
  type VoiceOption
} from "../api.js";
import { Card, errorText, Field } from "../ui.js";

const ARCHETYPES = Object.keys(ARCHETYPE_TEXT) as Archetype[];

interface Draft {
  id: string | null;
  name: string;
  archetype: Archetype;
  voiceId: string | null;
}
const emptyDraft = (voices: VoiceOption[]): Draft => ({
  id: null,
  name: "",
  archetype: "tsundere",
  voiceId: voices[0]?.id ?? null
});

/** One sample at a time: a new click stops the previous one. */
function useSample() {
  const audio = useRef<HTMLAudioElement | null>(null);
  useEffect(() => () => audio.current?.pause(), []);
  return (voiceId: string) => {
    audio.current?.pause();
    audio.current = new Audio(voiceSampleUrl(voiceId));
    void audio.current.play().catch(() => undefined);
  };
}

function Portrait({ character }: { character: CharacterView }) {
  return character.imagePath ? (
    <img className="character-portrait" src={apiUrl(character.imagePath)} alt={character.name} />
  ) : (
    <span className="character-portrait empty">нет картинки</span>
  );
}

export function CustomCharacters({
  onActiveName
}: {
  onActiveName: (name: string | null) => void;
}) {
  const [data, setData] = useState<CharactersResponse>();
  const [notice, setNotice] = useState("");
  const [draft, setDraft] = useState<Draft | null>(null);
  const [nameOverride, setNameOverride] = useState("");
  const [busy, setBusy] = useState(false);
  const playSample = useSample();

  const load = useCallback(async () => {
    try {
      const next = await api<CharactersResponse>("/characters");
      setData(next);
      setNameOverride(next.selected.characterName ?? "");
    } catch (reason) {
      setNotice(errorText(reason));
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load]);

  const all = data ? [...data.own, ...data.shop] : [];
  const active = all.find((item) => item.id === data?.selected.characterId);
  const activeName = data?.allowed && active ? (data.selected.characterName ?? active.name) : null;
  useEffect(() => onActiveName(activeName), [activeName, onActiveName]);

  const run = async (action: () => Promise<unknown>, done?: string) => {
    setBusy(true);
    setNotice("");
    try {
      await action();
      await load();
      if (done) setNotice(done);
    } catch (reason) {
      setNotice(errorText(reason));
    } finally {
      setBusy(false);
    }
  };
  const select = (characterId: string | null, characterName: string | null = null) =>
    run(
      () => api("/settings/character", put({ characterId, characterName })),
      characterId ? "Героиня выбрана, следующий роаст — её голосом" : "Вернули встроенную героиню"
    );
  const saveDraft = (value: Draft) =>
    run(async () => {
      const body = { name: value.name, archetype: value.archetype, voiceId: value.voiceId };
      if (value.id)
        await api(`/characters/${value.id}`, { method: "PATCH", body: JSON.stringify(body) });
      else await api("/characters", post(body));
      setDraft(null);
    }, "Сохранено. Не забудьте картинку");
  const upload = (character: CharacterView, file: File | undefined) => {
    if (!file) return;
    if (!CHARACTER_IMAGE_TYPES.includes(file.type)) {
      setNotice("Подойдёт PNG, JPEG или WebP");
      return;
    }
    if (file.size > MAX_CHARACTER_UPLOAD_BYTES) {
      setNotice("Файл больше 4 МБ");
      return;
    }
    void run(() => uploadCharacterImage(character.id, file), "Картинка загружена");
  };

  if (!data) {
    return (
      <Card tour="custom-character">
        <p className="label">СВОЯ ГЕРОИНЯ · PREMIUM</p>
        <h2>Своя героиня</h2>
        <p>{notice || "Загружаем…"}</p>
      </Card>
    );
  }
  if (!data.allowed) {
    return (
      <Card tour="custom-character">
        <p className="label">СВОЯ ГЕРОИНЯ · PREMIUM</p>
        <h2>Своя героиня</h2>
        <p>
          На тарифе Premium можно загрузить свою вайфу, дать ей имя, голос и характер — или взять
          готовую героиню из магазина. Она отвечает в чате на своё имя.
        </p>
        {data.shop.length > 0 && (
          <small className="hint below">В магазине уже {data.shop.length} героинь.</small>
        )}
      </Card>
    );
  }

  const tile = (character: CharacterView) => {
    const selected = character.id === data.selected.characterId;
    return (
      <article className={`character-tile ${selected ? "active" : ""}`} key={character.id}>
        <Portrait character={character} />
        <div className="character-info">
          <strong>{character.name}</strong>
          <small className="archetype">
            {ARCHETYPE_TEXT[character.archetype].title} — {ARCHETYPE_TEXT[character.archetype].desc}
          </small>
          <small>
            {character.voiceLabel ? `голос «${character.voiceLabel}»` : "стандартный голос"}
            {character.own
              ? ` · ${CHARACTER_STATUS_TEXT[character.status]}`
              : ` · от #${character.author}`}
          </small>
          {character.own && character.status === "rejected" && character.reviewNote && (
            <small className="hint">Почему: {character.reviewNote}</small>
          )}
          <div className="character-actions">
            {character.voiceId && (
              <button className="mini" type="button" onClick={() => playSample(character.voiceId!)}>
                ▶ Голос
              </button>
            )}
            {selected ? (
              <span className="mini primary">На стриме</span>
            ) : (
              <button
                className="mini primary"
                type="button"
                disabled={busy || !character.imagePath}
                onClick={() => void select(character.id)}
              >
                Выбрать
              </button>
            )}
            {character.own && character.status !== "published" && (
              <>
                <button
                  className="mini"
                  type="button"
                  disabled={busy}
                  onClick={() =>
                    setDraft({
                      id: character.id,
                      name: character.name,
                      archetype: character.archetype,
                      voiceId: character.voiceId
                    })
                  }
                >
                  Изменить
                </button>
                <label className="mini file-button">
                  {character.imagePath ? "Другая картинка" : "Загрузить картинку"}
                  <input
                    type="file"
                    accept={CHARACTER_IMAGE_TYPES.join(",")}
                    disabled={busy}
                    onChange={(event) => upload(character, event.target.files?.[0])}
                  />
                </label>
              </>
            )}
            {character.own &&
              (character.status === "private" || character.status === "rejected") &&
              character.imagePath && (
                <button
                  className="mini"
                  type="button"
                  disabled={busy}
                  onClick={() =>
                    void run(
                      () => api(`/characters/${character.id}/publish`, post()),
                      "Отправили на проверку. После одобрения героиня появится в магазине"
                    )
                  }
                >
                  В магазин
                </button>
              )}
            {character.own &&
              (character.status === "published" || character.status === "pending") && (
                <button
                  className="mini"
                  type="button"
                  disabled={busy}
                  onClick={() =>
                    void run(
                      () => api(`/characters/${character.id}/unpublish`, post()),
                      "Сняли с магазина"
                    )
                  }
                >
                  Убрать из магазина
                </button>
              )}
            {character.own && (
              <button
                className="mini"
                type="button"
                disabled={busy}
                onClick={() => {
                  if (
                    confirm(
                      `Удалить «${character.name}»? Каналы, которые её выбрали, вернутся к встроенной.`
                    )
                  ) {
                    void run(() => api(`/characters/${character.id}`, del()), "Удалено");
                  }
                }}
              >
                Удалить
              </button>
            )}
          </div>
        </div>
      </article>
    );
  };

  return (
    <Card tour="custom-character">
      <p className="label">СВОЯ ГЕРОИНЯ · PREMIUM</p>
      <h2>Своя героиня</h2>
      <p>
        {active ? (
          <>
            Сейчас на стриме: <strong>{activeName}</strong>.{" "}
            <button
              className="mini"
              type="button"
              disabled={busy}
              onClick={() => void select(null)}
            >
              Вернуть встроенную
            </button>
          </>
        ) : (
          "Сейчас на стриме встроенная героиня из карточки «Характер»."
        )}
      </p>
      {active && (
        <div className="character-rename">
          <Field
            label="Имя на вашем канале"
            placeholder={active.name}
            maxLength={20}
            value={nameOverride}
            onChange={setNameOverride}
          />
          <button
            className="mini"
            type="button"
            disabled={busy || nameOverride.trim() === (data.selected.characterName ?? "")}
            onClick={() => void select(active.id, nameOverride.trim() || null)}
          >
            Сохранить имя
          </button>
          <small className="hint below">
            Так она представляется и на это имя откликается в чате, если включить «Откликаться на
            имя» в карточке «Чат». Пусто — её собственное имя.
          </small>
        </div>
      )}
      {notice && (
        <p className="feedback" role="status">
          {notice}
        </p>
      )}

      <h3>
        Мои героини · {data.own.length} из {data.maxOwn}
      </h3>
      <div className="character-grid">{data.own.map(tile)}</div>
      {draft ? (
        <CharacterForm
          draft={draft}
          voices={data.voices}
          busy={busy}
          onPlay={playSample}
          onCancel={() => setDraft(null)}
          onSave={(value) => void saveDraft(value)}
        />
      ) : (
        data.own.length < data.maxOwn && (
          <button
            className="button secondary"
            type="button"
            onClick={() => setDraft(emptyDraft(data.voices))}
          >
            Создать героиню
          </button>
        )
      )}
      <small className="hint below">
        Картинка — портрет в полный рост, лучше PNG с прозрачным фоном, до 4 МБ. Своей героиней
        можно пользоваться сразу; в магазин для других стримеров она попадает после проверки.
      </small>

      <h3>Магазин</h3>
      {data.shop.length ? (
        <div className="character-grid">{data.shop.map(tile)}</div>
      ) : (
        <p className="muted">
          Пока пусто. Отправьте свою героиню в магазин — она будет здесь первой.
        </p>
      )}
    </Card>
  );
}

function CharacterForm({
  draft,
  voices,
  busy,
  onPlay,
  onCancel,
  onSave
}: {
  draft: Draft;
  voices: VoiceOption[];
  busy: boolean;
  onPlay: (voiceId: string) => void;
  onCancel: () => void;
  onSave: (value: Draft) => void;
}) {
  const [value, setValue] = useState(draft);
  return (
    <form
      className="character-form"
      onSubmit={(event) => {
        event.preventDefault();
        onSave(value);
      }}
    >
      <Field
        label="Имя"
        placeholder="Например: Кэт"
        maxLength={20}
        required
        value={value.name}
        onChange={(name) => setValue({ ...value, name })}
      />
      <fieldset>
        <legend>Характер</legend>
        <div className="choice-grid">
          {ARCHETYPES.map((archetype) => (
            <button
              key={archetype}
              type="button"
              className={`choice ${value.archetype === archetype ? "active" : ""}`}
              aria-pressed={value.archetype === archetype}
              onClick={() => setValue({ ...value, archetype })}
            >
              <i>✦</i>
              <span>
                <strong>{ARCHETYPE_TEXT[archetype].title}</strong>
                <small>{ARCHETYPE_TEXT[archetype].desc}</small>
              </span>
              <b>✓</b>
            </button>
          ))}
        </div>
      </fieldset>
      <fieldset>
        <legend>Голос</legend>
        {voices.length === 0 && (
          <small className="hint">
            Голоса ещё не добавлены — героиня будет говорить стандартным голосом своего характера.
          </small>
        )}
        {voices.map((voice) => (
          <label className="check voice-option" key={voice.id}>
            <input
              type="radio"
              name="voice"
              checked={value.voiceId === voice.id}
              onChange={() => setValue({ ...value, voiceId: voice.id })}
            />
            <span>
              {voice.label} {voice.description && <small>— {voice.description}</small>}
            </span>
            {voice.sampleReady && (
              <button className="mini" type="button" onClick={() => onPlay(voice.id)}>
                ▶
              </button>
            )}
          </label>
        ))}
      </fieldset>
      <div className="character-actions">
        <button className="button primary" type="submit" disabled={busy || !value.name.trim()}>
          {draft.id ? "Сохранить" : "Создать"}
        </button>
        <button className="button secondary" type="button" onClick={onCancel}>
          Отмена
        </button>
      </div>
    </form>
  );
}
