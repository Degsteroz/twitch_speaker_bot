-- Hard monthly cap for paid speech synthesis. The worker reserves requests here with one atomic
-- upsert before calling the provider, so concurrent roasts can never overshoot the limit.
CREATE TABLE "tts_usage_monthly" (
  "provider" text NOT NULL,
  "month" char(7) NOT NULL,
  "requests" integer DEFAULT 0 NOT NULL,
  "updated_at" timestamptz DEFAULT now() NOT NULL,
  CONSTRAINT "tts_usage_monthly_pkey" PRIMARY KEY ("provider", "month"),
  CONSTRAINT "tts_usage_monthly_month_check" CHECK ("month" ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'),
  CONSTRAINT "tts_usage_monthly_requests_check" CHECK ("requests" >= 0)
);
