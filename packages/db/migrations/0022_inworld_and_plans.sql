-- Voices: ElevenLabs while its plan lasts, then Inworld, then Yandex. Piper (services/tts) is only
-- the emergency voice when every cloud voice failed: no plan and no override may pick it.
UPDATE "plans" SET "economy_voice" = 'yandex' WHERE "economy_voice" = 'piper';
--> statement-breakpoint
ALTER TABLE "plans" DROP CONSTRAINT "plans_economy_voice_check";
--> statement-breakpoint
ALTER TABLE "plans" ADD CONSTRAINT "plans_economy_voice_check" CHECK ("economy_voice" IN ('yandex'));
--> statement-breakpoint
UPDATE "channel_overrides" SET "economy_voice" = 'yandex' WHERE "economy_voice" = 'piper';
--> statement-breakpoint
ALTER TABLE "channel_overrides" DROP CONSTRAINT "channel_overrides_voice_check";
--> statement-breakpoint
ALTER TABLE "channel_overrides" ADD CONSTRAINT "channel_overrides_voice_check"
  CHECK ("economy_voice" IN ('yandex'));
--> statement-breakpoint
-- The list of voices for own characters holds Inworld voices too; the ID format is per provider.
ALTER TABLE "voices" ADD COLUMN "provider" text DEFAULT 'elevenlabs' NOT NULL;
--> statement-breakpoint
ALTER TABLE "voices" DROP CONSTRAINT "voices_id_check";
--> statement-breakpoint
ALTER TABLE "voices" ADD CONSTRAINT "voices_id_check" CHECK (
  ("provider" = 'elevenlabs' AND "id" ~ '^[A-Za-z0-9]{10,40}$')
  OR ("provider" = 'inworld' AND "id" ~ '^[A-Za-z0-9_-]{2,80}$'));
--> statement-breakpoint
INSERT INTO "global_settings" ("key", "value") VALUES ('inworld_monthly_char_limit', '500000'::jsonb)
  ON CONFLICT ("key") DO NOTHING;
--> statement-breakpoint
-- Plans: N roasts in the good voice, then M in Yandex, then a stop until next month. The total
-- (monthly_roast_limit) is now the owner's in /admin like the rest; the seed only inserts it.
-- At full use a good roast costs about $0.007 and a Yandex one $0.004; a Star pays out about
-- $0.0124, the buyer pays about $0.02 for it.
-- Free: 15 good + 85 Yandex. Basic: 500 + 200 = $4.3 for 300 Stars ($3.7 out, $5.99 for the buyer).
-- Premium: 1000 + 500 = $9.0 for 600 Stars ($7.4 out, $11.99 for the buyer).
-- Only the defaults of 0015 and the seed are replaced: values the owner set in /admin stay.
UPDATE "plans" SET "monthly_roast_limit" = 100 WHERE "code" = 'free' AND "monthly_roast_limit" = 10;
--> statement-breakpoint
UPDATE "plans" SET "premium_roasts" = 15 WHERE "code" = 'free' AND "premium_roasts" = 2;
--> statement-breakpoint
UPDATE "plans" SET "monthly_roast_limit" = 700 WHERE "code" = 'basic' AND "monthly_roast_limit" = 300;
--> statement-breakpoint
UPDATE "plans" SET "premium_roasts" = 500 WHERE "code" = 'basic' AND "premium_roasts" = 50;
--> statement-breakpoint
UPDATE "plans" SET "stars_price" = 300 WHERE "code" = 'basic' AND "stars_price" = 170;
--> statement-breakpoint
UPDATE "plans" SET "premium_roasts" = 1000 WHERE "code" = 'premium' AND "premium_roasts" = 300;
--> statement-breakpoint
UPDATE "plans" SET "stars_price" = 600 WHERE "code" = 'premium' AND "stars_price" = 900;
