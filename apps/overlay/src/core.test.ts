import { describe, expect, it } from "vitest";
import {
  EventQueue,
  getToken,
  parseEvent,
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
});
