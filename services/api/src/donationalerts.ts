import { DONATIONALERTS_SCOPES } from "@roastbot/shared";

const AUTHORIZE_URL = "https://www.donationalerts.com/oauth/authorize";
const TOKEN_URL = "https://www.donationalerts.com/oauth/token";
const USER_URL = "https://www.donationalerts.com/api/v1/user/oauth";

export interface DonationAlertsConfig {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
}

export interface DonationAlertsToken {
  access_token: string;
  refresh_token: string;
  expires_in: number;
}

export interface DonationAlertsUser {
  id: number;
  name: string;
}

export class DonationAlertsError extends Error {
  constructor(readonly status: number) {
    super(`DonationAlerts request failed: ${String(status)}`);
  }
}

export function authorizeUrl(config: DonationAlertsConfig, state: string): string {
  const url = new URL(AUTHORIZE_URL);
  url.search = new URLSearchParams({
    client_id: config.clientId,
    redirect_uri: config.redirectUri,
    response_type: "code",
    scope: DONATIONALERTS_SCOPES.join(" "),
    state
  }).toString();
  return url.toString();
}

export async function exchangeCode(
  config: DonationAlertsConfig,
  code: string
): Promise<DonationAlertsToken> {
  const response = await fetch(TOKEN_URL, {
    method: "POST",
    body: new URLSearchParams({
      grant_type: "authorization_code",
      client_id: config.clientId,
      client_secret: config.clientSecret,
      redirect_uri: config.redirectUri,
      code
    }),
    signal: AbortSignal.timeout(10_000)
  });
  if (!response.ok) throw new DonationAlertsError(response.status);
  return (await response.json()) as DonationAlertsToken;
}

export async function getUser(accessToken: string): Promise<DonationAlertsUser> {
  const response = await fetch(USER_URL, {
    headers: { Authorization: `Bearer ${accessToken}` },
    signal: AbortSignal.timeout(10_000)
  });
  if (!response.ok) throw new DonationAlertsError(response.status);
  // Documented as wrapped in `data`; accept a bare object too.
  const body = (await response.json()) as {
    data?: DonationAlertsUser;
  } & Partial<DonationAlertsUser>;
  const user = body.data ?? body;
  if (!user.id) throw new Error("DonationAlerts user response was empty");
  return { id: user.id, name: user.name ?? String(user.id) };
}
