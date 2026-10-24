import { describe, expect, it } from "vitest";

import {
  base32Decode,
  base32Encode,
  currentStep,
  generateRecoveryCodes,
  hashRecoveryCode,
  otpauthUri,
  totpCode,
  verifyTotp
} from "./totp.js";

// RFC 6238 appendix B, SHA-1 secret "12345678901234567890".
const RFC_SECRET = base32Encode(Buffer.from("12345678901234567890"));

describe("totp", () => {
  it("matches the RFC 6238 test vectors", () => {
    expect(RFC_SECRET).toBe("GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ");
    expect(base32Decode(RFC_SECRET).toString()).toBe("12345678901234567890");
    expect(totpCode(RFC_SECRET, Math.floor(59 / 30), 8)).toBe("94287082");
    expect(totpCode(RFC_SECRET, Math.floor(1_111_111_109 / 30), 8)).toBe("07081804");
    expect(totpCode(RFC_SECRET, Math.floor(20_000_000_000 / 30), 8)).toBe("65353130");
  });

  it("accepts one step of drift and refuses replays", () => {
    const now = 1_700_000_000_000;
    const step = currentStep(now);
    expect(verifyTotp(RFC_SECRET, totpCode(RFC_SECRET, step), null, now)).toBe(step);
    expect(verifyTotp(RFC_SECRET, totpCode(RFC_SECRET, step - 1), null, now)).toBe(step - 1);
    expect(verifyTotp(RFC_SECRET, totpCode(RFC_SECRET, step - 2), null, now)).toBeNull();
    expect(verifyTotp(RFC_SECRET, totpCode(RFC_SECRET, step), step, now)).toBeNull();
    expect(verifyTotp(RFC_SECRET, "12345", null, now)).toBeNull();
  });

  it("builds an otpauth URI and hashes recovery codes regardless of formatting", () => {
    expect(otpauthUri("ABC", "owner")).toBe(
      "otpauth://totp/RoastBot:owner?secret=ABC&issuer=RoastBot&algorithm=SHA1&digits=6&period=30"
    );
    const codes = generateRecoveryCodes();
    expect(new Set(codes).size).toBe(8);
    expect(codes[0]).toMatch(/^[a-z2-7]{4}-[a-z2-7]{4}-[a-z2-7]{2}$/u);
    expect(hashRecoveryCode(codes[0]!.toUpperCase().replace(/-/gu, " "))).toBe(
      hashRecoveryCode(codes[0]!)
    );
  });
});
