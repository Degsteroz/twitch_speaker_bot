-- Haiku 5.5 missed the meaning of viewer messages: Opus 5.5 writes the roast, Sonnet 5.5 checks
-- it. Only the old defaults are replaced; a model the owner picked in /admin stays. The budget
-- guard follows the owner's new $10 provider limit when it still holds the old $5 default.
UPDATE "global_settings" SET "value" = '"claude-opus-5-5"'::jsonb
  WHERE "key" = 'model' AND "value" = '"claude-haiku-5-5"'::jsonb;
--> statement-breakpoint
UPDATE "global_settings" SET "value" = '"claude-sonnet-5-5"'::jsonb
  WHERE "key" = 'classifier_model' AND "value" = '"claude-haiku-5-5"'::jsonb;
--> statement-breakpoint
UPDATE "global_settings" SET "value" = '10'::jsonb
  WHERE "key" = 'monthly_budget_usd' AND "value" = '5'::jsonb;
