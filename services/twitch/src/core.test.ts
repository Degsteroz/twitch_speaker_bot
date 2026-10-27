import { describe, expect, it } from "vitest";

import { decryptToken, encryptToken, parseRoastCommand, reconnectDelayMs } from "./core.js";

describe("parseRoastCommand", () => {
  it("matches only the exact Cyrillic command and falls back to login", () => {
    expect(parseRoastCommand("!роаст target", "viewer")).toBe("target");
    expect(parseRoastCommand(" !роаст ", "viewer")).toBe("viewer");
    expect(parseRoastCommand("hello !роаст target", "viewer")).toBeNull();
    expect(parseRoastCommand("!roast target", "viewer")).toBeNull();
    expect(parseRoastCommand("!роастик", "viewer")).toBeNull();
  });

  it("is case-insensitive for the command itself", () => {
    expect(parseRoastCommand("!РОАСТ мой aim", "viewer")).toBe("мой aim");
  });

  it("answers the channel's own command instead of !роаст", () => {
    expect(parseRoastCommand("!Мицуки скажи  что-нибудь", "viewer", "!мицуки")).toBe(
      "скажи  что-нибудь"
    );
    expect(parseRoastCommand("!роаст target", "viewer", "!мицуки")).toBeNull();
  });
});

describe("reconnectDelayMs", () => {
  it("backs off exponentially with a one-minute ceiling", () => {
    expect(reconnectDelayMs(0, 0.5)).toBe(2_000);
    expect(reconnectDelayMs(3, 0.5)).toBe(16_000);
    expect(reconnectDelayMs(50, 0.5)).toBe(60_000);
  });
});

it("encrypts Twitch tokens", () => {
  const key = "ab".repeat(32);
  const encrypted = encryptToken("token", key);
  expect(decryptToken(encrypted, key)).toBe("token");
});
