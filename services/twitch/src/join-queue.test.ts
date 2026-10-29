import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { JoinQueue } from "./join-queue.js";

describe("JoinQueue", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  const setup = (failing = new Set<string>()) => {
    const joined = new Set<string>();
    const sent: string[] = [];
    const errors: string[] = [];
    const queue = new JoinQueue({
      join: (login) => {
        sent.push(login);
        if (failing.has(login)) return Promise.reject(new Error("No response from Twitch."));
        joined.add(login);
        return Promise.resolve();
      },
      joined: (login) => joined.has(login),
      log: (message) => errors.push(message),
      intervalMs: 600
    });
    return { queue, joined, sent, errors };
  };

  it("sends one JOIN per interval, never a burst", async () => {
    const { queue, sent } = setup();
    for (const login of ["a", "b", "c", "d"]) queue.want(login);
    await vi.advanceTimersByTimeAsync(0);
    expect(sent).toEqual(["a"]);
    await vi.advanceTimersByTimeAsync(599);
    expect(sent).toEqual(["a"]);
    await vi.advanceTimersByTimeAsync(1);
    expect(sent).toEqual(["a", "b"]);
    await vi.advanceTimersByTimeAsync(1_200);
    expect(sent).toEqual(["a", "b", "c", "d"]);
  });

  it("asks for a channel once, and not at all when it is joined", async () => {
    const { queue, joined, sent } = setup();
    joined.add("a");
    queue.want("a");
    queue.want("b");
    queue.want("b");
    await vi.advanceTimersByTimeAsync(5_000);
    expect(sent).toEqual(["b"]);
  });

  it("logs a failed JOIN and keeps going; asking again retries it", async () => {
    const failing = new Set(["a"]);
    const { queue, sent, errors } = setup(failing);
    queue.want("a");
    queue.want("b");
    await vi.advanceTimersByTimeAsync(1_000);
    expect(sent).toEqual(["a", "b"]);
    expect(errors).toEqual(["IRC join a failed:"]);
    failing.clear();
    queue.want("a");
    await vi.advanceTimersByTimeAsync(1_000);
    expect(sent).toEqual(["a", "b", "a"]);
  });

  it("drops a forgotten channel and skips one that got joined meanwhile", async () => {
    const { queue, joined, sent } = setup();
    queue.want("a");
    queue.want("b");
    queue.want("c");
    queue.forget("b");
    joined.add("c");
    await vi.advanceTimersByTimeAsync(5_000);
    expect(sent).toEqual(["a"]);
  });

  it("waits out a pause before the next JOIN", async () => {
    const { queue, sent } = setup();
    queue.pause(3_000);
    queue.want("a");
    await vi.advanceTimersByTimeAsync(2_999);
    expect(sent).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(sent).toEqual(["a"]);
  });

  it("does nothing after stop", async () => {
    const { queue, sent } = setup();
    queue.want("a");
    queue.stop();
    queue.want("b");
    await vi.advanceTimersByTimeAsync(5_000);
    expect(sent).toEqual([]);
  });
});
