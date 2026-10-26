-- Growth and payments: invite links that may grant a plan, the streamer's Telegram bot,
-- viewers who opt out of roasts, best roasts for the landing page, Telegram Stars plans.
ALTER TYPE "subscription_source" ADD VALUE IF NOT EXISTS 'invite';
--> statement-breakpoint
ALTER TYPE "subscription_source" ADD VALUE IF NOT EXISTS 'telegram_stars';
--> statement-breakpoint
CREATE TABLE "invite_links" (
  "code" text PRIMARY KEY NOT NULL,
  "note" text,
  "plan" "plan_code",
  "plan_days" integer,
  "max_uses" integer DEFAULT 1 NOT NULL,
  "uses" integer DEFAULT 0 NOT NULL,
  "expires_at" timestamptz,
  "revoked_at" timestamptz,
  "created_by_user_id" uuid REFERENCES "users"("id") ON DELETE SET NULL,
  "created_at" timestamptz DEFAULT now() NOT NULL,
  CONSTRAINT "invite_links_code_check" CHECK ("code" ~ '^[A-Za-z0-9_-]{8,64}$'),
  CONSTRAINT "invite_links_uses_check" CHECK ("max_uses" > 0 AND "uses" >= 0 AND "uses" <= "max_uses"),
  CONSTRAINT "invite_links_plan_check"
    CHECK (("plan" IS NULL AND "plan_days" IS NULL) OR ("plan" IS NOT NULL AND "plan_days" > 0))
);
--> statement-breakpoint
CREATE TABLE "invite_link_uses" (
  "code" text NOT NULL REFERENCES "invite_links"("code") ON DELETE CASCADE,
  "user_id" uuid NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "used_at" timestamptz DEFAULT now() NOT NULL,
  CONSTRAINT "invite_link_uses_pk" PRIMARY KEY ("code", "user_id")
);
--> statement-breakpoint
-- The streamer's chat with the bot; one per channel.
CREATE TABLE "telegram_accounts" (
  "channel_id" uuid PRIMARY KEY NOT NULL REFERENCES "channels"("id") ON DELETE CASCADE,
  "chat_id" bigint NOT NULL,
  "username" text,
  "linked_at" timestamptz DEFAULT now() NOT NULL,
  "last_summary_at" timestamptz
);
--> statement-breakpoint
-- One-time codes from the panel's "connect Telegram" button, stored only as SHA-256.
CREATE TABLE "telegram_link_tokens" (
  "token_hash" text PRIMARY KEY NOT NULL,
  "channel_id" uuid NOT NULL REFERENCES "channels"("id") ON DELETE CASCADE,
  "expires_at" timestamptz NOT NULL
);
--> statement-breakpoint
-- Each kind of notification once per period ("quota_80" per month, "eventsub:<type>" per day).
CREATE TABLE "notifications_sent" (
  "channel_id" uuid NOT NULL REFERENCES "channels"("id") ON DELETE CASCADE,
  "kind" text NOT NULL,
  "period" text NOT NULL,
  "sent_at" timestamptz DEFAULT now() NOT NULL,
  CONSTRAINT "notifications_sent_pk" PRIMARY KEY ("channel_id", "kind", "period")
);
--> statement-breakpoint
CREATE TABLE "viewer_optouts" (
  "channel_id" uuid NOT NULL REFERENCES "channels"("id") ON DELETE CASCADE,
  "viewer_login" text NOT NULL,
  "created_at" timestamptz DEFAULT now() NOT NULL,
  CONSTRAINT "viewer_optouts_pk" PRIMARY KEY ("channel_id", "viewer_login")
);
--> statement-breakpoint
-- The streamer stars a roast; the owner approves it for the landing page.
ALTER TABLE "roasts" ADD COLUMN "favorite_at" timestamptz;
--> statement-breakpoint
ALTER TABLE "roasts" ADD COLUMN "showcase_approved_at" timestamptz;
--> statement-breakpoint
CREATE INDEX "roasts_favorite_idx" ON "roasts" ("favorite_at") WHERE "favorite_at" IS NOT NULL;
--> statement-breakpoint
-- Telegram Stars price of a 30-day plan; null means it is not for sale.
ALTER TABLE "plans" ADD COLUMN "stars_price" integer;
--> statement-breakpoint
ALTER TABLE "plans" ADD CONSTRAINT "plans_stars_price_check"
  CHECK ("stars_price" IS NULL OR "stars_price" BETWEEN 1 AND 10000);
--> statement-breakpoint
-- Break-even at full use (see README «Оплата звёздами»): a paid roast costs up to $0.02 on the
-- premium pair and $0.004 on the economy one, a Star pays out about $0.0124 after exchange.
-- Basic: 200 premium + 800 economy = $7.2 → 600 Stars. Premium: 1000 + 4000 = $36 → 3000 Stars.
UPDATE "plans" SET "stars_price" = 600, "premium_roasts" = 200 WHERE "code" = 'basic';
--> statement-breakpoint
UPDATE "plans" SET "stars_price" = 3000, "premium_roasts" = 1000 WHERE "code" = 'premium';
--> statement-breakpoint
CREATE TABLE "star_payments" (
  "charge_id" text PRIMARY KEY NOT NULL,
  "channel_id" uuid REFERENCES "channels"("id") ON DELETE SET NULL,
  "plan" "plan_code" NOT NULL,
  "stars" integer NOT NULL,
  "telegram_user_id" bigint NOT NULL,
  "recurring" boolean DEFAULT false NOT NULL,
  "valid_until" timestamptz NOT NULL,
  "subscription_id" uuid REFERENCES "subscriptions"("id") ON DELETE SET NULL,
  "refunded_at" timestamptz,
  "created_at" timestamptz DEFAULT now() NOT NULL,
  CONSTRAINT "star_payments_stars_check" CHECK ("stars" > 0)
);
--> statement-breakpoint
CREATE INDEX "star_payments_created_idx" ON "star_payments" ("created_at");
