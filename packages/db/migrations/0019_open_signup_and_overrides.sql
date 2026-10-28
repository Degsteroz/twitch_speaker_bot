-- Open registration: a new Twitch login is active at once, unless its Twitch account is younger
-- than signup_min_account_age_days or the day already has signup_daily_limit new accounts; those
-- still wait in 'pending' for the owner. A daily limit of 0 brings back review for everyone.
INSERT INTO "global_settings" ("key", "value") VALUES
  ('signup_daily_limit', '50'::jsonb),
  ('signup_min_account_age_days', '7'::jsonb)
  ON CONFLICT ("key") DO NOTHING;
--> statement-breakpoint
-- The owner's per-channel exceptions to the plan ("favourites"); null keeps the plan's value.
CREATE TABLE IF NOT EXISTS "channel_overrides" (
  "channel_id" uuid PRIMARY KEY NOT NULL REFERENCES "channels"("id") ON DELETE CASCADE,
  "unlimited" boolean DEFAULT false NOT NULL,
  "monthly_roast_limit" integer,
  "premium_roasts" integer,
  "min_cooldown_sec" integer,
  "model" text,
  "chat_model" text,
  "economy_model" text,
  "economy_voice" text,
  "note" text,
  "updated_by_user_id" uuid REFERENCES "users"("id") ON DELETE SET NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "channel_overrides_limits_check" CHECK (
    coalesce("monthly_roast_limit", 0) >= 0 AND coalesce("premium_roasts", 0) >= 0
    AND coalesce("min_cooldown_sec", 0) >= 0),
  CONSTRAINT "channel_overrides_voice_check" CHECK ("economy_voice" IN ('yandex', 'piper'))
);
