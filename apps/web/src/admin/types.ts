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
  elevenLabsLimit: number;
}

export interface PlanRow {
  code: "free" | "basic" | "premium";
  monthlyRoastLimit: number;
  premiumRoasts: number | null;
  economyModel: string;
  economyVoice: "yandex" | "piper";
  /** Telegram Stars for 30 days; null means not for sale. */
  starsPrice: number | null;
}

export interface Invite {
  login: string;
  created_at: string;
  used_at: string | null;
  used_by_login: string | null;
}
