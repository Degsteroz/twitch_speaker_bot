-- Channel-points verdict (agree / mixed / refuse) for rewards judged by the bot; null otherwise.
ALTER TABLE "roasts" ADD COLUMN "verdict" text;
ALTER TABLE "roasts" ADD CONSTRAINT "roasts_verdict_check"
  CHECK ("verdict" IS NULL OR "verdict" IN ('agree', 'mixed', 'refuse'));
