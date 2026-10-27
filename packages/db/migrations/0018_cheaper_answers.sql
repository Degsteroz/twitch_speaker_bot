-- Prerecorded stubs for viewers who call the bot during a pause or past their limit: each phrase
-- is synthesized once per ElevenLabs voice and kept here (it lands in pg_dump with the rest).
CREATE TABLE IF NOT EXISTS "stub_audio" (
  "voice_key" text NOT NULL,
  "text" text NOT NULL,
  "audio" bytea NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "stub_audio_pk" PRIMARY KEY("voice_key","text")
);
--> statement-breakpoint
-- Sonnet writes roasts at about half Opus's price; Haiku answers chat words. Only the old default
-- is replaced: a model the owner picked in /admin stays.
UPDATE "global_settings" SET "value" = '"claude-sonnet-5-5"'::jsonb, "updated_at" = now()
  WHERE "key" = 'model' AND "value" = '"claude-opus-5-5"'::jsonb;
--> statement-breakpoint
INSERT INTO "global_settings" ("key", "value") VALUES ('chat_model', '"claude-haiku-5-5"'::jsonb)
  ON CONFLICT ("key") DO NOTHING;
