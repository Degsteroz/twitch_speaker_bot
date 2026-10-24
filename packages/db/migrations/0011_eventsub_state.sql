-- What Twitch said to our EventSub subscriptions, per channel: the panel shows it, so a streamer
-- whose reward "does nothing" sees whether Twitch accepted the subscription at all.
CREATE TABLE "eventsub_state" (
  "channel_id" uuid PRIMARY KEY NOT NULL REFERENCES "channels"("id") ON DELETE CASCADE,
  "connected" boolean NOT NULL DEFAULT false,
  "subscriptions" jsonb NOT NULL DEFAULT '{}'::jsonb,
  "updated_at" timestamptz DEFAULT now() NOT NULL
);
