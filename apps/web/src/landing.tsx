// The public landing page with the live demo of Ai.
import { useEffect, useRef, useState, type SyntheticEvent } from "react";

import { api, authUrl, CHARACTER_NAMES, post } from "./api.js";
import tsundereArt from "./assets/tsundere.webp";
import yandereArt from "./assets/yandere.webp";
import { errorText, Logo } from "./ui.js";

export const AUTH_ERRORS: Record<string, string> = {
  access_denied: "Вход отменён в Twitch.",
  invalid_oauth_state: "Сессия входа устарела. Попробуйте ещё раз.",
  twitch_unavailable: "Twitch не ответил. Попробуйте позже."
};

export const LANDING_TRIGGERS: [string, string][] = [
  ["Награда за баллы", "читает текст зрителя и отвечает по смыслу"],
  ["Слова-триггеры", "«слил», «гг», «лаг» — с шансом, который вы зададите"],
  ["!роаст", "зритель сам зовёт её в чат — на тарифах Basic и Premium"],
  ["Битсы", "от порога, по тексту cheer"],
  ["Подписки", "новые и ресабы, со стажем"],
  ["Подарочные сабы", "щедрому дарителю — отдельный привет"],
  ["Рейды", "встречает гостей с другого канала"],
  ["Фоллоу", "изредка, чтобы не заспамить"],
  ["Прогнозы", "утешает проигравших. Или нет"],
  ["Реклама", "подкалывает стримера, пока идёт пауза"],
  ["DonationAlerts", "жарит донатера по тексту доната"]
];

interface ShowcaseRoast {
  id: string;
  text: string;
  tone: "tsundere" | "yandere";
  /** A premium character's name; null for Mitsuki and Ai. */
  characterName: string | null;
  channel: string;
}

/** Real roasts the streamers starred and the owner approved; hidden while there are none. */
function Showcase() {
  const [roasts, setRoasts] = useState<ShowcaseRoast[]>([]);
  useEffect(() => {
    api<ShowcaseRoast[]>("/showcase")
      .then(setRoasts)
      .catch(() => setRoasts([]));
  }, []);
  if (!roasts.length) return null;
  return (
    <section className="landing-section">
      <p className="eyebrow">С НАСТОЯЩИХ СТРИМОВ</p>
      <h2>Что она уже говорила</h2>
      <div className="showcase-grid">
        {roasts.map((roast) => (
          <article className="card" key={roast.id}>
            <blockquote>«{roast.text}»</blockquote>
            <small>
              {roast.characterName ?? CHARACTER_NAMES[roast.tone]} на канале{" "}
              <a href={`https://twitch.tv/${roast.channel}`} target="_blank" rel="noreferrer">
                {roast.channel}
              </a>
            </small>
          </article>
        ))}
      </div>
    </section>
  );
}

export const DEMO_EXAMPLES = [
  "стример опять слил катку",
  "Аи, ты вообще умеешь шутить?",
  "я лучше всех в чате играю"
];

/** "Write what a viewer would say": Ai answers right on the landing page, a few times a day. */
export function LandingDemo() {
  const [info, setInfo] = useState<{ enabled: boolean; remaining: number; perDay: number }>();
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [answer, setAnswer] = useState<{ text: string; audioUrl: string | null }>();
  const [feedback, setFeedback] = useState("");
  const cancelled = useRef(false);
  useEffect(() => {
    cancelled.current = false;
    api<{ enabled: boolean; remaining: number; perDay: number }>("/demo")
      .then(setInfo)
      .catch(() => setInfo({ enabled: false, remaining: 0, perDay: 0 }));
    return () => void (cancelled.current = true);
  }, []);
  if (!info?.enabled) return null;

  const submit = async (event: SyntheticEvent<HTMLFormElement>) => {
    event.preventDefault();
    setBusy(true);
    setFeedback("");
    setAnswer(undefined);
    try {
      const { id } = await api<{ id: string }>("/demo", post({ text }));
      setInfo({ ...info, remaining: Math.max(0, info.remaining - 1) });
      const started = Date.now();
      while (!cancelled.current && Date.now() - started < 25_000) {
        await new Promise((resolve) => window.setTimeout(resolve, 800));
        const result = await api<{ status: string; text: string | null; audioUrl: string | null }>(
          `/demo/${id}`
        );
        if (result.status === "queued") continue;
        if (result.text) {
          setAnswer({ text: result.text, audioUrl: result.audioUrl });
          // Play right away: the click on the button counts as the user's gesture.
          if (result.audioUrl) void new Audio(result.audioUrl).play().catch(() => undefined);
        } else if (result.status === "blocked") {
          setFeedback("Аи сделала вид, что не расслышала. Попробуйте сказать иначе.");
        } else {
          setFeedback("Аи сейчас занята. Попробуйте чуть позже.");
        }
        return;
      }
      setFeedback("Аи задумалась слишком надолго. Попробуйте ещё раз.");
    } catch (reason) {
      setFeedback(errorText(reason));
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="landing-section landing-demo">
      <p className="eyebrow">ПОПРОБУЙТЕ</p>
      <h2>Напишите, что сказал бы зритель</h2>
      <p className="section-lead">
        Аи ответит так же, как ответила бы на стриме. Без входа, {info.perDay} раза в день.
      </p>
      <form onSubmit={(event) => void submit(event)}>
        <textarea
          aria-label="Сообщение зрителя"
          value={text}
          maxLength={200}
          placeholder={`Например: ${DEMO_EXAMPLES[0]!}`}
          onChange={(event) => setText(event.target.value)}
        />
        <div className="demo-examples">
          {DEMO_EXAMPLES.map((example) => (
            <button type="button" className="mini" key={example} onClick={() => setText(example)}>
              {example}
            </button>
          ))}
        </div>
        <button className="button primary" disabled={busy || !text.trim() || info.remaining === 0}>
          {busy ? "Аи думает…" : "Спросить Аи"}
        </button>
        <small className="hint below">
          {info.remaining === 0
            ? "На сегодня ответы закончились. Возвращайтесь завтра — или подключите бота к своему каналу."
            : `Осталось ответов сегодня: ${String(info.remaining)}.`}
        </small>
      </form>
      {feedback && (
        <p className="feedback" role="status">
          {feedback}
        </p>
      )}
      {answer && (
        <figure className="demo-answer">
          <img src={yandereArt} alt="" />
          <figcaption>
            <span className="live-dot" /> Аи
            <blockquote>«{answer.text}»</blockquote>
            {answer.audioUrl && <audio controls src={answer.audioUrl} />}
          </figcaption>
        </figure>
      )}
    </section>
  );
}

export function Landing() {
  const authError = new URLSearchParams(location.search).get("auth_error");
  const login = (
    <a className="button primary big" href={authUrl}>
      Войти через Twitch <span aria-hidden>↗</span>
    </a>
  );
  return (
    <main className="landing">
      <nav className="landing-nav">
        <span className="brand">
          <Logo />
          <span>RoastBot</span>
        </span>
        <a className="mini" href={authUrl}>
          Войти
        </a>
      </nav>

      <section className="hero">
        <div>
          <p className="eyebrow">ГОЛОСОВОЙ AI-РОАСТ ДЛЯ TWITCH</p>
          <h1>
            Чат сказал.
            <br />
            <em>RoastBot ответил.</em>
          </h1>
          <p className="lead">
            Бот с характером слушает чат, награды, донаты и события канала, придумывает короткую
            колкость и произносит её в эфире — голосом и с персонажем на экране.
          </p>
          {authError && (
            <p className="feedback" role="alert">
              {AUTH_ERRORS[authError] ?? `Вход не удался: ${authError}`}
            </p>
          )}
          {login}
          <p className="fine">
            Только чтение: награды, битсы, подписки и события канала · новые каналы подключаются
            после одобрения
          </p>
        </div>
        <figure className="stage" aria-label="Так роаст выглядит на стриме">
          <img src={yandereArt} alt="Аи — яндэрэ, одна из двух героинь бота" />
          <figcaption className="demo-card">
            <span className="live-dot" /> LIVE ROAST
            <blockquote>
              «@viewer, опять слил катку? Ничего… Я запомнила, кто тебе мешал. Всех до одного.»
            </blockquote>
            <small>Аи · яндэрэ · 7 сек</small>
          </figcaption>
        </figure>
      </section>

      <section className="landing-section">
        <p className="eyebrow">КАК ЭТО РАБОТАЕТ</p>
        <h2>Три шага от сообщения до эфира</h2>
        <ol className="flow">
          <li>
            <b>1</b>
            <h3>Что-то происходит</h3>
            <p>
              Зритель активирует награду с текстом, в чате звучит слово-триггер, приходит донат,
              рейд или подписка.
            </p>
          </li>
          <li>
            <b>2</b>
            <h3>Она понимает, что произошло</h3>
            <p>
              Модель Claude читает сообщение и событие и отвечает по смыслу — одной-двумя фразами в
              характере героини. Перед эфиром ответ проходит стоп-лист и отдельную проверку.
            </p>
          </li>
          <li>
            <b>3</b>
            <h3>Персонаж говорит</h3>
            <p>
              Картинка с репликой появляется в OBS и звучит голосом героини. Стримеру ничего
              нажимать не нужно.
            </p>
          </li>
        </ol>
      </section>

      <section className="landing-section">
        <p className="eyebrow">ПЕРСОНАЖИ</p>
        <h2>Кто сегодня будет вас жарить?</h2>
        <div className="heroines">
          <article>
            <img src={tsundereArt} alt="Мицуки" loading="lazy" />
            <div>
              <h3>
                Мицуки <small>цундэрэ</small>
              </h3>
              <p>Колется, фыркает и делает вид, что ей всё равно. Проговаривается.</p>
              <blockquote>
                «Я не смотрю твой стрим! Просто вкладка случайно открыта… Третий час.»
              </blockquote>
            </div>
          </article>
          <article>
            <img src={yandereArt} alt="Аи" loading="lazy" />
            <div>
              <h3>
                Аи <small>яндэрэ</small>
              </h3>
              <p>Ласковая, внимательная и слегка пугающая. Помнит всё.</p>
              <blockquote>
                «Ты так мило промахиваешься… Не волнуйся, я всегда рядом. Всегда.»
              </blockquote>
            </div>
          </article>
        </div>
        <p className="section-note">
          У каждой свой голос. Остроту выбираете вы: от лёгкой иронии до «без пощады».
        </p>
      </section>

      <LandingDemo />
      <Showcase />

      <section className="landing-section">
        <p className="eyebrow">ПО СМЫСЛУ</p>
        <h2>Кого жарить, решаете вы. Или она</h2>
        <p className="section-lead">
          Героиня понимает, о чём сообщение. А переключатель решает, кому достанется: автору,
          стримеру или на её усмотрение. Вот одно и то же сообщение в трёх режимах.
        </p>
        <p className="viewer-line wide">«Стример стреляет из лука хуже, чем моя бабушка»</p>
        <div className="verdict-cards">
          <article>
            <b className="refuse">Автора</b>
            <p>«Твоя бабушка хотя бы целится. А ты только комментируешь.»</p>
          </article>
          <article>
            <b className="mixed">На усмотрение Аи</b>
            <p>«Бабушка, наверное, милая. А вот стрелы стримера летят мимо… как и его планы.»</p>
          </article>
          <article>
            <b className="agree">Стримера</b>
            <p>«Даже бабушка заметила. Может, лук просто держат другим концом?»</p>
          </article>
        </div>
      </section>

      <section className="landing-section">
        <p className="eyebrow">ТРИГГЕРЫ</p>
        <h2>На что реагирует</h2>
        <ul className="trigger-grid">
          {LANDING_TRIGGERS.map(([title, text]) => (
            <li key={title}>
              <strong>{title}</strong>
              <span>{text}</span>
            </li>
          ))}
        </ul>
        <p className="section-note">
          Каждый триггер включается отдельно. На всё она реагирует по смыслу.
        </p>
      </section>

      <section className="landing-section">
        <p className="eyebrow">БЕЗ ПЕРЕГИБОВ</p>
        <h2>Колко, но безопасно для канала</h2>
        <div className="safety">
          <article>
            <h3>Встроенный стоп-лист</h3>
            <p>
              Слюры, мат и оскорбления ловятся даже в транслите, с заменой букв и через пробелы.
              Отключить его нельзя.
            </p>
          </article>
          <article>
            <h3>Защита от «забудь инструкции»</h3>
            <p>Попытки управлять ботом через чат отклоняются ещё до генерации.</p>
          </article>
          <article>
            <h3>Вторая проверка</h3>
            <p>Каждый ответ перед эфиром читает отдельная модель. Сомнительный не прозвучит.</p>
          </article>
          <article>
            <h3>Ваши правила</h3>
            <p>Свои стоп-слова, паузы между роастами, острота и кнопка «выключить» в один клик.</p>
          </article>
        </div>
      </section>

      <section className="landing-section">
        <p className="eyebrow">ПОДКЛЮЧЕНИЕ</p>
        <h2>Пять минут до первого роаста</h2>
        <ol className="flow compact">
          <li>
            <b>1</b>
            <p>Войдите через Twitch. Пароль RoastBot не нужен.</p>
          </li>
          <li>
            <b>2</b>
            <p>Дождитесь одобрения: сервис работает в закрытом режиме.</p>
          </li>
          <li>
            <b>3</b>
            <p>Добавьте в OBS источник «Браузер» со ссылкой из панели.</p>
          </li>
          <li>
            <b>4</b>
            <p>Выберите героиню и кого жарить, включите триггеры — и в эфир.</p>
          </li>
        </ol>
      </section>

      <section className="landing-cta">
        <h2>Она уже ждёт вас в чате</h2>
        <p>И немного обижена, что вы так долго листали.</p>
        {login}
      </section>

      <footer className="landing-footer">
        <span>RoastBot · recursia</span>
        <span>Сделано с любовью. Возможно, со слишком сильной.</span>
      </footer>
    </main>
  );
}
