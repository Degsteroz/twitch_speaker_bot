-- DonationAlerts connection per channel. Tokens are AES-256-GCM encrypted with
-- TOKEN_ENCRYPTION_KEY like the Twitch ones; da_user_id names the real-time donation channel.
CREATE TABLE "donationalerts_accounts" (
  "channel_id" uuid PRIMARY KEY NOT NULL REFERENCES "channels"("id") ON DELETE CASCADE,
  "da_user_id" text NOT NULL,
  "da_name" text NOT NULL,
  "access_token_ciphertext" text NOT NULL,
  "access_token_iv" text NOT NULL,
  "access_token_tag" text NOT NULL,
  "refresh_token_ciphertext" text NOT NULL,
  "refresh_token_iv" text NOT NULL,
  "refresh_token_tag" text NOT NULL,
  "expires_at" timestamptz NOT NULL,
  "connected_at" timestamptz DEFAULT now() NOT NULL,
  "updated_at" timestamptz DEFAULT now() NOT NULL
);
