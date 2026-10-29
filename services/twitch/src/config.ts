import type { createDatabase } from "@roastbot/db";
import { z } from "zod";

export type Sql = ReturnType<typeof createDatabase>["client"];

const configSchema = z.object({
  DATABASE_URL: z.string().min(1),
  TWITCH_CLIENT_ID: z.string().min(1),
  TWITCH_CLIENT_SECRET: z.string().min(1),
  TOKEN_ENCRYPTION_KEY: z.string().regex(/^[a-fA-F0-9]{64}$/u),
  // Optional: without both, connected DonationAlerts accounts are not listened to.
  DONATIONALERTS_CLIENT_ID: z.string().optional(),
  DONATIONALERTS_CLIENT_SECRET: z.string().optional(),
  // Twitch CLI mock (`twitch event websocket start-server`) for local checks:
  // ws://127.0.0.1:8080/ws and http://127.0.0.1:8080/eventsub/subscriptions.
  TWITCH_EVENTSUB_WS_URL: z.string().url().default("wss://eventsub.wss.twitch.tv/ws"),
  TWITCH_EVENTSUB_SUBSCRIPTIONS_URL: z
    .string()
    .url()
    .default("https://api.twitch.tv/helix/eventsub/subscriptions")
});

export type TwitchConfig = z.infer<typeof configSchema>;

export const loadConfig = (): TwitchConfig => configSchema.parse(process.env);
