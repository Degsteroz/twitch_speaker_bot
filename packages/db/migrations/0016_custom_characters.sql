-- Premium characters: a streamer's own heroine (name, temperament, ElevenLabs voice, picture),
-- and a shop where the owner-approved ones are open to every premium channel. Pictures and voice
-- samples are small and live in the database, so pg_dump backs them up with everything else.
ALTER TYPE "tone" ADD VALUE IF NOT EXISTS 'kuudere';
--> statement-breakpoint
ALTER TYPE "tone" ADD VALUE IF NOT EXISTS 'dandere';
--> statement-breakpoint
ALTER TYPE "tone" ADD VALUE IF NOT EXISTS 'himedere';
--> statement-breakpoint
-- ElevenLabs voices the owner offers; the worker records a sample of each for the panel.
CREATE TABLE "voices" (
  "id" text PRIMARY KEY NOT NULL,
  "label" text NOT NULL,
  "description" text DEFAULT '' NOT NULL,
  "enabled" boolean DEFAULT true NOT NULL,
  "sort" integer DEFAULT 0 NOT NULL,
  "sample" bytea,
  "sample_status" text DEFAULT 'pending' NOT NULL,
  "created_at" timestamptz DEFAULT now() NOT NULL,
  CONSTRAINT "voices_id_check" CHECK ("id" ~ '^[A-Za-z0-9]{10,40}$'),
  CONSTRAINT "voices_sample_status_check" CHECK ("sample_status" IN ('pending', 'ready', 'failed'))
);
--> statement-breakpoint
CREATE TABLE "characters" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "author_channel_id" uuid NOT NULL REFERENCES "channels"("id") ON DELETE CASCADE,
  "name" text NOT NULL,
  "archetype" "tone" NOT NULL,
  "voice_id" text REFERENCES "voices"("id") ON DELETE SET NULL,
  "image" bytea,
  "image_hash" text,
  "status" text DEFAULT 'private' NOT NULL,
  "review_note" text,
  "published_at" timestamptz,
  "created_at" timestamptz DEFAULT now() NOT NULL,
  "updated_at" timestamptz DEFAULT now() NOT NULL,
  CONSTRAINT "characters_status_check"
    CHECK ("status" IN ('private', 'pending', 'published', 'rejected')),
  CONSTRAINT "characters_image_check" CHECK (("image" IS NULL) = ("image_hash" IS NULL))
);
--> statement-breakpoint
CREATE INDEX "characters_author_idx" ON "characters" ("author_channel_id");
--> statement-breakpoint
CREATE INDEX "characters_status_idx" ON "characters" ("status", "published_at");
--> statement-breakpoint
-- The channel's chosen character and the name it goes by on this channel (null: its own name).
ALTER TABLE "settings" ADD COLUMN "character_id" uuid REFERENCES "characters"("id") ON DELETE SET NULL;
--> statement-breakpoint
ALTER TABLE "settings" ADD COLUMN "character_name" text;
--> statement-breakpoint
ALTER TABLE "roasts" ADD COLUMN "character_id" uuid REFERENCES "characters"("id") ON DELETE SET NULL;
