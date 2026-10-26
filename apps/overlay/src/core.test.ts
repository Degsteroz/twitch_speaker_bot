import { describe, expect, it } from "vitest";
import {
  EventQueue,
  getToken,
  parseEvent,
  previewTone,
  readingTimeMs,
  reconnectDelay,
  websocketUrl,
  type RoastEvent
} from "./core.js";

const event = (id = "a"): RoastEvent => ({
  version: 1,
  type: "roast.play",
  eventId: id,
  roastId: "r",
  viewerLogin: "viewer",
  text: "Тест",
  audioUrl: "https://api.test/audio/a.wav",
  sentAt: "2026-01-01T00:00:00.000Z",
  expiresAt: "2026-01-01T00:02:00.000Z"
});

describe("overlay protocol", () => {
  it("validates messages without throwing", () => {
    expect(parseEvent("{bad")).toBeNull();
    expect(parseEvent(JSON.stringify(event()))?.type).toBe("roast.play");
    expect(parseEvent(JSON.stringify({ ...event(), text: "" }))).toBeNull();
  });
  it("carries the character tone and drops an unknown one without losing the roast", () => {
    const tagged = parseEvent(JSON.stringify({ ...event(), tone: "yandere" })) as RoastEvent;
    expect(tagged.tone).toBe("yandere");
    const unknown = parseEvent(JSON.stringify({ ...event(), tone: "kuudere" })) as RoastEvent;
    expect(unknown.type).toBe("roast.play");
    expect(unknown).not.toHaveProperty("tone");
    expect(previewTone("?preview=tsundere")).toBe("tsundere");
    expect(previewTone("?preview=<script>")).toBeNull();
  });
  it("shows the service address only when the free plan asks for it", () => {
    const branded = parseEvent(JSON.stringify({ ...event(), branding: true })) as RoastEvent;
    expect(branded.branding).toBe(true);
    const odd = parseEvent(JSON.stringify({ ...event(), branding: "yes" })) as RoastEvent;
    expect(odd).not.toHaveProperty("branding");
  });
  it("deduplicates and expires FIFO events", () => {
    const queue = new EventQueue();
    const now = Date.parse("2026-01-01T00:01:00.000Z");
    expect(queue.enqueue(event("1"), now)).toBe(true);
    expect(queue.enqueue(event("1"), now)).toBe(false);
    expect(queue.enqueue({ ...event("2"), expiresAt: "2025-01-01T00:00:00.000Z" }, now)).toBe(
      false
    );
    expect(queue.shift(now)?.eventId).toBe("1");
  });
  it("derives token, websocket URL and bounded backoff", () => {
    expect(getToken({ search: "?token=secret", pathname: "/" })).toBe("secret");
    expect(getToken({ search: "", pathname: "/overlay/path-token" })).toBe("path-token");
    expect(websocketUrl("a b", { protocol: "https:", host: "site.test" })).toBe(
      "wss://site.test/overlay/a%20b"
    );
    expect(reconnectDelay(20, 0.5)).toBe(30_000);
  });
  it("keeps a silent card on screen long enough to read, but bounded", () => {
    expect(readingTimeMs("")).toBe(4_000);
    expect(readingTimeMs("а".repeat(100))).toBe(11_000);
    expect(readingTimeMs("а".repeat(1_000))).toBe(15_000);
  });
});
