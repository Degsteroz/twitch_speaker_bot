import { z } from "zod";

const schema = z.object({
  DATABASE_URL: z.string().min(1),
  ANTHROPIC_API_KEY: z.string().min(1),
  TTS_URL: z.string().url().default("http://tts:8000"),
  AUDIO_DIR: z.string().default("/data/audio"),
  TELEGRAM_BOT_TOKEN: z.string().optional(),
  TELEGRAM_CHAT_ID: z.string().optional()
});

export type WorkerConfig = z.infer<typeof schema>;
export const loadConfig = (env: NodeJS.ProcessEnv = process.env): WorkerConfig => schema.parse(env);
