-- The twitch service listens on "channels_changed" and re-reads channels right away instead of
-- waiting for its minute-long poll: saved keywords, the power switch, an approval or a new login
-- with more scopes take effect within a second. Token refreshes that keep the scopes stay quiet.
CREATE FUNCTION "notify_channels_changed"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM pg_notify('channels_changed', '');
  RETURN NULL;
END
$$;
--> statement-breakpoint
CREATE TRIGGER "settings_changed" AFTER INSERT OR UPDATE OR DELETE ON "settings"
  FOR EACH STATEMENT EXECUTE FUNCTION "notify_channels_changed"();
--> statement-breakpoint
CREATE TRIGGER "users_status_changed" AFTER UPDATE OF "status" ON "users"
  FOR EACH STATEMENT EXECUTE FUNCTION "notify_channels_changed"();
--> statement-breakpoint
CREATE TRIGGER "twitch_tokens_added" AFTER INSERT ON "twitch_tokens"
  FOR EACH STATEMENT EXECUTE FUNCTION "notify_channels_changed"();
--> statement-breakpoint
CREATE TRIGGER "twitch_scopes_changed" AFTER UPDATE ON "twitch_tokens"
  FOR EACH ROW WHEN (OLD."scopes" IS DISTINCT FROM NEW."scopes")
  EXECUTE FUNCTION "notify_channels_changed"();
--> statement-breakpoint
CREATE TRIGGER "donationalerts_linked" AFTER INSERT OR DELETE ON "donationalerts_accounts"
  FOR EACH STATEMENT EXECUTE FUNCTION "notify_channels_changed"();
