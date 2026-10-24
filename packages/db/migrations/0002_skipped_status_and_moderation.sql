-- Rejections (cooldown, quota, kill switch, disabled channel, stale job) are not generation
-- errors; keeping them out of 'failed' keeps the "errors < 2%" success metric meaningful.
ALTER TYPE "roast_status" ADD VALUE IF NOT EXISTS 'skipped';

ALTER TABLE "roasts" ADD COLUMN "moderation_reviewed_at" timestamptz;

CREATE INDEX "roasts_moderation_queue_idx"
  ON "roasts" ("created_at")
  WHERE "moderation_reviewed_at" IS NULL
    AND "status" IN ('blocked_input', 'blocked_output');
