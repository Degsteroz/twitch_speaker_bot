-- reserve() sums this month's usage of every channel under the one global lock, and the panel's
-- status and /admin read the same sum. The primary key leads with channel_id, so without this
-- index each of them scans every month of every channel.
CREATE INDEX IF NOT EXISTS "usage_monthly_month_idx" ON "usage_monthly" ("month");
