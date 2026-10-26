-- Model and voice by plan. A plan with `premium_roasts` set gets that many roasts a month on the
-- global model and the best voice (ElevenLabs), the rest on its economy model and voice; null
-- means every roast is premium. Free starts with two premium roasts.
ALTER TABLE "plans" ADD COLUMN "premium_roasts" integer;
--> statement-breakpoint
ALTER TABLE "plans" ADD COLUMN "economy_model" text DEFAULT 'claude-haiku-5-5' NOT NULL;
--> statement-breakpoint
ALTER TABLE "plans" ADD COLUMN "economy_voice" text DEFAULT 'yandex' NOT NULL;
--> statement-breakpoint
ALTER TABLE "plans" ADD CONSTRAINT "plans_premium_roasts_check"
  CHECK ("premium_roasts" IS NULL OR "premium_roasts" >= 0);
--> statement-breakpoint
ALTER TABLE "plans" ADD CONSTRAINT "plans_economy_voice_check"
  CHECK ("economy_voice" IN ('yandex', 'piper'));
--> statement-breakpoint
UPDATE "plans" SET "premium_roasts" = 2 WHERE "code" = 'free';
--> statement-breakpoint
ALTER TABLE "usage_monthly" ADD COLUMN "premium_roasts" integer DEFAULT 0 NOT NULL;
--> statement-breakpoint
ALTER TABLE "usage_monthly" ADD CONSTRAINT "usage_monthly_premium_roasts_check"
  CHECK ("premium_roasts" >= 0);
--> statement-breakpoint
-- What each roast actually used, for the roast page and the owner's cost questions.
ALTER TABLE "roasts" ADD COLUMN "tier" text;
--> statement-breakpoint
ALTER TABLE "roasts" ADD COLUMN "model" text;
--> statement-breakpoint
ALTER TABLE "roasts" ADD COLUMN "voice_provider" text;
--> statement-breakpoint
ALTER TABLE "roasts" ADD CONSTRAINT "roasts_tier_check"
  CHECK ("tier" IS NULL OR "tier" IN ('premium', 'economy'));
--> statement-breakpoint
-- Dashboard tests and simulated events: a small daily allowance apart from the monthly quota.
CREATE TABLE "test_usage_daily" (
  "channel_id" uuid NOT NULL REFERENCES "channels"("id") ON DELETE CASCADE,
  "day" date NOT NULL,
  "roasts" integer DEFAULT 0 NOT NULL,
  CONSTRAINT "test_usage_daily_pk" PRIMARY KEY ("channel_id", "day"),
  CONSTRAINT "test_usage_daily_roasts_check" CHECK ("roasts" >= 0)
);
