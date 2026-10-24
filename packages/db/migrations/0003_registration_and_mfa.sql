-- Manual registration: a new Twitch login lands in 'pending' until the owner approves it or
-- pre-approves the login with an invite. The value is only added here, not used: Drizzle runs
-- migrations in one transaction and a new enum value is unusable before commit.
ALTER TYPE "user_status" ADD VALUE IF NOT EXISTS 'pending';

-- TOTP second factor. The secret is AES-256-GCM encrypted with TOKEN_ENCRYPTION_KEY like the
-- Twitch tokens; totp_enabled_at stays null while enrollment is unconfirmed. totp_last_step
-- rejects a replay of an accepted code, recovery codes are stored as SHA-256 hashes only.
ALTER TABLE "users"
  ADD COLUMN "totp_secret_ciphertext" text,
  ADD COLUMN "totp_secret_iv" text,
  ADD COLUMN "totp_secret_tag" text,
  ADD COLUMN "totp_enabled_at" timestamptz,
  ADD COLUMN "totp_last_step" bigint,
  ADD COLUMN "mfa_recovery_hashes" text[] DEFAULT ARRAY[]::text[] NOT NULL,
  ADD COLUMN "mfa_failed_attempts" integer DEFAULT 0 NOT NULL,
  ADD COLUMN "mfa_locked_until" timestamptz;

CREATE TABLE "invites" (
  "login" text PRIMARY KEY NOT NULL,
  "created_by_user_id" uuid REFERENCES "users"("id") ON DELETE SET NULL,
  "used_by_user_id" uuid REFERENCES "users"("id") ON DELETE SET NULL,
  "used_at" timestamptz,
  "created_at" timestamptz DEFAULT now() NOT NULL,
  CONSTRAINT "invites_login_check" CHECK ("login" ~ '^[a-z0-9_]{3,25}$')
);
