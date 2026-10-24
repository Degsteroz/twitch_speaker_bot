import WebSocket from "ws";

import { decryptToken, encryptToken, reconnectDelayMs } from "./core.js";
import { extractDonations } from "./triggers.js";

const TOKEN_URL = "https://www.donationalerts.com/oauth/token";
const USER_URL = "https://www.donationalerts.com/api/v1/user/oauth";
const SUBSCRIBE_URL = "https://www.donationalerts.com/api/v1/centrifuge/subscribe";
const CENTRIFUGO_URL = "wss://centrifugo.donationalerts.com/connection/websocket";

export interface DonationAlertsAccount {
  channelId: string;
  daUserId: string;
  accessCiphertext: string;
  accessIv: string;
  accessTag: string;
  refreshCiphertext: string;
  refreshIv: string;
  refreshTag: string;
  expiresAt: Date;
}

export interface DonationAlertsDeps {
  clientId: string;
  clientSecret: string;
  encryptionKey: string;
  /** Persists refreshed, already encrypted tokens. */
  saveTokens: (
    channelId: string,
    tokens: Pick<
      DonationAlertsAccount,
      | "accessCiphertext"
      | "accessIv"
      | "accessTag"
      | "refreshCiphertext"
      | "refreshIv"
      | "refreshTag"
    > & { expiresInSeconds: number }
  ) => Promise<void>;
  onDonation: (donation: Record<string, unknown>) => Promise<void>;
  log: (message: string, error?: unknown) => void;
}

/**
 * One channel's real-time donation feed: refresh the token when needed, fetch the socket token,
 * connect to Centrifugo, subscribe to `$alerts:donation_<id>` and reconnect with backoff.
 */
export class DonationAlertsConnection {
  private socket?: WebSocket;
  private stopped = false;
  private failures = 0;
  private reconnectTimer?: NodeJS.Timeout;
  private readonly channel: string;

  constructor(
    private account: DonationAlertsAccount,
    private readonly deps: DonationAlertsDeps
  ) {
    this.channel = `$alerts:donation_${account.daUserId}`;
  }

  get daUserId(): string {
    return this.account.daUserId;
  }

  start(): void {
    void this.connect().catch((error: unknown) => {
      this.deps.log(`DonationAlerts ${this.account.channelId}: connect failed`, error);
      this.scheduleReconnect();
    });
  }

  stop(): void {
    this.stopped = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.socket?.close();
  }

  private scheduleReconnect(): void {
    if (this.stopped) return;
    this.reconnectTimer = setTimeout(() => this.start(), reconnectDelayMs(this.failures++));
  }

  private async accessToken(): Promise<string> {
    const { account, deps } = this;
    const decrypt = (ciphertext: string, iv: string, tag: string) =>
      decryptToken({ ciphertext, iv, tag }, deps.encryptionKey);
    if (account.expiresAt.getTime() > Date.now() + 5 * 60_000) {
      return decrypt(account.accessCiphertext, account.accessIv, account.accessTag);
    }
    const refreshToken = decrypt(account.refreshCiphertext, account.refreshIv, account.refreshTag);
    const response = await fetch(TOKEN_URL, {
      method: "POST",
      body: new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: refreshToken,
        client_id: deps.clientId,
        client_secret: deps.clientSecret,
        scope: "oauth-user-show oauth-donation-subscribe"
      }),
      signal: AbortSignal.timeout(10_000)
    });
    if (!response.ok) throw new Error(`donationalerts_refresh_${String(response.status)}`);
    const token = (await response.json()) as {
      access_token: string;
      refresh_token?: string;
      expires_in: number;
    };
    // The refresh response may omit refresh_token; the old one then stays valid.
    const access = encryptToken(token.access_token, deps.encryptionKey);
    const refresh = encryptToken(token.refresh_token ?? refreshToken, deps.encryptionKey);
    const tokens = {
      accessCiphertext: access.ciphertext,
      accessIv: access.iv,
      accessTag: access.tag,
      refreshCiphertext: refresh.ciphertext,
      refreshIv: refresh.iv,
      refreshTag: refresh.tag
    };
    await deps.saveTokens(account.channelId, { ...tokens, expiresInSeconds: token.expires_in });
    this.account = {
      ...account,
      ...tokens,
      expiresAt: new Date(Date.now() + token.expires_in * 1000)
    };
    return token.access_token;
  }

  private async connect(): Promise<void> {
    if (this.stopped) return;
    const accessToken = await this.accessToken();
    const user = await fetch(USER_URL, {
      headers: { Authorization: `Bearer ${accessToken}` },
      signal: AbortSignal.timeout(10_000)
    });
    if (!user.ok) throw new Error(`donationalerts_user_${String(user.status)}`);
    const profile = (await user.json()) as {
      data?: { socket_connection_token?: string };
      socket_connection_token?: string;
    };
    const socketToken = profile.data?.socket_connection_token ?? profile.socket_connection_token;
    if (!socketToken) throw new Error("donationalerts_no_socket_token");

    const socket = new WebSocket(CENTRIFUGO_URL);
    this.socket = socket;
    socket.on("open", () => socket.send(JSON.stringify({ params: { token: socketToken }, id: 1 })));
    socket.on("message", (data: Buffer) => {
      const frame = data.toString("utf8");
      void this.onFrame(socket, frame, accessToken).catch((error: unknown) => {
        this.deps.log(`DonationAlerts ${this.account.channelId}: frame failed`, error);
        socket.close();
      });
    });
    socket.on("close", () => {
      if (this.socket === socket) this.scheduleReconnect();
    });
    socket.on("error", (error) =>
      this.deps.log(`DonationAlerts ${this.account.channelId}: socket error`, error)
    );
  }

  private async onFrame(socket: WebSocket, frame: string, accessToken: string): Promise<void> {
    for (const line of frame.split("\n")) {
      if (!line.trim()) continue;
      const reply = JSON.parse(line) as { id?: number; result?: { client?: string } };
      if (reply.id === 1 && reply.result?.client) {
        // Connected: exchange the client id for a channel token, then subscribe.
        const response = await fetch(SUBSCRIBE_URL, {
          method: "POST",
          headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
          body: JSON.stringify({ channels: [this.channel], client: reply.result.client }),
          signal: AbortSignal.timeout(10_000)
        });
        if (!response.ok) throw new Error(`donationalerts_subscribe_${String(response.status)}`);
        const body = (await response.json()) as { channels?: { channel: string; token: string }[] };
        const channelToken = body.channels?.find((item) => item.channel === this.channel)?.token;
        if (!channelToken) throw new Error("donationalerts_no_channel_token");
        socket.send(
          JSON.stringify({
            params: { channel: this.channel, token: channelToken },
            method: 1,
            id: 2
          })
        );
        this.failures = 0;
      }
    }
    for (const donation of extractDonations(frame, this.channel))
      await this.deps.onDonation(donation);
  }
}
