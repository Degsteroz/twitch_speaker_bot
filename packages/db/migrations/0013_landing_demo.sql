-- Landing demo: anonymous visitors try Ai a few times a day. The IP is stored only as an HMAC
-- with the day, the texts are redacted after a day; the cost stays for the monthly budget.
CREATE TABLE "demo_requests" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "ip_hash" text NOT NULL,
  "day" date NOT NULL,
  "input_text" text,
  "output_text" text,
  "status" text DEFAULT 'queued' NOT NULL,
  "error" text,
  "audio_file" text,
  "cost_usd" numeric(10, 6) DEFAULT '0' NOT NULL,
  "created_at" timestamptz DEFAULT now() NOT NULL,
  CONSTRAINT "demo_requests_status_check"
    CHECK ("status" IN ('queued', 'done', 'blocked', 'failed', 'skipped')),
  CONSTRAINT "demo_requests_cost_check" CHECK ("cost_usd" >= 0)
);
--> statement-breakpoint
CREATE INDEX "demo_requests_day_ip_idx" ON "demo_requests" ("day", "ip_hash");
--> statement-breakpoint
CREATE INDEX "demo_requests_created_idx" ON "demo_requests" ("created_at");
