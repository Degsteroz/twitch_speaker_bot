// One EventSub WebSocket per channel, authorized by the channel's own token: the session, its
// keepalive watchdog, reconnects and the subscriptions created on welcome. What a notification
// means is the caller's business.
import WebSocket from "ws";
import { z } from "zod";

import { specsKey, type Channel } from "./channels.js";
import { reconnectDelayMs } from "./core.js";
import type { SubscriptionSpec } from "./triggers.js";

export interface EventSubHooks {
  wsUrl: string;
  subscriptionsUrl: string;
  clientId: string;
  accessToken: (channel: Channel) => Promise<string>;
  /** Twitch's answer per subscription type ("ok" or the reason), after each welcome. */
  subscribed: (channel: Channel, results: Record<string, string>) => Promise<void>;
  disconnected: (channel: Channel) => Promise<void>;
  notification: (
    channel: Channel,
    notification: {
      subscriptionType: string;
      event: Record<string, unknown>;
      messageId: string;
      raw: string;
    }
  ) => Promise<void>;
}

export class EventSubConnection {
  private socket?: WebSocket;
  private watchdog?: NodeJS.Timeout;
  private stopped = false;
  private keepaliveSeconds = 10;
  private failures = 0;
  private reconnectTimer?: NodeJS.Timeout;

  constructor(
    private channel: Channel,
    private readonly hooks: EventSubHooks
  ) {}

  get key(): string {
    return specsKey(this.channel);
  }

  start(url = this.hooks.wsUrl, subscribeOnWelcome = true): void {
    if (this.stopped) return;
    const socket = new WebSocket(url);
    this.socket = socket;
    socket.on(
      "message",
      (data) =>
        void this.onMessage(
          Array.isArray(data)
            ? Buffer.concat(data).toString("utf8")
            : Buffer.from(data instanceof ArrayBuffer ? new Uint8Array(data) : data).toString(
                "utf8"
              ),
          subscribeOnWelcome
        ).catch((error) => {
          console.error(`EventSub ${this.channel.twitchLogin}:`, error);
          socket.close();
        })
    );
    socket.on("close", () => {
      if (this.socket !== socket || this.stopped) return;
      void this.hooks.disconnected(this.channel).catch(console.error);
      const delay = reconnectDelayMs(this.failures++);
      this.reconnectTimer = setTimeout(() => this.start(), delay);
    });
    socket.on("error", (error) => console.error(`EventSub ${this.channel.twitchLogin}:`, error));
  }

  update(channel: Channel): void {
    this.channel = channel;
  }

  stop(): void {
    this.stopped = true;
    if (this.watchdog) clearTimeout(this.watchdog);
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.socket?.close();
  }

  private armWatchdog(seconds: number): void {
    if (this.watchdog) clearTimeout(this.watchdog);
    this.watchdog = setTimeout(() => this.socket?.terminate(), (seconds + 10) * 1000);
  }

  private async onMessage(raw: string, subscribeOnWelcome: boolean): Promise<void> {
    const message = z
      .object({
        metadata: z.object({ message_type: z.string(), message_id: z.string() }),
        payload: z.record(z.string(), z.unknown())
      })
      .passthrough()
      .parse(JSON.parse(raw));
    const type = message.metadata.message_type;
    if (type === "session_welcome") {
      const session = z
        .object({ id: z.string(), keepalive_timeout_seconds: z.number() })
        .parse((message.payload as { session?: unknown }).session);
      this.keepaliveSeconds = session.keepalive_timeout_seconds;
      this.armWatchdog(this.keepaliveSeconds);
      if (subscribeOnWelcome) {
        const results: Record<string, string> = {};
        for (const spec of this.channel.specs) {
          results[spec.type] = await this.subscribe(session.id, spec);
        }
        await this.hooks.subscribed(this.channel, results);
      }
      this.failures = 0;
      return;
    }
    if (type === "session_keepalive") {
      this.armWatchdog(this.keepaliveSeconds);
      return;
    }
    if (type === "session_reconnect") {
      const reconnect = z
        .object({ reconnect_url: z.string().url() })
        .parse((message.payload as { session?: unknown }).session);
      const previous = this.socket;
      this.start(reconnect.reconnect_url, false);
      setTimeout(() => previous?.close(), 1_000);
      return;
    }
    if (type === "revocation") {
      console.error(`EventSub subscription revoked for ${this.channel.twitchLogin}`);
      this.socket?.close();
      return;
    }
    if (type !== "notification") return;
    const subscriptionType = z
      .object({ subscription_type: z.string() })
      .parse(message.metadata).subscription_type;
    const event = z
      .record(z.string(), z.unknown())
      .parse((message.payload as { event?: unknown }).event);
    await this.hooks.notification(this.channel, {
      subscriptionType,
      event,
      messageId: message.metadata.message_id,
      raw
    });
  }

  /** "ok", or Twitch's status and message, for the panel. */
  private async subscribe(
    sessionId: string,
    spec: SubscriptionSpec,
    retryUnauthorized = true
  ): Promise<string> {
    const token = await this.hooks.accessToken(this.channel);
    const response = await fetch(this.hooks.subscriptionsUrl, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Client-Id": this.hooks.clientId,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        type: spec.type,
        version: spec.version,
        condition: spec.condition,
        transport: { method: "websocket", session_id: sessionId }
      })
    });
    if (response.status === 401 && retryUnauthorized) {
      this.channel.expiresAt = new Date(0);
      return this.subscribe(sessionId, spec, false);
    }
    if (response.ok) return "ok";
    // One rejected event type (e.g. a scope revoked on Twitch's side) must not take down the
    // others on this connection.
    const body = (await response.json().catch(() => ({}))) as { message?: unknown };
    const reason = `${String(response.status)}${typeof body.message === "string" ? ` ${body.message}` : ""}`;
    console.error(`EventSub ${this.channel.twitchLogin}: ${spec.type} rejected (${reason})`);
    return reason.slice(0, 200);
  }
}
