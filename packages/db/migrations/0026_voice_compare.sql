-- One phrase from Mitsuki and Ai in every voice service, for the owner to compare in /admin. Only
-- the latest recording per heroine and service is kept.
CREATE TABLE "voice_compare" (
  "tone" text NOT NULL,
  "provider" text NOT NULL,
  "text" text NOT NULL,
  "status" text DEFAULT 'pending' NOT NULL,
  "audio" bytea,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "voice_compare_pk" PRIMARY KEY ("tone", "provider"),
  CONSTRAINT "voice_compare_tone_check" CHECK ("tone" IN ('tsundere', 'yandere')),
  CONSTRAINT "voice_compare_provider_check" CHECK ("provider" IN ('elevenlabs', 'inworld', 'yandex')),
  CONSTRAINT "voice_compare_status_check" CHECK ("status" IN ('pending', 'ready', 'failed', 'no_voice'))
);
