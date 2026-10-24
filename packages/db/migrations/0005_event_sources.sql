-- New roast triggers: chat keywords, Twitch EventSub events and (later) DonationAlerts.
-- Values are only added here, not used: Drizzle migrates in one transaction and a new enum value
-- is unusable before commit.
ALTER TYPE "event_type" ADD VALUE IF NOT EXISTS 'chat_keyword';
ALTER TYPE "event_type" ADD VALUE IF NOT EXISTS 'cheer';
ALTER TYPE "event_type" ADD VALUE IF NOT EXISTS 'subscription';
ALTER TYPE "event_type" ADD VALUE IF NOT EXISTS 'gift_sub';
ALTER TYPE "event_type" ADD VALUE IF NOT EXISTS 'raid';
ALTER TYPE "event_type" ADD VALUE IF NOT EXISTS 'follow';
ALTER TYPE "event_type" ADD VALUE IF NOT EXISTS 'prediction';
ALTER TYPE "event_type" ADD VALUE IF NOT EXISTS 'ad_break';
ALTER TYPE "event_type" ADD VALUE IF NOT EXISTS 'donation';
