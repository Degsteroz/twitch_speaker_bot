// What the model and voice calls of one roast cost, and booking it against the channel's month.
import type Anthropic from "@anthropic-ai/sdk";
import { calculateCostUsd, pricingForModel } from "@roastbot/prompts";

import type { Sql } from "./context.js";

export interface Spend {
  model: string;
  /** All input, cached or not. */
  tokensIn: number;
  tokensOut: number;
  /** The part of tokensIn written to and read from the prompt cache. */
  cacheWrite?: number;
  cacheRead?: number;
  /** Flat cost on top of tokens, e.g. a paid speech synthesis request. */
  fixedUsd?: number;
}

/** What a Messages response cost, with the cached part of the input billed at its own rates. */
export function spendOf(model: string, usage: Anthropic.Beta.BetaUsage): Spend {
  const cacheWrite = usage.cache_creation_input_tokens ?? 0;
  const cacheRead = usage.cache_read_input_tokens ?? 0;
  return {
    model,
    tokensIn: usage.input_tokens + cacheWrite + cacheRead,
    tokensOut: usage.output_tokens,
    cacheWrite,
    cacheRead
  };
}

export function textFrom(message: Anthropic.Beta.BetaMessage): string {
  return message.content
    .flatMap((block) => (block.type === "text" ? [block.text] : []))
    .join(" ")
    .trim();
}

export function costOf(spend: Spend): number {
  const cacheWrite = spend.cacheWrite ?? 0;
  const cacheRead = spend.cacheRead ?? 0;
  return (
    calculateCostUsd(
      {
        input: spend.tokensIn - cacheWrite - cacheRead,
        output: spend.tokensOut,
        cacheWrite,
        cacheRead
      },
      pricingForModel(spend.model)
    ) + (spend.fixedUsd ?? 0)
  );
}

export async function recordSpend(sql: Sql, channelId: string, month: string, spends: Spend[]) {
  const tokensIn = spends.reduce((sum, spend) => sum + spend.tokensIn, 0);
  const tokensOut = spends.reduce((sum, spend) => sum + spend.tokensOut, 0);
  const cost = spends.reduce((sum, spend) => sum + costOf(spend), 0);
  await sql`insert into usage_monthly(channel_id,month,tokens_in,tokens_out,cost_usd)
    values(${channelId},${month},${tokensIn},${tokensOut},${cost})
    on conflict(channel_id,month) do update set tokens_in=usage_monthly.tokens_in+excluded.tokens_in,
      tokens_out=usage_monthly.tokens_out+excluded.tokens_out,
      cost_usd=usage_monthly.cost_usd+excluded.cost_usd,updated_at=now()`;
  return { tokensIn, tokensOut, cost };
}
