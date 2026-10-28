-- "Ноль сожалений": toxicity 6, opened per channel by the owner. Mat is free and the tone angry;
-- the always-blocked stop-list categories and the classifier stay as they are.
ALTER TABLE "channel_overrides" ADD COLUMN IF NOT EXISTS "zero_regrets" boolean DEFAULT false NOT NULL;
--> statement-breakpoint
ALTER TABLE "settings" DROP CONSTRAINT IF EXISTS "settings_toxicity_check";
--> statement-breakpoint
ALTER TABLE "settings" ADD CONSTRAINT "settings_toxicity_check" CHECK ("toxicity" BETWEEN 1 AND 6);
--> statement-breakpoint
ALTER TABLE "roasts" DROP CONSTRAINT IF EXISTS "roasts_toxicity_check";
--> statement-breakpoint
ALTER TABLE "roasts" ADD CONSTRAINT "roasts_toxicity_check" CHECK ("toxicity" BETWEEN 1 AND 6);
