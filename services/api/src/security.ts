import {
  createCipheriv,
  createDecipheriv,
  createHmac,
  randomBytes,
  timingSafeEqual
} from "node:crypto";
import { basename } from "node:path";

import { AUDIO_URL_TTL_SECONDS } from "@roastbot/shared";

export interface EncryptedValue {
  ciphertext: string;
  iv: string;
  tag: string;
}

export function encryptValue(value: string, keyHex: string): EncryptedValue {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", Buffer.from(keyHex, "hex"), iv);
  const ciphertext = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  return {
    ciphertext: ciphertext.toString("base64url"),
    iv: iv.toString("base64url"),
    tag: cipher.getAuthTag().toString("base64url")
  };
}

export function decryptValue(value: EncryptedValue, keyHex: string): string {
  const decipher = createDecipheriv(
    "aes-256-gcm",
    Buffer.from(keyHex, "hex"),
    Buffer.from(value.iv, "base64url")
  );
  decipher.setAuthTag(Buffer.from(value.tag, "base64url"));
  return Buffer.concat([
    decipher.update(Buffer.from(value.ciphertext, "base64url")),
    decipher.final()
  ]).toString("utf8");
}

function signature(filename: string, expires: number, secret: string): Buffer {
  return createHmac("sha256", secret).update(`${filename}.${expires}`).digest();
}

export function signAudioPath(filename: string, secret: string, now = Date.now()): string {
  const safe = basename(filename);
  const expires = Math.floor(now / 1000) + AUDIO_URL_TTL_SECONDS;
  return `/audio/${encodeURIComponent(safe)}?expires=${expires}&sig=${signature(safe, expires, secret).toString("base64url")}`;
}

export function verifyAudioSignature(
  filename: string,
  expires: number,
  supplied: string,
  secret: string,
  now = Date.now()
): boolean {
  if (filename !== basename(filename) || expires < Math.floor(now / 1000)) return false;
  const expected = signature(filename, expires, secret);
  let received: Buffer;
  try {
    received = Buffer.from(supplied, "base64url");
  } catch {
    return false;
  }
  return received.length === expected.length && timingSafeEqual(received, expected);
}
