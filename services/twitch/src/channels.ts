// The channels the service listens to, their Twitch tokens and their current category.
import { gameContext, triggerSettingsSchema, type TriggerSettings } from "@roastbot/shared";
import { z } from "zod";

import type { Sql, TwitchConfig } from "./config.js";
import { decryptToken, encryptToken } from "./core.js";
import { subscriptionSpecs, type SubscriptionSpec } from "./triggers.js";

interface ChannelRow {
  id: string;
  twitchId: string;
  twitchLogin: string;
  triggers: unknown;
  scopes: string[];
  planCode: string | null;
  /** The owner's channel or an unlimited favourite: no frequency, pauses or plan gates. */
  unlimited: boolean;
  /** The premium character's name on this channel, when she is usable. */
  characterName: string | null;
  accessCiphertext: string;
  accessIv: string;
  accessTag: string;
  refreshCiphertext: string;
  refreshIv: string;
  refreshTag: string;
  expiresAt: Date;
}

export interface Channel extends Omit<ChannelRow, "triggers"> {
  triggers: TriggerSettings;
  /** EventSub subscriptions this channel needs; empty means no EventSub connection. */
  specs: SubscriptionSpec[];
}

export async function activeChannels(sql: Sql): Promise<Channel[]> {
  const rows = await sql<ChannelRow[]>`
    select c.id,c.twitch_login "twitchLogin",u.twitch_id "twitchId",s.triggers,t.scopes,
      t.access_token_ciphertext "accessCiphertext",
      t.access_token_iv "accessIv",t.access_token_tag "accessTag",
      t.refresh_token_ciphertext "refreshCiphertext",t.refresh_token_iv "refreshIv",
      t.refresh_token_tag "refreshTag",t.expires_at "expiresAt",p.code "planCode",
      (u.role='owner' or coalesce(o.unlimited,false)) unlimited,
      coalesce(s.character_name, ch.name) "characterName"
    from channels c join users u on u.id=c.user_id join settings s on s.channel_id=c.id
    join twitch_tokens t on t.channel_id=c.id
    left join characters ch on ch.id=s.character_id and ch.image_hash is not null
      and (ch.author_channel_id=c.id or ch.status='published')
    left join lateral (
      select sub.plan_id from subscriptions sub
      where sub.user_id=u.id and (sub.valid_until is null or sub.valid_until>now())
      order by sub.created_at desc limit 1
    ) sub on true
    left join plans p on p.id=sub.plan_id
    left join channel_overrides o on o.channel_id=c.id
    where u.status='active' and s.enabled=true`;
  return rows.flatMap((row) => {
    // Rows saved before newer trigger fields existed are completed with defaults here.
    const parsed = triggerSettingsSchema.safeParse(row.triggers ?? {});
    if (!parsed.success) {
      console.error(`Invalid trigger settings for ${row.twitchLogin}; channel skipped`);
      return [];
    }
    const triggers = parsed.data;
    return [{ ...row, triggers, specs: subscriptionSpecs({ ...row, triggers }, row.scopes) }];
  });
}

export const specsKey = (channel: Channel) => JSON.stringify(channel.specs);

// The channel's category, for the prompt. One Helix call per channel per 10 minutes at most, and
// a failure only costs the context: the roast goes out without a game.
const GAME_TTL_MS = 10 * 60_000;

export function channelApi(sql: Sql, config: TwitchConfig) {
  const gameCache = new Map<string, { game: string | undefined; at: number }>();

  async function accessToken(channel: Channel): Promise<string> {
    if (channel.expiresAt.getTime() > Date.now() + 120_000) {
      return decryptToken(
        {
          ciphertext: channel.accessCiphertext,
          iv: channel.accessIv,
          tag: channel.accessTag
        },
        config.TOKEN_ENCRYPTION_KEY
      );
    }
    const refresh = decryptToken(
      {
        ciphertext: channel.refreshCiphertext,
        iv: channel.refreshIv,
        tag: channel.refreshTag
      },
      config.TOKEN_ENCRYPTION_KEY
    );
    const response = await fetch("https://id.twitch.tv/oauth2/token", {
      method: "POST",
      body: new URLSearchParams({
        client_id: config.TWITCH_CLIENT_ID,
        client_secret: config.TWITCH_CLIENT_SECRET,
        grant_type: "refresh_token",
        refresh_token: refresh
      })
    });
    if (!response.ok) throw new Error(`token_refresh_${response.status}`);
    const token = z
      .object({
        access_token: z.string(),
        refresh_token: z.string(),
        expires_in: z.number(),
        scope: z.array(z.string())
      })
      .parse(await response.json());
    const encryptedAccess = encryptToken(token.access_token, config.TOKEN_ENCRYPTION_KEY);
    const encryptedRefresh = encryptToken(token.refresh_token, config.TOKEN_ENCRYPTION_KEY);
    await sql`update twitch_tokens set access_token_ciphertext=${encryptedAccess.ciphertext},
      access_token_iv=${encryptedAccess.iv},access_token_tag=${encryptedAccess.tag},
      refresh_token_ciphertext=${encryptedRefresh.ciphertext},refresh_token_iv=${encryptedRefresh.iv},
      refresh_token_tag=${encryptedRefresh.tag},expires_at=now()+${token.expires_in}*interval '1 second',
      scopes=${token.scope},updated_at=now() where channel_id=${channel.id}`;
    channel.accessCiphertext = encryptedAccess.ciphertext;
    channel.accessIv = encryptedAccess.iv;
    channel.accessTag = encryptedAccess.tag;
    channel.refreshCiphertext = encryptedRefresh.ciphertext;
    channel.refreshIv = encryptedRefresh.iv;
    channel.refreshTag = encryptedRefresh.tag;
    channel.expiresAt = new Date(Date.now() + token.expires_in * 1000);
    return token.access_token;
  }

  async function channelGame(channel: Channel): Promise<string | undefined> {
    const cached = gameCache.get(channel.id);
    if (cached && Date.now() - cached.at < GAME_TTL_MS) return cached.game;
    let game: string | undefined;
    try {
      const response = await fetch(
        `https://api.twitch.tv/helix/channels?broadcaster_id=${encodeURIComponent(channel.twitchId)}`,
        {
          headers: {
            Authorization: `Bearer ${await accessToken(channel)}`,
            "Client-Id": config.TWITCH_CLIENT_ID
          },
          signal: AbortSignal.timeout(2_000)
        }
      );
      if (response.ok) {
        const body = (await response.json()) as { data?: { game_name?: unknown }[] };
        const name = body.data?.[0]?.game_name;
        game = gameContext(typeof name === "string" ? name : undefined);
      }
    } catch (error) {
      console.warn(`Twitch category for ${channel.twitchLogin}:`, error);
    }
    gameCache.set(channel.id, { game, at: Date.now() });
    return game;
  }

  return {
    accessToken,
    withGame: async (channel: Channel) => {
      const game = await channelGame(channel);
      return game ? { game } : {};
    }
  };
}
