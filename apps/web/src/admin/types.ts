// Rows the back-office API returns.

export interface UserRow {
  id: string;
  login: string;
  display_name: string;
  status: "active" | "suspended" | "pending";
  role: string;
  mfa_enabled: boolean;
  twitch_login: string | null;
  plan: string;
  valid_until: string | null;
  used: number;
  limit: number;
  gifted: number;
  cost_usd: number;
  enabled: boolean | null;
  created_at: string;
  /** The owner's channel or an unlimited favourite. */
  unlimited: boolean;
  /** The owner's exceptions to the plan for this channel; null: none. */
  override: ChannelOverride | null;
  premium_used: number;
  /** The plan's own values, shown next to the override fields. */
  plan_premium_roasts: number | null;
  plan_limit: number | null;
}

export interface ChannelOverride {
  unlimited: boolean;
  zeroRegrets: boolean;
  monthlyRoastLimit: number | null;
  premiumRoasts: number | null;
  minCooldownSec: number | null;
  model: string | null;
  chatModel: string | null;
  economyModel: string | null;
  economyVoice: "yandex" | null;
  /** The first voice of premium roasts; null starts at ElevenLabs. */
  bestVoice: "elevenlabs" | "inworld" | "yandex" | null;
  note: string | null;
}

export interface Roast {
  id: string;
  channel_id: string;
  twitch_login?: string;
  source: string;
  viewer_login: string | null;
  input_text: string | null;
  output_text: string | null;
  status: string;
  cost_usd: string;
  latency_ms: number | null;
  error: string | null;
  created_at: string;
  tier?: string | null;
  model?: string | null;
  voice_provider?: string | null;
}

export interface Overview {
  usersTotal: number;
  usersActive: number;
  usersPending: number;
  activeChannelsHour: number;
  roastsToday: number;
  errorsToday: number;
  blockedToday: number;
  skippedToday: number;
  roastsMonth: number;
  spentMonth: number;
  demoSpentMonth: number;
  demoToday: number;
  demoLimit: number;
  roastCap: number;
  budget: number;
  killSwitch: boolean;
  pendingModeration: number;
  yandexTtsSpentRub: number;
  yandexTtsLimitRub: number;
  elevenLabsChars: number;
  /** The owner's cap, never above the synced ElevenLabs plan. */
  elevenLabsLimit: number;
  /** When ElevenLabs resets its count; null before the first sync. */
  elevenLabsResetAt: string | null;
  /** The last time the worker read ElevenLabs' own count; null when it never could. */
  elevenLabsSyncedAt: string | null;
  inworldChars: number;
  inworldLimit: number;
  /** The landing demo's share of the ElevenLabs cap, already inside elevenLabsChars. */
  demoElevenLabsChars: number;
  demoElevenLabsLimit: number;
}

export interface PlanRow {
  code: "free" | "basic" | "premium";
  monthlyRoastLimit: number;
  premiumRoasts: number | null;
  economyModel: string;
  economyVoice: "yandex";
  /** Telegram Stars for 30 days; null means not for sale. */
  starsPrice: number | null;
}

export interface Invite {
  login: string;
  created_at: string;
  used_at: string | null;
  used_by_login: string | null;
}

export interface SpendGroup {
  kind: "roast" | "stub" | "failed" | "blocked";
  tier: string | null;
  model: string | null;
  voice: string | null;
  count: number;
  usd: number;
  chars: number;
}

export interface Spend {
  month: string;
  groups: SpendGroup[];
  reasons: { status: string; reason: string | null; count: number }[];
  days: { day: string; roasts: number; usd: number }[];
  usd: number;
  demoUsd: number;
  budget: number;
  /** The prepaid ElevenLabs plan at list price: inside `usd`, not paid on top. */
  elevenLabsUsd: number;
}

export interface ServerHealth {
  load: number[];
  cpus: number;
  memory: { total: number; free: number };
  disk: { total: number; free: number } | null;
  database: number;
  tables: { name: string; bytes: number }[];
  audio: { bytes: number; files: number } | null;
  uptimeSec: number;
}
