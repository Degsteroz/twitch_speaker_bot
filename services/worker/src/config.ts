import { z } from "zod";

const schema = z.object({
  DATABASE_URL: z.string().min(1),
  ANTHROPIC_API_KEY: z.string().min(1),
  TTS_URL: z.string().url().default("http://tts:8000"),
  // Optional: without it every roast is voiced by the local Piper service.
  YANDEX_TTS_API_KEY: z.string().optional(),
  // Optional, tried before Yandex: an API key plus a voice ID per character (from the ElevenLabs
  // voice library). A character without a voice ID is voiced by the next provider.
  ELEVENLABS_API_KEY: z.string().optional(),
  ELEVENLABS_MODEL: z.string().default("eleven_v4"),
  ELEVENLABS_VOICE_TSUNDERE: z.string().optional(),
  ELEVENLABS_VOICE_YANDERE: z.string().optional(),
  AUDIO_DIR: z.string().default("/data/audio"),
  TELEGRAM_BOT_TOKEN: z.string().optional(),
  // Optional: the daily Telegram report links straight to failed roasts and the moderation queue.
  DASHBOARD_URL: z.string().url().optional(),
  TELEGRAM_CHAT_ID: z.string().optional()
});

export type WorkerConfig = z.infer<typeof schema>;
export const loadConfig = (env: NodeJS.ProcessEnv = process.env): WorkerConfig => schema.parse(env);
