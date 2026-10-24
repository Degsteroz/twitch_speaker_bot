import { describe, expect, it } from "vitest";

import { decryptValue, encryptValue, signAudioPath, verifyAudioSignature } from "./security.js";

const key = "01".repeat(32);

describe("token encryption", () => {
  it("round trips and uses independent nonces", () => {
    const first = encryptValue("access", key);
    const second = encryptValue("refresh", key);
    expect(first.iv).not.toBe(second.iv);
    expect(first.tag).not.toBe(second.tag);
    expect(decryptValue(first, key)).toBe("access");
    expect(decryptValue(second, key)).toBe("refresh");
  });
});

describe("audio signatures", () => {
  it("expires and rejects traversal", () => {
    const path = signAudioPath("test.wav", "secret".repeat(8), 1_000_000);
    const url = new URL(path, "https://example.test");
    const expires = Number(url.searchParams.get("expires"));
    const sig = url.searchParams.get("sig") ?? "";
    expect(verifyAudioSignature("test.wav", expires, sig, "secret".repeat(8), 1_000_000)).toBe(
      true
    );
    expect(verifyAudioSignature("../test.wav", expires, sig, "secret".repeat(8), 1_000_000)).toBe(
      false
    );
    expect(verifyAudioSignature("test.wav", expires, sig, "secret".repeat(8), 100_000_000)).toBe(
      false
    );
  });
});
