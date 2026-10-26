-- Cheaper paid plans with smaller quotas; the monthly limits themselves come from the seed.
-- Break-even at full use: a premium roast costs up to $0.02, an economy one $0.004, a Star
-- pays out about $0.0124 after exchange.
-- Basic: 50 premium + 250 economy = $2.0 → 161 → 170 Stars.
-- Premium: 300 premium + 1200 economy = $10.8 → 871 → 900 Stars.
-- Only the defaults of 0014 are replaced: values the owner set in /admin stay.
UPDATE "plans" SET "stars_price" = 170 WHERE "code" = 'basic' AND "stars_price" = 600;
--> statement-breakpoint
UPDATE "plans" SET "premium_roasts" = 50 WHERE "code" = 'basic' AND "premium_roasts" = 200;
--> statement-breakpoint
UPDATE "plans" SET "stars_price" = 900 WHERE "code" = 'premium' AND "stars_price" = 3000;
--> statement-breakpoint
UPDATE "plans" SET "premium_roasts" = 300 WHERE "code" = 'premium' AND "premium_roasts" = 1000;
