import { z } from "zod";

const envSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  HOST: z.string().default("0.0.0.0"),
  PORT: z.coerce.number().int().min(1).max(65_535).default(3000),
  DATABASE_URL: z.string().min(1),
  PUBLIC_URL: z.string().url(),
  DASHBOARD_URL: z.string().url(),
  TWITCH_CLIENT_ID: z.string().min(1),
  TWITCH_CLIENT_SECRET: z.string().min(1),
  TWITCH_REDIRECT_URI: z.string().url(),
  TWITCH_OWNER_IDS: z.string().default(""),
  SESSION_SECRET: z.string().min(32),
  TOKEN_ENCRYPTION_KEY: z.string().regex(/^[a-fA-F0-9]{64}$/u),
  AUDIO_SIGNING_SECRET: z.string().min(32),
  AUDIO_DIR: z.string().default("/data/audio")
});

export type ApiConfig = z.infer<typeof envSchema> & { ownerIds: ReadonlySet<string> };

export function loadConfig(env: NodeJS.ProcessEnv = process.env): ApiConfig {
  const parsed = envSchema.parse(env);
  return {
    ...parsed,
    ownerIds: new Set(
      parsed.TWITCH_OWNER_IDS.split(",")
        .map((id) => id.trim())
        .filter(Boolean)
    )
  };
}
