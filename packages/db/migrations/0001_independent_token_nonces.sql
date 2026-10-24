ALTER TABLE "twitch_tokens"
  ADD COLUMN "access_token_iv" text,
  ADD COLUMN "access_token_tag" text,
  ADD COLUMN "refresh_token_iv" text,
  ADD COLUMN "refresh_token_tag" text;

-- Existing installations cannot safely split a nonce/tag that was reused for two
-- values. Preserve it only to permit a rolling deploy; the next token refresh
-- immediately rewrites both values with independent nonces.
UPDATE "twitch_tokens" SET
  "access_token_iv" = "encryption_iv",
  "access_token_tag" = "encryption_tag",
  "refresh_token_iv" = "encryption_iv",
  "refresh_token_tag" = "encryption_tag";

ALTER TABLE "twitch_tokens"
  ALTER COLUMN "access_token_iv" SET NOT NULL,
  ALTER COLUMN "access_token_tag" SET NOT NULL,
  ALTER COLUMN "refresh_token_iv" SET NOT NULL,
  ALTER COLUMN "refresh_token_tag" SET NOT NULL,
  DROP COLUMN "encryption_iv",
  DROP COLUMN "encryption_tag";

DROP INDEX IF EXISTS "channels_user_id_idx";
CREATE UNIQUE INDEX "channels_user_id_uidx" ON "channels" ("user_id");
