const API = (import.meta.env.VITE_API_URL as string | undefined)?.replace(/\/$/u, "") ?? "/api";

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
    public code?: string
  ) {
    super(message);
  }
}

// Answers that mean "the session changed under you": the app re-reads /me/session and shows
// the matching screen (2FA prompt, pending approval) instead of a broken page.
const SESSION_CHANGED_CODES = new Set(["mfa_required", "mfa_setup_required", "pending_approval"]);

export async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const headers = new Headers(init?.headers);
  if (init?.body !== undefined) headers.set("Content-Type", "application/json");
  const response = await fetch(`${API}${path}`, { ...init, credentials: "include", headers });
  if (!response.ok) {
    if (response.status === 401 && typeof window !== "undefined") {
      window.dispatchEvent(new Event("roastbot:session-expired"));
    }
    let message = `Ошибка API (${String(response.status)})`;
    let code: string | undefined;
    try {
      const body = (await response.json()) as {
        error?: string | { code?: string; message?: string };
      };
      message = typeof body.error === "string" ? body.error : (body.error?.message ?? message);
      code = typeof body.error === "string" ? undefined : body.error?.code;
    } catch {
      /* response is not JSON */
    }
    if (code && SESSION_CHANGED_CODES.has(code) && typeof window !== "undefined") {
      window.dispatchEvent(new Event("roastbot:session-changed"));
    }
    throw new ApiError(response.status, message, code);
  }
  return response.json() as Promise<T>;
}

export const authUrl = `${API}/auth/twitch`;
export const post = (body: unknown = {}): RequestInit => ({
  body: JSON.stringify(body),
  method: "POST"
});
export const put = (body: unknown): RequestInit => ({ body: JSON.stringify(body), method: "PUT" });
export const del = (): RequestInit => ({ method: "DELETE" });

export interface Session {
  userId: string;
  channelId: string;
  login: string;
  displayName: string;
  role: "owner" | "user";
  status: "active" | "suspended" | "pending";
  channelLogin: string;
  /** Withheld by the API until the account is approved and the second factor is confirmed. */
  overlayToken: string | null;
  mfaEnabled: boolean;
  /** 2FA is on but this login has not confirmed it yet. */
  mfaRequired: boolean;
  /** What /admin needs from the owner: enroll, confirm again (every 12 h) or nothing. */
  adminMfa: "ok" | "setup" | "verify";
  recoveryCodesLeft: number;
  /** Twitch scopes added after this channel logged in; non-empty means "log in again". */
  missingScopes: string[];
}
export interface Settings {
  tone: "tsundere" | "yandere";
  voice: "male" | "female";
  toxicity: 1 | 2 | 3 | 4 | 5;
  cooldownSec: number;
  userCooldownSec: number;
  triggers: Triggers;
  stopWords: string[];
  enabled: boolean;
}
export interface EventTriggers {
  cheer: { enabled: boolean; minBits: number };
  subscription: { enabled: boolean };
  giftSub: { enabled: boolean; minCount: number };
  raid: { enabled: boolean; minViewers: number };
  follow: { enabled: boolean; chancePercent: number };
  prediction: { enabled: boolean };
  adBreak: { enabled: boolean };
  donation: { enabled: boolean; minAmount: number };
}
export interface Triggers {
  command: boolean;
  rewardId: string | null;
  keywords: string[];
  keywordChancePercent: number;
  streamerTargetPercent: number;
  rewardMode: "verdict" | "roast";
  streamerLoyaltyPercent: number;
  events: EventTriggers;
}

// Mirrors DEFAULT_TRIGGERS in packages/shared: the API fills these in, the panel only needs them
// for rows saved before the fields existed.
export const DEFAULT_TRIGGERS: Triggers = {
  command: true,
  rewardId: null,
  keywords: [],
  keywordChancePercent: 30,
  streamerTargetPercent: 50,
  rewardMode: "verdict",
  streamerLoyaltyPercent: 50,
  events: {
    cheer: { enabled: false, minBits: 100 },
    subscription: { enabled: false },
    giftSub: { enabled: false, minCount: 1 },
    raid: { enabled: false, minViewers: 5 },
    follow: { enabled: false, chancePercent: 20 },
    prediction: { enabled: false },
    adBreak: { enabled: false },
    donation: { enabled: false, minAmount: 100 }
  }
};

export interface DonationAlertsStatus {
  configured: boolean;
  connected: boolean;
  name: string | null;
}
export const donationAlertsConnectUrl = `${API}/integrations/donationalerts/connect`;
export const DONATIONALERTS_RESULT_TEXT: Record<string, string> = {
  connected: "DonationAlerts подключён",
  denied: "Подключение DonationAlerts отменено",
  invalid_state: "Сессия подключения устарела, попробуйте ещё раз",
  login_required: "Войдите в RoastBot и попробуйте ещё раз",
  unavailable: "DonationAlerts не ответил, попробуйте позже",
  not_configured: "DonationAlerts не настроен на сервере"
};

export function normalizeTriggers(raw: unknown): Triggers {
  const value = (typeof raw === "object" && raw !== null ? raw : {}) as Partial<Triggers>;
  const events = (value.events ?? {}) as Partial<EventTriggers>;
  const merged = { ...DEFAULT_TRIGGERS, ...value };
  return {
    ...merged,
    events: Object.fromEntries(
      Object.entries(DEFAULT_TRIGGERS.events).map(([key, defaults]) => [
        key,
        { ...defaults, ...(events[key as keyof EventTriggers] ?? {}) }
      ])
    ) as unknown as EventTriggers
  };
}

export type BotState = "working" | "paused" | "limit" | "suspended";
export interface Status {
  month: string;
  enabled: boolean;
  used: number;
  limit: number;
  gifted: number;
  remaining: number;
  globalLimitReached: boolean;
  killSwitch: boolean;
  state: BotState;
}
export interface Reward {
  id: string;
  title: string;
  cost: number;
  is_enabled: boolean;
  is_user_input_required: boolean;
}
export interface RewardsResponse {
  available: boolean;
  reason?: "not_affiliate" | "reauth_required" | "twitch_unavailable";
  rewards: Reward[];
}
export interface RoastResult {
  id: string;
  status: "queued" | "blocked_input" | "blocked_output" | "done" | "failed" | "skipped";
  outputText: string | null;
  error: string | null;
  latencyMs: number | null;
  overlayStatus: "pending" | "delivered" | "expired" | null;
}

export function normalizeSettings(row: Record<string, unknown>): Settings {
  return {
    tone: row.tone as Settings["tone"],
    voice: row.voice as Settings["voice"],
    toxicity: Number(row.toxicity) as Settings["toxicity"],
    cooldownSec: Number(row.cooldown_sec),
    userCooldownSec: Number(row.user_cooldown_sec),
    triggers: normalizeTriggers(row.triggers),
    stopWords: row.stop_words as string[],
    enabled: Boolean(row.enabled)
  };
}

/** OBS needs an absolute URL; a relative VITE_OVERLAY_URL is resolved against the dashboard. */
export function overlayUrl(
  token: string,
  origin: string = location.origin,
  configured: string | undefined = import.meta.env.VITE_OVERLAY_URL as string | undefined
): string {
  const base = new URL(configured ?? "http://localhost:5174/overlay/", origin);
  if (!base.pathname.endsWith("/")) base.pathname = `${base.pathname}/`;
  base.search = "";
  base.searchParams.set("token", token);
  return base.toString();
}

export const STATE_TEXT: Record<BotState, { pill: string; title: string }> = {
  working: { pill: "РАБОТАЕТ", title: "Бот в эфире" },
  paused: { pill: "НА ПАУЗЕ", title: "Бот сейчас молчит" },
  limit: { pill: "ЛИМИТ ИСЧЕРПАН", title: "Квота закончилась" },
  suspended: { pill: "ПРИОСТАНОВЛЕН", title: "Аккаунт приостановлен" }
};

export const REWARD_REASON_TEXT: Record<NonNullable<RewardsResponse["reason"]>, string> = {
  not_affiliate:
    "Награды за баллы доступны только компаньонам и партнёрам Twitch. Работает команда !роаст.",
  reauth_required: "Twitch отозвал доступ. Выйдите и войдите снова, чтобы выбрать награду.",
  twitch_unavailable: "Twitch сейчас не отвечает. Попробуйте обновить список позже."
};

export const ROAST_STATUS_TEXT: Record<RoastResult["status"], string> = {
  queued: "в очереди",
  done: "готово",
  blocked_input: "вход заблокирован стоп-листом",
  blocked_output: "ответ заблокирован, озвучена заглушка",
  failed: "ошибка генерации",
  skipped: "пропущен"
};

export const SKIP_REASON_TEXT: Record<string, string> = {
  channel_disabled: "бот выключен",
  user_suspended: "аккаунт приостановлен",
  no_active_plan: "нет активного тарифа",
  global_kill_switch: "генерация остановлена владельцем сервиса",
  global_quota_exceeded: "исчерпан общий лимит сервиса",
  global_budget_exceeded: "исчерпан месячный бюджет сервиса",
  channel_quota_exceeded: "квота канала закончилась",
  cooldown_active: "действует кулдаун",
  stale_job: "задача устарела"
};
