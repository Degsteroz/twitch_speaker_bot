import {
  EventQueue,
  getToken,
  parseEvent,
  reconnectDelay,
  websocketUrl,
  type RoastEvent
} from "./core.js";
import "./styles.css";

function element(selector: string): Element {
  const found = document.querySelector(selector);
  if (!found) throw new Error(`Overlay element missing: ${selector}`);
  return found;
}
const card = element("#roast") as HTMLElement;
const viewer = element("#viewer") as HTMLElement;
const roastText = element("#text") as HTMLElement;
const audio = element("#audio") as HTMLAudioElement;
const recover = element("#recover") as HTMLButtonElement;
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
  card.classList.remove("visible");
  active = undefined;
}
function next() {
  if (active) return;
  const event = queue.shift();
  if (!event) return;
  active = event;
  viewer.textContent = `@${event.viewerLogin}`;
  roastText.textContent = event.text;
  audio.src = event.audioUrl;
  card.hidden = false;
  requestAnimationFrame(() => card.classList.add("visible"));
  void audio
    .play()
    .then(() => {
      recover.hidden = true;
    })
    .catch(() => {
      recover.hidden = false;
    });
}
function finish() {
  audio.pause();
  audio.removeAttribute("src");
  audio.load();
  hideCard();
  recover.hidden = true;
  next();
}
audio.addEventListener("ended", finish);
audio.addEventListener("error", finish);
recover.addEventListener("click", () => {
  if (!active) return;
  void audio
    .play()
    .then(() => {
      recover.hidden = true;
    })
    .catch(() => {
      recover.hidden = false;
    });
});

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

window.addEventListener("beforeunload", () => {
  stopped = true;
  if (reconnectTimer !== undefined) clearTimeout(reconnectTimer);
  socket?.close();
});
connect();
