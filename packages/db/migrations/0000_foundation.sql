CREATE TYPE "user_role" AS ENUM ('owner', 'user');
CREATE TYPE "user_status" AS ENUM ('active', 'suspended');
CREATE TYPE "tone" AS ENUM ('tsundere', 'yandere');
CREATE TYPE "voice" AS ENUM ('male', 'female');
CREATE TYPE "plan_code" AS ENUM ('free', 'basic', 'premium');
CREATE TYPE "subscription_source" AS ENUM ('manual');
CREATE TYPE "event_type" AS ENUM ('chat_command', 'reward', 'dashboard_test');
CREATE TYPE "roast_status" AS ENUM ('queued', 'blocked_input', 'blocked_output', 'done', 'failed');
CREATE TYPE "cooldown_scope" AS ENUM ('channel', 'viewer');
CREATE TYPE "overlay_event_status" AS ENUM ('pending', 'delivered', 'expired');

CREATE TABLE "users" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "twitch_id" text NOT NULL,
  "login" text NOT NULL,
  "display_name" text NOT NULL,
  "role" "user_role" DEFAULT 'user' NOT NULL,
  "status" "user_status" DEFAULT 'active' NOT NULL,
  "created_at" timestamptz DEFAULT now() NOT NULL
);

CREATE TABLE "channels" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "user_id" uuid NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "twitch_login" text NOT NULL,
  "overlay_token" text NOT NULL,
  "created_at" timestamptz DEFAULT now() NOT NULL
);

CREATE TABLE "settings" (
  "channel_id" uuid PRIMARY KEY NOT NULL REFERENCES "channels"("id") ON DELETE CASCADE,
  "tone" "tone" DEFAULT 'tsundere' NOT NULL,
  "voice" "voice" DEFAULT 'female' NOT NULL,
  "toxicity" integer DEFAULT 2 NOT NULL,
  "cooldown_sec" integer DEFAULT 30 NOT NULL,
  "user_cooldown_sec" integer DEFAULT 60 NOT NULL,
  "triggers" jsonb DEFAULT '{"command":true,"rewardId":null}'::jsonb NOT NULL,
  "stop_words" text[] DEFAULT ARRAY[]::text[] NOT NULL,
  "enabled" boolean DEFAULT true NOT NULL,
  "updated_at" timestamptz DEFAULT now() NOT NULL,
  CONSTRAINT "settings_toxicity_check" CHECK ("toxicity" BETWEEN 1 AND 5),
  CONSTRAINT "settings_cooldown_sec_check" CHECK ("cooldown_sec" BETWEEN 0 AND 3600),
  CONSTRAINT "settings_user_cooldown_sec_check" CHECK ("user_cooldown_sec" BETWEEN 0 AND 86400)
);

CREATE TABLE "plans" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "code" "plan_code" NOT NULL,
  "monthly_roast_limit" integer NOT NULL,
  "monthly_tts_limit" integer NOT NULL,
  "created_at" timestamptz DEFAULT now() NOT NULL,
  CONSTRAINT "plans_roast_limit_check" CHECK ("monthly_roast_limit" >= 0),
  CONSTRAINT "plans_tts_limit_check" CHECK ("monthly_tts_limit" >= 0)
);

CREATE TABLE "subscriptions" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "user_id" uuid NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "plan_id" uuid NOT NULL REFERENCES "plans"("id"),
  "valid_until" timestamptz,
  "source" "subscription_source" DEFAULT 'manual' NOT NULL,
  "created_at" timestamptz DEFAULT now() NOT NULL
);

CREATE TABLE "twitch_tokens" (
  "channel_id" uuid PRIMARY KEY NOT NULL REFERENCES "channels"("id") ON DELETE CASCADE,
  "access_token_ciphertext" text NOT NULL,
  "refresh_token_ciphertext" text NOT NULL,
  "encryption_iv" text NOT NULL,
  "encryption_tag" text NOT NULL,
  "scopes" text[] DEFAULT ARRAY[]::text[] NOT NULL,
  "expires_at" timestamptz NOT NULL,
  "updated_at" timestamptz DEFAULT now() NOT NULL
);

CREATE TABLE "events" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "channel_id" uuid NOT NULL REFERENCES "channels"("id") ON DELETE CASCADE,
  "type" "event_type" NOT NULL,
  "provider_event_id" text,
  "raw" jsonb NOT NULL,
  "received_at" timestamptz DEFAULT now() NOT NULL
);

CREATE TABLE "roasts" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "channel_id" uuid NOT NULL REFERENCES "channels"("id") ON DELETE CASCADE,
  "event_id" uuid NOT NULL REFERENCES "events"("id") ON DELETE RESTRICT,
  "source" "event_type" NOT NULL,
  "viewer_login" text,
  "input_text" text,
  "output_text" text,
  "status" "roast_status" DEFAULT 'queued' NOT NULL,
  "tone" "tone" NOT NULL,
  "voice" "voice" NOT NULL,
  "toxicity" integer NOT NULL,
  "tokens_in" integer DEFAULT 0 NOT NULL,
  "tokens_out" integer DEFAULT 0 NOT NULL,
  "tts_chars" integer DEFAULT 0 NOT NULL,
  "cost_usd" numeric(10,6) DEFAULT 0 NOT NULL,
  "latency_ms" integer,
  "error" text,
  "created_at" timestamptz DEFAULT now() NOT NULL,
  CONSTRAINT "roasts_toxicity_check" CHECK ("toxicity" BETWEEN 1 AND 5),
  CONSTRAINT "roasts_counters_check" CHECK ("tokens_in" >= 0 AND "tokens_out" >= 0 AND "tts_chars" >= 0),
  CONSTRAINT "roasts_latency_check" CHECK ("latency_ms" IS NULL OR "latency_ms" >= 0),
  CONSTRAINT "roasts_cost_check" CHECK ("cost_usd" >= 0)
);

CREATE TABLE "usage_monthly" (
  "channel_id" uuid NOT NULL REFERENCES "channels"("id") ON DELETE CASCADE,
  "month" char(7) NOT NULL,
  "roasts" integer DEFAULT 0 NOT NULL,
  "tokens_in" integer DEFAULT 0 NOT NULL,
  "tokens_out" integer DEFAULT 0 NOT NULL,
  "tts_chars" integer DEFAULT 0 NOT NULL,
  "cost_usd" numeric(12,6) DEFAULT 0 NOT NULL,
  "updated_at" timestamptz DEFAULT now() NOT NULL,
  CONSTRAINT "usage_monthly_channel_id_month_pk" PRIMARY KEY ("channel_id", "month"),
  CONSTRAINT "usage_monthly_month_check" CHECK ("month" ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'),
  CONSTRAINT "usage_monthly_counters_check" CHECK (
    "roasts" >= 0 AND "tokens_in" >= 0 AND "tokens_out" >= 0 AND
    "tts_chars" >= 0 AND "cost_usd" >= 0
  )
);

CREATE TABLE "gifted_quota" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "channel_id" uuid NOT NULL REFERENCES "channels"("id") ON DELETE CASCADE,
  "month" char(7) NOT NULL,
  "amount" integer NOT NULL,
  "used" integer DEFAULT 0 NOT NULL,
  "granted_by_user_id" uuid REFERENCES "users"("id") ON DELETE SET NULL,
  "reason" text,
  "created_at" timestamptz DEFAULT now() NOT NULL,
  CONSTRAINT "gifted_quota_month_check" CHECK ("month" ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'),
  CONSTRAINT "gifted_quota_amount_check" CHECK ("amount" > 0 AND "used" >= 0 AND "used" <= "amount")
);

CREATE TABLE "cooldown_state" (
  "channel_id" uuid NOT NULL REFERENCES "channels"("id") ON DELETE CASCADE,
  "scope" "cooldown_scope" NOT NULL,
  "subject_key" text NOT NULL,
  "next_allowed_at" timestamptz NOT NULL,
  "updated_at" timestamptz DEFAULT now() NOT NULL,
  CONSTRAINT "cooldown_state_channel_id_scope_subject_key_pk" PRIMARY KEY ("channel_id", "scope", "subject_key"),
  CONSTRAINT "cooldown_state_subject_check" CHECK (
    ("scope" = 'channel' AND "subject_key" = '*') OR
    ("scope" = 'viewer' AND length("subject_key") > 0)
  )
);

CREATE TABLE "overlay_events" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "channel_id" uuid NOT NULL REFERENCES "channels"("id") ON DELETE CASCADE,
  "roast_id" uuid NOT NULL REFERENCES "roasts"("id") ON DELETE CASCADE,
  "payload" jsonb NOT NULL,
  "status" "overlay_event_status" DEFAULT 'pending' NOT NULL,
  "attempts" integer DEFAULT 0 NOT NULL,
  "available_at" timestamptz DEFAULT now() NOT NULL,
  "expires_at" timestamptz NOT NULL,
  "delivered_at" timestamptz,
  "created_at" timestamptz DEFAULT now() NOT NULL,
  CONSTRAINT "overlay_events_attempts_check" CHECK ("attempts" >= 0),
  CONSTRAINT "overlay_events_expiry_check" CHECK ("expires_at" > "created_at")
);

CREATE TABLE "audit_log" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "actor_user_id" uuid REFERENCES "users"("id") ON DELETE SET NULL,
  "action" text NOT NULL,
  "target" text NOT NULL,
  "payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "created_at" timestamptz DEFAULT now() NOT NULL
);

CREATE TABLE "global_settings" (
  "key" text PRIMARY KEY NOT NULL,
  "value" jsonb NOT NULL,
  "updated_at" timestamptz DEFAULT now() NOT NULL
);

CREATE UNIQUE INDEX "users_twitch_id_uidx" ON "users" ("twitch_id");
CREATE INDEX "users_login_idx" ON "users" ("login");
CREATE INDEX "users_status_idx" ON "users" ("status");
CREATE UNIQUE INDEX "channels_overlay_token_uidx" ON "channels" ("overlay_token");
CREATE INDEX "channels_user_id_idx" ON "channels" ("user_id");
CREATE INDEX "channels_twitch_login_idx" ON "channels" ("twitch_login");
CREATE UNIQUE INDEX "plans_code_uidx" ON "plans" ("code");
CREATE INDEX "subscriptions_user_valid_idx" ON "subscriptions" ("user_id", "valid_until");
CREATE INDEX "subscriptions_plan_id_idx" ON "subscriptions" ("plan_id");
CREATE INDEX "events_channel_received_idx" ON "events" ("channel_id", "received_at");
CREATE UNIQUE INDEX "events_provider_event_uidx"
  ON "events" ("channel_id", "provider_event_id")
  WHERE "provider_event_id" IS NOT NULL;
CREATE UNIQUE INDEX "roasts_event_id_uidx" ON "roasts" ("event_id");
CREATE INDEX "roasts_channel_created_idx" ON "roasts" ("channel_id", "created_at");
CREATE INDEX "roasts_status_created_idx" ON "roasts" ("status", "created_at");
CREATE INDEX "gifted_quota_channel_month_idx" ON "gifted_quota" ("channel_id", "month");
CREATE INDEX "cooldown_state_expiry_idx" ON "cooldown_state" ("next_allowed_at");
CREATE UNIQUE INDEX "overlay_events_roast_id_uidx" ON "overlay_events" ("roast_id");
CREATE INDEX "overlay_events_dispatch_idx"
  ON "overlay_events" ("channel_id", "status", "available_at");
CREATE INDEX "overlay_events_expires_idx" ON "overlay_events" ("expires_at");
CREATE INDEX "audit_log_actor_created_idx" ON "audit_log" ("actor_user_id", "created_at");
CREATE INDEX "audit_log_action_created_idx" ON "audit_log" ("action", "created_at");
