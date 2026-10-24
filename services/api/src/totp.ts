import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";

// RFC 6238 TOTP with the parameters every authenticator app supports: HMAC-SHA1, 6 digits, 30 s.
const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
const PERIOD_SECONDS = 30;
const DIGITS = 6;

export function base32Encode(buffer: Buffer): string {
  let bits = 0;
  let value = 0;
  let output = "";
  for (const byte of buffer) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      output += ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) output += ALPHABET[(value << (5 - bits)) & 31];
  return output;
}

export function base32Decode(text: string): Buffer {
  const clean = text.replace(/[\s=]/gu, "").toUpperCase();
  let bits = 0;
  let value = 0;
  const bytes: number[] = [];
  for (const char of clean) {
    const index = ALPHABET.indexOf(char);
    if (index === -1) throw new Error("Invalid base32 character");
    value = (value << 5) | index;
    bits += 5;
    if (bits >= 8) {
      bytes.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(bytes);
}

/** 160-bit secret, the size RFC 4226 recommends for HMAC-SHA1. */
export const generateTotpSecret = () => base32Encode(randomBytes(20));

export const currentStep = (now = Date.now()) => Math.floor(now / 1000 / PERIOD_SECONDS);

export function totpCode(secret: string, step: number, digits = DIGITS): string {
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(step));
  const hmac = createHmac("sha1", base32Decode(secret)).update(counter).digest();
  const offset = (hmac[hmac.length - 1] ?? 0) & 15;
  const binary = hmac.readUInt32BE(offset) & 0x7f_ff_ff_ff;
  return String(binary % 10 ** digits).padStart(digits, "0");
}

/**
 * Returns the accepted time step, or null. One step of clock drift is tolerated either way, and
 * steps at or before `lastStep` are refused so an observed code cannot be replayed.
 */
export function verifyTotp(
  secret: string,
  code: string,
  lastStep: number | null,
  now = Date.now()
): number | null {
  if (!/^\d{6}$/u.test(code)) return null;
  const step = currentStep(now);
  for (const candidate of [step - 1, step, step + 1]) {
    if (lastStep !== null && candidate <= lastStep) continue;
    if (timingSafeEqual(Buffer.from(totpCode(secret, candidate)), Buffer.from(code))) {
      return candidate;
    }
  }
  return null;
}

export function otpauthUri(secret: string, account: string, issuer = "RoastBot"): string {
  const label = `${encodeURIComponent(issuer)}:${encodeURIComponent(account)}`;
  const params = new URLSearchParams({
    secret,
    issuer,
    algorithm: "SHA1",
    digits: String(DIGITS),
    period: String(PERIOD_SECONDS)
  });
  return `otpauth://totp/${label}?${params.toString()}`;
}

/** Codes look like `k3vq-7mxa-p2`: 50 random bits each, shown once, stored only as hashes. */
export function generateRecoveryCodes(count = 8): string[] {
  return Array.from({ length: count }, () => {
    const raw = base32Encode(randomBytes(7)).slice(0, 10).toLowerCase();
    return `${raw.slice(0, 4)}-${raw.slice(4, 8)}-${raw.slice(8)}`;
  });
}

export const normalizeRecoveryCode = (code: string) =>
  code.toLowerCase().replace(/[^a-z2-7]/gu, "");

export const hashRecoveryCode = (code: string) =>
  createHash("sha256").update(normalizeRecoveryCode(code)).digest("hex");
