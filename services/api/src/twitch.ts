import type { ApiConfig } from "./config.js";

export interface TwitchTokenResponse {
  access_token: string;
  refresh_token: string;
  expires_in: number;
  scope: string[];
}

export interface TwitchUser {
  id: string;
  login: string;
  display_name: string;
}

export interface TwitchReward {
  id: string;
  title: string;
  cost: number;
  is_enabled: boolean;
  is_user_input_required: boolean;
}

export class TwitchApiError extends Error {
  constructor(
    readonly status: number,
    message: string
  ) {
    super(message);
  }
}

async function twitchRequest<T>(url: string, init: RequestInit): Promise<T> {
  const response = await fetch(url, { ...init, signal: AbortSignal.timeout(10_000) });
  if (!response.ok) {
    throw new TwitchApiError(response.status, `Twitch request failed: ${response.status}`);
  }
  return (await response.json()) as T;
}

export async function exchangeCode(code: string, config: ApiConfig): Promise<TwitchTokenResponse> {
  const body = new URLSearchParams({
    client_id: config.TWITCH_CLIENT_ID,
    client_secret: config.TWITCH_CLIENT_SECRET,
    code,
    grant_type: "authorization_code",
    redirect_uri: config.TWITCH_REDIRECT_URI
  });
  return twitchRequest("https://id.twitch.tv/oauth2/token", { method: "POST", body });
}

export async function refreshTwitchToken(
  refreshToken: string,
  config: Pick<ApiConfig, "TWITCH_CLIENT_ID" | "TWITCH_CLIENT_SECRET">
): Promise<TwitchTokenResponse> {
  const body = new URLSearchParams({
    client_id: config.TWITCH_CLIENT_ID,
    client_secret: config.TWITCH_CLIENT_SECRET,
    grant_type: "refresh_token",
    refresh_token: refreshToken
  });
  return twitchRequest("https://id.twitch.tv/oauth2/token", { method: "POST", body });
}

export async function getTwitchUser(accessToken: string, clientId: string): Promise<TwitchUser> {
  const result = await twitchRequest<{ data: TwitchUser[] }>("https://api.twitch.tv/helix/users", {
    headers: { Authorization: `Bearer ${accessToken}`, "Client-Id": clientId }
  });
  const user = result.data[0];
  if (!user) throw new Error("Twitch user response was empty");
  return user;
}

export async function getRewards(
  accessToken: string,
  clientId: string,
  broadcasterId: string
): Promise<TwitchReward[]> {
  const url = new URL("https://api.twitch.tv/helix/channel_points/custom_rewards");
  url.searchParams.set("broadcaster_id", broadcasterId);
  const result = await twitchRequest<{ data: TwitchReward[] }>(url.toString(), {
    headers: { Authorization: `Bearer ${accessToken}`, "Client-Id": clientId }
  });
  return result.data.map(({ id, title, cost, is_enabled, is_user_input_required }) => ({
    id,
    title,
    cost,
    is_enabled,
    is_user_input_required
  }));
}
