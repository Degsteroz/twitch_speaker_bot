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
  /** Channel-points verdict, shown as a badge; absent for plain roasts. */
  verdict?: Verdict;
  audioUrl: string;
  expiresAt: string;
  sentAt: string;
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
    !text(value.audioUrl, 3000) ||
    !text(value.expiresAt, 100)
  )
    return null;
  try {
    new URL(value.audioUrl);
    if (!Number.isFinite(Date.parse(value.expiresAt))) return null;
  } catch {
    return null;
  }
  // An unknown tone only loses the character, never the roast itself.
  const { tone, verdict, ...rest } = value;
  return {
    ...(rest as unknown as RoastEvent),
    ...(isTone(tone) ? { tone } : {}),
    ...(isVerdict(verdict) ? { verdict } : {})
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
