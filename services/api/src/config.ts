import { z } from "zod";

const envSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  HOST: z.string().default("0.0.0.0"),
  PORT: z.coerce.number().int().min(1).max(65_535).default(3000),
  DATABASE_URL: z.string().min(1),
  PUBLIC_URL: z.string().url(),
  // Overlay mirrors for regions that cannot reach PUBLIC_URL (deploy/Caddyfile.relay): their API
  // bases, comma-separated, e.g. https://ru.example.com/api. The relay names itself in the
  // X-RoastBot-Mirror header; a socket from there gets audio and picture links on the mirror.
  OVERLAY_MIRROR_URLS: z.string().default(""),
  DASHBOARD_URL: z.string().url(),
  TWITCH_CLIENT_ID: z.string().min(1),
  TWITCH_CLIENT_SECRET: z.string().min(1),
  TWITCH_REDIRECT_URI: z.string().url(),
  TWITCH_OWNER_IDS: z.string().default(""),
  SESSION_SECRET: z.string().min(32),
  TOKEN_ENCRYPTION_KEY: z.string().regex(/^[a-fA-F0-9]{64}$/u),
  AUDIO_SIGNING_SECRET: z.string().min(32),
  AUDIO_DIR: z.string().default("/data/audio"),
  // Optional integration: without both values the panel hides DonationAlerts.
  DONATIONALERTS_CLIENT_ID: z.string().optional(),
  DONATIONALERTS_CLIENT_SECRET: z.string().optional(),
  // Optional Telegram bot for streamers (notifications, Stars payments); all three or nothing.
  TELEGRAM_BOT_TOKEN: z.string().optional(),
  TELEGRAM_BOT_USERNAME: z.string().optional(),
  TELEGRAM_WEBHOOK_SECRET: z
    .string()
    .regex(/^[A-Za-z0-9_-]{16,256}$/u)
    .optional()
});

export type ApiConfig = z.infer<typeof envSchema> & {
  ownerIds: ReadonlySet<string>;
  /** Mirror host (lowercase) → its API base, from OVERLAY_MIRROR_URLS. */
  overlayMirrors: ReadonlyMap<string, string>;
};

/** Each entry must be an absolute http(s) URL; the host the relay reports selects it. */
export function parseOverlayMirrors(value: string): Map<string, string> {
  const mirrors = new Map<string, string>();
  for (const entry of value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean)) {
    const url = new URL(entry);
    if (url.protocol !== "https:" && url.protocol !== "http:") {
      throw new Error(`OVERLAY_MIRROR_URLS: ${entry} is not an http(s) URL`);
    }
    mirrors.set(url.host.toLowerCase(), entry.replace(/\/+$/u, ""));
  }
  return mirrors;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): ApiConfig {
  const parsed = envSchema.parse(env);
  return {
    ...parsed,
    overlayMirrors: parseOverlayMirrors(parsed.OVERLAY_MIRROR_URLS),
    ownerIds: new Set(
      parsed.TWITCH_OWNER_IDS.split(",")
        .map((id) => id.trim())
        .filter(Boolean)
    )
  };
}
