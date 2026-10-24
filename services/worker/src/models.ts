import type Anthropic from "@anthropic-ai/sdk";

// Models that always think: `thinking: {type: "disabled"}` is a 400 on Opus 5.5, Sonnet 5.5 and
// Fable 5.x, so effort "low" keeps a one-line reply quick, and max_tokens leaves room for the
// thinking that counts against it. Haiku 5.5 can still switch thinking off.
const ALWAYS_THINKING = /^claude-(?:opus-5|sonnet-5-5|fable-5)/u;
// Models that accept the server-side refusal fallback ("default" routes by refusal category).
const SERVER_FALLBACK = /^claude-(?:opus-5|sonnet-5-5|fable-5-1)/u;
const FALLBACK_BETA = "server-side-fallback-2026-07-01";

type Kind = "generate" | "classify";
// The visible text is one or two sentences (or one word for the classifier); the rest is headroom
// for thinking on the models that cannot turn it off.
const MAX_TOKENS: Record<Kind, { plain: number; thinking: number }> = {
  generate: { plain: 300, thinking: 2_000 },
  classify: { plain: 16, thinking: 1_000 }
};

export type ModelRequest = Anthropic.Beta.MessageCreateParamsNonStreaming;

/** One Messages request for the roast or the classifier, with the knobs this model accepts. */
export function modelRequest(
  model: string,
  kind: Kind,
  system: string,
  user: string
): ModelRequest {
  const thinks = ALWAYS_THINKING.test(model);
  return {
    model,
    max_tokens: thinks ? MAX_TOKENS[kind].thinking : MAX_TOKENS[kind].plain,
    ...(thinks ? { output_config: { effort: "low" } } : { thinking: { type: "disabled" } }),
    ...(SERVER_FALLBACK.test(model) ? { betas: [FALLBACK_BETA], fallbacks: "default" } : {}),
    system,
    messages: [{ role: "user", content: user }]
  };
}
