import { describe, expect, it } from "vitest";

import { notificationOf, parseEventSubMessage } from "./eventsub.js";
import { eventRoast } from "./triggers.js";
import { DEFAULT_TRIGGERS } from "@roastbot/shared";

// A notification as Twitch sends it over the WebSocket transport (trimmed to the fields we read).
const raidMessage = JSON.stringify({
  metadata: {
    message_id: "befa7b53-d79d-478f-86b9-120f112b044e",
    message_type: "notification",
    message_timestamp: "2026-11-04T19:00:00.000Z",
    subscription_type: "channel.raid",
    subscription_version: "1"
  },
  payload: {
    subscription: { id: "sub-1", type: "channel.raid", version: "1" },
    event: {
      from_broadcaster_user_id: "1234",
      from_broadcaster_user_login: "raider",
      from_broadcaster_user_name: "Raider",
      to_broadcaster_user_id: "5678",
      to_broadcaster_user_login: "streamer",
      to_broadcaster_user_name: "Streamer",
      viewers: 12
    }
  }
});

describe("EventSub messages", () => {
  it("keeps the subscription type of a notification", () => {
    const notification = notificationOf(parseEventSubMessage(raidMessage), raidMessage);
    expect(notification).toMatchObject({
      subscriptionType: "channel.raid",
      messageId: "befa7b53-d79d-478f-86b9-120f112b044e",
      event: { from_broadcaster_user_login: "raider", viewers: 12 }
    });
  });

  it("turns a real raid notification into a roast", () => {
    const { subscriptionType, event } = notificationOf(
      parseEventSubMessage(raidMessage),
      raidMessage
    );
    const triggers = {
      ...DEFAULT_TRIGGERS,
      events: { ...DEFAULT_TRIGGERS.events, raid: { enabled: true, minViewers: 5 } }
    };
    expect(eventRoast(subscriptionType, event, triggers, "streamer")).toMatchObject({
      source: "raid",
      viewerLogin: "raider"
    });
  });

  it("parses keepalives and refuses a notification without its type", () => {
    const keepalive = JSON.stringify({
      metadata: { message_id: "k", message_type: "session_keepalive" },
      payload: {}
    });
    expect(parseEventSubMessage(keepalive).metadata.message_type).toBe("session_keepalive");
    const broken = JSON.stringify({
      metadata: { message_id: "n", message_type: "notification" },
      payload: { event: {} }
    });
    expect(() => notificationOf(parseEventSubMessage(broken), broken)).toThrow();
  });
});
