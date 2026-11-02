-- The owner picks the first voice of a channel's premium roasts (to try Inworld before ElevenLabs
-- runs out, or to save it); null keeps the usual chain. Piper is never chosen.
ALTER TABLE "channel_overrides" ADD COLUMN "best_voice" text;
--> statement-breakpoint
ALTER TABLE "channel_overrides" ADD CONSTRAINT "channel_overrides_best_voice_check"
  CHECK ("best_voice" IN ('elevenlabs', 'inworld', 'yandex'));
--> statement-breakpoint
-- Only Sonnet 5.5 and Haiku 5.5 are run: bigger models cost 2.5 times as much per roast. Any other
-- stored model goes back to the default of its place; the API refuses them from now on.
UPDATE "channel_overrides" SET "model" = NULL
  WHERE "model" NOT IN ('claude-sonnet-5-5', 'claude-haiku-5-5');
--> statement-breakpoint
UPDATE "channel_overrides" SET "chat_model" = NULL
  WHERE "chat_model" NOT IN ('claude-sonnet-5-5', 'claude-haiku-5-5');
--> statement-breakpoint
UPDATE "channel_overrides" SET "economy_model" = NULL
  WHERE "economy_model" NOT IN ('claude-sonnet-5-5', 'claude-haiku-5-5');
--> statement-breakpoint
UPDATE "plans" SET "economy_model" = 'claude-haiku-5-5'
  WHERE "economy_model" NOT IN ('claude-sonnet-5-5', 'claude-haiku-5-5');
--> statement-breakpoint
UPDATE "global_settings" SET "value" = '"claude-sonnet-5-5"'::jsonb, "updated_at" = now()
  WHERE "key" IN ('model', 'classifier_model')
    AND "value" #>> '{}' NOT IN ('claude-sonnet-5-5', 'claude-haiku-5-5');
--> statement-breakpoint
UPDATE "global_settings" SET "value" = '"claude-haiku-5-5"'::jsonb, "updated_at" = now()
  WHERE "key" = 'chat_model' AND "value" #>> '{}' NOT IN ('claude-sonnet-5-5', 'claude-haiku-5-5');
