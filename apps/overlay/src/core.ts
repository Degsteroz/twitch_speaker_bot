export type Tone = "tsundere" | "yandere";
const TONES: readonly Tone[] = ["tsundere", "yandere"];
export const isTone = (value: unknown): value is Tone =>
  typeof value === "string" && (TONES as readonly string[]).includes(value);

export type Verdict = "agree" | "mixed" | "refuse";
const VERDICTS: readonly Verdict[] = ["agree", "mixed", "refuse"];
const isVerdict = (value: unknown): value is Verdict =>
  typeof value === "string" && (VERDICTS as readonly string[]).includes(value);

export interface RoastEvent {
  version: 1;
  type: "roast.play";
  eventId: string;
  roastId: string;
  viewerLogin: string;
  text: string;
  /** Character to show; absent on events from before characters existed. */
  tone?: Tone;
  /** A premium character: her picture replaces the built-in one, `tone` stays the card theme. */
  character?: Character;
  /** Channel-points verdict, shown as a badge; absent for plain roasts. */
  verdict?: Verdict;
  /** Free plan: show the service address under the card. */
  branding?: boolean;
  /** A spoken roast. Absent on a free stub, which plays `sound` instead. */
  audioUrl?: string;
  sound?: StubSound;
  expiresAt: string;
  sentAt: string;
}
/** Sound effects the overlay bundles; a free stub names one of them. */
export type StubSound = "tap" | "ping" | "whoosh" | "door";
const STUB_SOUNDS: readonly StubSound[] = ["tap", "ping", "whoosh", "door"];
const isStubSound = (value: unknown): value is StubSound =>
  typeof value === "string" && (STUB_SOUNDS as readonly string[]).includes(value);
export interface Character {
  name: string;
  imageUrl: string;
}

/** Only a name and an http(s) picture; anything else is dropped, never the roast. */
function parseCharacter(value: unknown): Character | null {
  if (!isRecord(value) || !text(value.name, 20) || !text(value.imageUrl, 500)) return null;
  try {
    const url = new URL(value.imageUrl);
    if (url.protocol !== "https:" && url.protocol !== "http:") return null;
  } catch {
    return null;
  }
  return { name: value.name, imageUrl: value.imageUrl };
}

export interface PingEvent {
  version: 1;
  type: "overlay.ping";
  eventId: string;
  sentAt: string;
}
export type ServerEvent = RoastEvent | PingEvent;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const text = (value: unknown, max = 500): value is string =>
  typeof value === "string" && value.length > 0 && value.length <= max;

export function parseEvent(raw: string): ServerEvent | null {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (
    !isRecord(value) ||
    value.version !== 1 ||
    !text(value.type) ||
    !text(value.eventId, 100) ||
    !text(value.sentAt, 100)
  )
    return null;
  if (value.type === "overlay.ping") return value as unknown as PingEvent;
  if (
    value.type !== "roast.play" ||
    !text(value.roastId, 100) ||
    !text(value.viewerLogin, 64) ||
    !text(value.text, 200) ||
    !text(value.expiresAt, 100)
  )
    return null;
  // A roast carries audio; a free stub carries a sound. Neither means nothing to play.
  const hasAudio = text(value.audioUrl, 3000);
  if (!hasAudio && !isStubSound(value.sound)) return null;
  try {
    if (hasAudio) new URL(value.audioUrl as string);
    if (!Number.isFinite(Date.parse(value.expiresAt))) return null;
  } catch {
    return null;
  }
  // An unknown tone only loses the character, never the roast itself.
  const { tone, character, verdict, branding, sound, ...rest } = value;
  const custom = parseCharacter(character);
  return {
    ...(rest as unknown as RoastEvent),
    ...(isTone(tone) ? { tone } : {}),
    ...(custom ? { character: custom } : {}),
    ...(isVerdict(verdict) ? { verdict } : {}),
    ...(branding === true ? { branding: true } : {}),
    ...(isStubSound(sound) ? { sound } : {})
  };
}

/**
 * `?preview=tsundere` (or yandere) shows a sample card without a token or a connection, so the
 * streamer can place and size the Browser Source in OBS before going live.
 */
export function previewTone(search: string): Tone | null {
  const value = new URLSearchParams(search).get("preview");
  return isTone(value) ? value : null;
}

/** True when version.json names another build than the running page: a release happened. */
export function isOutdated(running: string, served: unknown): boolean {
  if (typeof served !== "object" || served === null) return false;
  const build = (served as { build?: unknown }).build;
  return typeof build === "string" && build.length > 0 && build !== running;
}

export function getToken(location: Pick<Location, "search" | "pathname">): string | null {
  const query = new URLSearchParams(location.search).get("token");
  if (query?.trim()) return query.trim();
  const parts = location.pathname.split("/").filter(Boolean);
  const marker = parts.lastIndexOf("overlay");
  const pathToken = marker >= 0 ? parts[marker + 1] : undefined;
  const trimmed = pathToken?.trim();
  return trimmed ?? null;
}

export function websocketUrl(
  token: string,
  page: Pick<Location, "protocol" | "host">,
  apiBase?: string
): string {
  const base = apiBase
    ? new URL(apiBase, `${page.protocol}//${page.host}`)
    : new URL(`${page.protocol}//${page.host}`);
  base.protocol = base.protocol === "https:" ? "wss:" : "ws:";
  base.pathname = `/overlay/${encodeURIComponent(token)}`;
  base.search = "";
  return base.toString();
}

export class EventQueue {
  private readonly queued: RoastEvent[] = [];
  private readonly seen = new Set<string>();
  enqueue(event: RoastEvent, now = Date.now()): boolean {
    if (this.seen.has(event.eventId) || Date.parse(event.expiresAt) <= now) return false;
    this.seen.add(event.eventId);
    this.queued.push(event);
    if (this.seen.size > 2_000) this.seen.delete(this.seen.values().next().value ?? "");
    return true;
  }
  shift(now = Date.now()): RoastEvent | undefined {
    while (this.queued.length) {
      const event = this.queued.shift();
      if (event && Date.parse(event.expiresAt) > now) return event;
    }
    return undefined;
  }
  get length() {
    return this.queued.length;
  }
}

export function reconnectDelay(attempt: number, random = Math.random()): number {
  return Math.min(30_000, 750 * 2 ** Math.min(attempt, 6)) * (0.8 + random * 0.4);
}

/**
 * How long a roast stays on screen when its audio cannot play (autoplay blocked, broken file):
 * long enough to read, short enough that the queue keeps moving.
 */
export function readingTimeMs(text: string): number {
  return Math.min(15_000, 4_000 + Array.from(text).length * 70);
}
