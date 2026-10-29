// The channel's own Twitch token for Helix calls from the panel, refreshed when it is close to
// expiry (or on demand after a 401) and stored back encrypted.
import type { ApiConfig } from "./config.js";
import type { Sql } from "./context.js";
import { decryptValue, encryptValue } from "./security.js";
import { refreshTwitchToken } from "./twitch.js";

interface TokenRow {
  twitch_id: string;
  access_token_ciphertext: string;
  access_token_iv: string;
  access_token_tag: string;
  refresh_token_ciphertext: string;
  refresh_token_iv: string;
  refresh_token_tag: string;
  expires_at: Date;
}

export async function channelAccessToken(
  sql: Sql,
  config: ApiConfig,
  channelId: string,
  forceRefresh = false
) {
  const [row] = await sql<TokenRow[]>`
    select u.twitch_id, t.* from twitch_tokens t join channels c on c.id=t.channel_id
    join users u on u.id=c.user_id where c.id=${channelId}`;
  if (!row) return undefined;
  if (!forceRefresh && row.expires_at.getTime() > Date.now() + 120_000) {
    const token = decryptValue(
      {
        ciphertext: row.access_token_ciphertext,
        iv: row.access_token_iv,
        tag: row.access_token_tag
      },
      config.TOKEN_ENCRYPTION_KEY
    );
    return { token, twitchId: row.twitch_id };
  }
  const refreshPlaintext = decryptValue(
    {
      ciphertext: row.refresh_token_ciphertext,
      iv: row.refresh_token_iv,
      tag: row.refresh_token_tag
    },
    config.TOKEN_ENCRYPTION_KEY
  );
  const refreshed = await refreshTwitchToken(refreshPlaintext, config);
  const access = encryptValue(refreshed.access_token, config.TOKEN_ENCRYPTION_KEY);
  const refresh = encryptValue(refreshed.refresh_token, config.TOKEN_ENCRYPTION_KEY);
  await sql`update twitch_tokens set access_token_ciphertext=${access.ciphertext},
    access_token_iv=${access.iv},access_token_tag=${access.tag},
    refresh_token_ciphertext=${refresh.ciphertext},refresh_token_iv=${refresh.iv},
    refresh_token_tag=${refresh.tag},scopes=${refreshed.scope},
    expires_at=now()+${refreshed.expires_in}*interval '1 second',updated_at=now()
    where channel_id=${channelId}`;
  return { token: refreshed.access_token, twitchId: row.twitch_id };
}
