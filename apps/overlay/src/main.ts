import tsundereUrl from "./assets/tsundere.webp";
import yandereUrl from "./assets/yandere.webp";
import {
  EventQueue,
  getToken,
  parseEvent,
  previewTone,
  readingTimeMs,
  reconnectDelay,
  websocketUrl,
  type Character,
  type RoastEvent,
  type Tone,
  type Verdict
} from "./core.js";
import "./styles.css";

const CHARACTERS: Readonly<Record<Tone, string>> = { tsundere: tsundereUrl, yandere: yandereUrl };
// Decode both up front so the first roast does not pop in without its character.
for (const url of Object.values(CHARACTERS)) new Image().src = url;

function element(selector: string): Element {
  const found = document.querySelector(selector);
  if (!found) throw new Error(`Overlay element missing: ${selector}`);
  return found;
}
const card = element("#roast") as HTMLElement;
const character = element("#character") as HTMLImageElement;
const verdictBadge = element("#verdict") as HTMLElement;
const VERDICT_TEXT: Readonly<Record<Verdict, string>> = {
  agree: "✓ согласна",
  mixed: "≈ отчасти",
  refuse: "✗ не согласна"
};
const viewer = element("#viewer") as HTMLElement;
// The overlay is served from the service's own domain, so its host is the address to advertise.
const branding = element("#branding") as HTMLElement;
branding.textContent = location.hostname;
const roastText = element("#text") as HTMLElement;
const audio = element("#audio") as HTMLAudioElement;
const recover = element("#recover") as HTMLButtonElement;
// OBS Browser Source plays audio without a click; a button there would only hang on stream,
// since nobody can press it. Ordinary browsers need one click per page load.
const inObs = "obsstudio" in window;
let silentFallback: number | undefined;
const showUnlock = () => {
  if (!inObs) recover.hidden = false;
};
const connection = element("#connection") as HTMLElement;

const queue = new EventQueue();
const token = getToken(location);
let socket: WebSocket | undefined;
let active: RoastEvent | undefined;
let attempt = 0;
let reconnectTimer: number | undefined;
let stopped = false;

function send(value: unknown) {
  if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(value));
}
function hideCard() {
  card.hidden = true;
  card.classList.remove("visible", "speaking");
  active = undefined;
}
function showVerdict(verdict: Verdict | undefined) {
  verdictBadge.hidden = !verdict;
  verdictBadge.textContent = verdict ? VERDICT_TEXT[verdict] : "";
  if (verdict) verdictBadge.dataset.verdict = verdict;
}
function showCharacter(tone: Tone | undefined, custom?: Character) {
  if (tone) {
    card.dataset.tone = tone;
    character.src = custom?.imageUrl ?? CHARACTERS[tone];
    character.alt = custom?.name ?? "";
    character.hidden = false;
  } else {
    delete card.dataset.tone;
    character.removeAttribute("src");
    character.hidden = true;
  }
}
function next() {
  if (active) return;
  const event = queue.shift();
  if (!event) return;
  active = event;
  viewer.textContent = `@${event.viewerLogin}`;
  roastText.textContent = event.text;
  showCharacter(event.tone, event.character);
  showVerdict(event.verdict);
  branding.hidden = event.branding !== true;
  audio.src = event.audioUrl;
  card.hidden = false;
  requestAnimationFrame(() => card.classList.add("visible"));
  void audio
    .play()
    .then(() => {
      recover.hidden = true;
    })
    .catch(() => {
      showUnlock();
      // Without sound the card would wait forever for "ended" and block the queue.
      silentFallback = window.setTimeout(finish, readingTimeMs(event.text));
    });
}
function finish() {
  window.clearTimeout(silentFallback);
  audio.pause();
  audio.removeAttribute("src");
  audio.load();
  hideCard();
  recover.hidden = true;
  next();
}
audio.addEventListener("playing", () => {
  window.clearTimeout(silentFallback);
  card.classList.add("speaking");
});
audio.addEventListener("pause", () => card.classList.remove("speaking"));
audio.addEventListener("ended", finish);
audio.addEventListener("error", finish);
recover.addEventListener("click", () => {
  // The click itself unlocks audio for this page; replay the current roast if there is one.
  recover.hidden = true;
  if (!active) return;
  void audio.play().catch(showUnlock);
});

// One silent sample. Playing it is the only reliable autoplay probe: Chrome reports a running
// AudioContext even while it refuses to start <audio> without a click.
const SILENCE =
  "data:audio/wav;base64,UklGRiYAAABXQVZFZm10IBAAAAABAAEAIlYAAESsAAACABAAZGF0YQIAAAAAAA==";

/** Resolves true when the browser will refuse to start sound until the page gets a click. */
async function audioLocked(): Promise<boolean> {
  try {
    await new Audio(SILENCE).play();
    return false;
  } catch (error) {
    return error instanceof DOMException && error.name === "NotAllowedError";
  }
}

function connect() {
  if (!token) {
    connection.textContent = "Нет токена overlay. Скопируй полную ссылку из панели RoastBot.";
    connection.classList.add("error");
    return;
  }
  // In `vite dev` the overlay runs on its own port, so the API socket lives on :3000.
  const configured =
    (import.meta.env.VITE_API_URL as string | undefined) ||
    (import.meta.env.DEV ? `${location.protocol}//${location.hostname}:3000` : undefined);
  connection.textContent = attempt ? "Переподключение…" : "Подключение…";
  socket = new WebSocket(websocketUrl(token, location, configured));
  socket.addEventListener("open", () => {
    attempt = 0;
    connection.hidden = true;
    send({
      version: 1,
      type: "overlay.ready",
      eventId: crypto.randomUUID(),
      sentAt: new Date().toISOString()
    });
  });
  socket.addEventListener("message", (message) => {
    if (typeof message.data !== "string") return;
    const event = parseEvent(message.data);
    if (!event) return;
    if (event.type === "overlay.ping") {
      send({
        version: 1,
        type: "overlay.pong",
        eventId: event.eventId,
        sentAt: new Date().toISOString()
      });
      return;
    }
    send({
      version: 1,
      type: "overlay.ack",
      eventId: event.eventId,
      receivedAt: new Date().toISOString()
    });
    // Start loading a premium character's picture while earlier roasts still play.
    if (event.character) new Image().src = event.character.imageUrl;
    if (queue.enqueue(event)) next();
  });
  socket.addEventListener("close", (event) => {
    connection.hidden = false;
    if (event.code === 1008) {
      stopped = true;
      connection.textContent = "Токен overlay недействителен.";
      connection.classList.add("error");
      return;
    }
    if (!stopped) {
      const delay = reconnectDelay(attempt++);
      reconnectTimer = window.setTimeout(connect, delay);
    }
  });
  socket.addEventListener("error", () => {
    connection.hidden = false;
    connection.textContent = "Связь потеряна…";
  });
}

function showPreview(tone: Tone) {
  connection.hidden = true;
  viewer.textContent = "@viewer";
  roastText.textContent =
    tone === "tsundere"
      ? "Хм, это была игра? Не то чтобы мне было интересно, но… ладно, чуть-чуть."
      : "Я видела каждый твой промах… и запомнила их все. Навсегда.";
  showCharacter(tone);
  showVerdict(tone === "tsundere" ? "refuse" : undefined);
  card.hidden = false;
  requestAnimationFrame(() => card.classList.add("visible", "speaking"));
}

window.addEventListener("beforeunload", () => {
  stopped = true;
  if (reconnectTimer !== undefined) clearTimeout(reconnectTimer);
  socket?.close();
});
const preview = previewTone(location.search);
if (preview) showPreview(preview);
else {
  // Ask for the one click up front, before the first roast arrives, not in the middle of it.
  void audioLocked().then((locked) => {
    if (locked) showUnlock();
  });
  connect();
}
