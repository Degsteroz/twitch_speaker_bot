-- A plan change can switch `!роаст` on or off (it is a paid feature): the twitch service re-reads
-- channels right away, like it does for settings (see 0008).
CREATE TRIGGER "subscriptions_changed" AFTER INSERT OR UPDATE OR DELETE ON "subscriptions"
  FOR EACH STATEMENT EXECUTE FUNCTION "notify_channels_changed"();
