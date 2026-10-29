import { UNLIMITED_MODEL, ZERO_REGRETS_MODEL, type RoastTier } from "@roastbot/shared";
import { describe, expect, it } from "vitest";

import { modelRequest } from "./models.js";
import { pickModel, type ModelChoice } from "./pipeline.js";

const base: ModelChoice = {
  source: "chat_command",
  toxicity: 3,
  unlimited: false,
  tier: "premium",
  economyModel: "economy",
  overrideModel: null,
  overrideChatModel: null,
  globalModel: "global",
  chatModel: "chat"
};

describe("pickModel", () => {
  const cases: [string, Partial<ModelChoice>, string][] = [
    ["the command on the premium tier gets the global model", {}, "global"],
    ["a chat word on the premium tier gets the chat model", { source: "chat_keyword" }, "chat"],
    ["the economy tier gets the plan's economy model", { tier: "economy" }, "economy"],
    [
      "the economy tier ignores the channel's model override",
      { tier: "economy", overrideModel: "mine" },
      "economy"
    ],
    ["the owner's override wins on the premium tier", { overrideModel: "mine" }, "mine"],
    [
      "the chat override answers chat words",
      { source: "chat_keyword", overrideChatModel: "mine-chat" },
      "mine-chat"
    ],
    ["an unlimited channel without overrides", { unlimited: true }, UNLIMITED_MODEL],
    [
      "an unlimited channel never drops to the cheap chat model",
      { unlimited: true, source: "chat_keyword" },
      UNLIMITED_MODEL
    ],
    [
      "an unlimited channel's chat override answers its chat words",
      { unlimited: true, source: "chat_keyword", overrideChatModel: "mine-chat" },
      "mine-chat"
    ],
    [
      "an unlimited channel's model override answers the rest",
      { unlimited: true, source: "reward", overrideModel: "mine", overrideChatModel: "mine-chat" },
      "mine"
    ],
    [
      "zero regrets sends the command to Sonnet even on the economy tier",
      { toxicity: 6, tier: "economy" },
      ZERO_REGRETS_MODEL
    ],
    [
      "zero regrets beats the owner's override for a reward",
      { toxicity: 6, source: "reward", overrideModel: "mine", unlimited: true },
      ZERO_REGRETS_MODEL
    ],
    [
      "zero regrets: a call by name goes to Sonnet",
      { toxicity: 6, source: "chat_keyword", named: true },
      ZERO_REGRETS_MODEL
    ],
    [
      "zero regrets: a plain chat word keeps the chat model",
      { toxicity: 6, source: "chat_keyword" },
      "chat"
    ],
    [
      "zero regrets: a sub stays on the global model",
      { toxicity: 6, source: "subscription" },
      "global"
    ]
  ];
  it.each(cases)("%s", (_name, choice, expected) => {
    expect(pickModel({ ...base, ...choice })).toBe(expected);
  });

  it("is the same for every tier when the channel is unlimited", () => {
    for (const tier of ["premium", "economy"] as RoastTier[]) {
      expect(pickModel({ ...base, unlimited: true, tier })).toBe(UNLIMITED_MODEL);
    }
  });
});

describe("modelRequest", () => {
  it("turns thinking off on Haiku and keeps the one-word classifier reply short", () => {
    const request = modelRequest("claude-haiku-5-5", "classify", "system", "user");
    expect(request.thinking).toEqual({ type: "disabled" });
    expect(request.max_tokens).toBe(16);
    expect(request).not.toHaveProperty("output_config");
  });

  it("gives models that always think low effort and headroom", () => {
    for (const model of ["claude-sonnet-5-5", "claude-opus-5-5", "claude-fable-5-1"]) {
      const request = modelRequest(model, "generate", "system", "user");
      expect(request.output_config).toEqual({ effort: "low" });
      expect(request.max_tokens).toBe(2_000);
      expect(request).not.toHaveProperty("thinking");
    }
  });

  it("never sends temperature", () => {
    for (const model of ["claude-haiku-5-5", "claude-sonnet-5-5", "claude-opus-5-5"]) {
      expect(modelRequest(model, "generate", "system", "user")).not.toHaveProperty("temperature");
    }
  });

  it("marks every system block but the last as a cache breakpoint", () => {
    const request = modelRequest("claude-haiku-5-5", "generate", ["a", "b", "c"], "user");
    expect(request.system).toEqual([
      { type: "text", text: "a", cache_control: { type: "ephemeral" } },
      { type: "text", text: "b", cache_control: { type: "ephemeral" } },
      { type: "text", text: "c" }
    ]);
  });
});
