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
// the matching screen (2FA prompt, pending approval, suspension) instead of a broken page.
const SESSION_CHANGED_CODES = new Set([
  "mfa_required",
  "mfa_setup_required",
  "pending_approval",
  "account_suspended"
]);

export async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const headers = new Headers(init?.headers);
  if (init?.body !== undefined && !headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json");
  }
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
/** Mirrors CHARACTER_NAMES in packages/shared: the tone is the character's temperament. */
export const CHARACTER_NAMES = { tsundere: "Мицуки", yandere: "Аи" } as const;

// ---- Premium characters (mirrors packages/shared) ------------------------------------------
export type Archetype = "tsundere" | "yandere" | "kuudere" | "dandere" | "himedere";
export const ARCHETYPE_TEXT: Record<Archetype, { title: string; desc: string }> = {
  tsundere: { title: "Цундэрэ", desc: "колюче, а потом выдаёт, что ей не всё равно" },
  yandere: { title: "Яндэрэ", desc: "мило, ласково и слегка пугающе" },
  kuudere: { title: "Кудэрэ", desc: "ледяное спокойствие, сухие приговоры без эмоций" },
  dandere: { title: "Дандэрэ", desc: "тихая и стеснительная, но колет точнее всех" },
  himedere: { title: "Химэдэрэ", desc: "надменная принцесса, чат — её подданные" }
};
export type CharacterStatus = "private" | "pending" | "published" | "rejected";
export const CHARACTER_STATUS_TEXT: Record<CharacterStatus, string> = {
  private: "только у вас",
  pending: "на проверке для магазина",
  published: "в магазине",
  rejected: "не прошла проверку"
};
export interface CharacterView {
  id: string;
  name: string;
  archetype: Archetype;
  voiceId: string | null;
  voiceLabel: string | null;
  status: CharacterStatus;
  reviewNote: string | null;
  /** API path of the picture; null until uploaded. */
  imagePath: string | null;
  /** The author's Twitch login. */
  author: string;
  own: boolean;
}
export interface VoiceOption {
  id: string;
  label: string;
  description: string;
  sampleReady: boolean;
}
export interface CharactersResponse {
  /** The plan includes premium characters. */
  allowed: boolean;
  maxOwn: number;
  selected: { characterId: string | null; characterName: string | null };
  own: CharacterView[];
  shop: CharacterView[];
  voices: VoiceOption[];
}
/** An API path as a URL for <img> and <audio>. */
export const apiUrl = (path: string) => `${API}${path}`;
export const voiceSampleUrl = (id: string) => apiUrl(`/voices/${encodeURIComponent(id)}/sample`);
export const CHARACTER_IMAGE_TYPES = ["image/png", "image/jpeg", "image/webp"];
export const MAX_CHARACTER_UPLOAD_BYTES = 4 * 1024 * 1024;

/** Sends the picture as the raw body; the API re-encodes it. */
export const uploadCharacterImage = (id: string, file: File) =>
  api<{ id: string; imagePath: string }>(`/characters/${id}/image`, {
    method: "PUT",
    body: file,
    headers: { "Content-Type": file.type }
  });

export interface Settings {
  tone: "tsundere" | "yandere";
  voice: "male" | "female";
  toxicity: 1 | 2 | 3 | 4 | 5 | 6;
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
  donation: { enabled: boolean; minAmount: number; delaySec: number };
}
export type ChatFrequency = "rare" | "normal" | "often";
// Mirrors KEYWORD_EVERY and REWARD_EVERY in packages/shared.
export const KEYWORD_EVERY: Record<ChatFrequency, number> = { rare: 12, normal: 9, often: 6 };
export const REWARD_EVERY: Record<ChatFrequency, number> = { rare: 3, normal: 2, often: 1 };
export const DEFAULT_COMMAND = "!роаст";
export interface Triggers {
  command: boolean;
  /** The chat command, "!роаст" unless the streamer picked their own. */
  commandName: string;
  rewardId: string | null;
  keywords: string[];
  /** Chat words: every 12th, 9th or 6th; rewards: every 3rd, 2nd or each one. */
  chatFrequency: ChatFrequency;
  /** Premium character: her name in chat works like a keyword. */
  nameMention: boolean;
  /** Chat bots and spammers whose messages never trigger a roast; lowercase logins. */
  ignoredUsers: string[];
  /** Who is roasted on every trigger: the author, the streamer, or the character decides. */
  targetMode: "author" | "streamer" | "auto";
  events: EventTriggers;
}

// Mirrors DEFAULT_TRIGGERS in packages/shared: the API fills these in, the panel only needs them
// for rows saved before the fields existed.
export const DEFAULT_TRIGGERS: Triggers = {
  command: true,
  commandName: DEFAULT_COMMAND,
  rewardId: null,
  keywords: [],
  chatFrequency: "normal",
  nameMention: false,
  ignoredUsers: [],
  targetMode: "auto",
  events: {
    cheer: { enabled: false, minBits: 100 },
    subscription: { enabled: false },
    giftSub: { enabled: false, minCount: 1 },
    raid: { enabled: false, minViewers: 5 },
    follow: { enabled: false, chancePercent: 20 },
    prediction: { enabled: false },
    adBreak: { enabled: false },
    donation: { enabled: false, minAmount: 100, delaySec: 8 }
  }
};

/** "@Moo_Bot" → "moo_bot"; null for anything that cannot be a Twitch login. */
export function twitchLogin(text: string): string | null {
  const login = text.trim().replace(/^@/u, "").toLowerCase();
  return /^[a-z0-9_]{1,25}$/u.test(login) ? login : null;
}

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
  // Fields the API no longer accepts (the old verdict reward and target split) must not be sent
  // back on save: keep only the keys the panel knows.
  const current = Object.fromEntries(
    Object.entries(value).filter(([key]) => key in DEFAULT_TRIGGERS)
  ) as Partial<Triggers>;
  const merged = { ...DEFAULT_TRIGGERS, ...current };
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
  plan: string | null;
  /** The owner's channel or a favourite: no quota, pauses or test limit. */
  unlimited: boolean;
  /** The owner opened toxicity 6, "Ноль сожалений", for this channel. */
  zeroRegrets: boolean;
  /** `!роаст` is a paid feature. */
  commandAvailable: boolean;
  /** The shortest pause the plan allows, in seconds. */
  minCooldownSec: number;
  /** Free plan: the overlay shows the service address under the card. */
  branding: boolean;
  /** Roasts left this month on the best model and voice; null when all of them are. */
  premium: { total: number; remaining: number } | null;
  /** Dashboard tests today; they never spend the monthly quota. null: no limit. */
  tests: { limit: number; remaining: number } | null;
  /** The overlay page is open right now (in OBS or a browser tab). */
  overlayConnected: boolean;
  /** Twitch's answer to our EventSub subscriptions; null when the channel needs none. */
  twitchEvents: { connected: boolean; failed: string[] } | null;
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
  source: string;
  viewerLogin: string | null;
  inputText: string | null;
  outputText: string | null;
  error: string | null;
  latencyMs: number | null;
  createdAt: string;
  tier: "premium" | "economy" | null;
  model: string | null;
  voiceProvider: "elevenlabs" | "yandex" | "piper" | null;
  costUsd: number;
  channelLogin: string;
  overlayStatus: "pending" | "delivered" | "expired" | null;
  testKind: string | null;
  /** The streamer starred it: the best of the stream, may go to the landing page. */
  favorite: boolean;
  /** The owner approved it for the landing page. */
  onShowcase: boolean;
}

export interface ActivityRoast {
  id: string;
  createdAt: string;
  source: string;
  viewerLogin: string | null;
  inputText: string | null;
  outputText: string | null;
  status: RoastResult["status"];
  error: string | null;
  overlayStatus: RoastResult["overlayStatus"];
  /** What a dashboard test pretended to be. */
  testKind: string | null;
  favorite: boolean;
}
export interface Activity {
  roasts: ActivityRoast[];
  /** Twitch's answer per EventSub subscription: "ok" or the error; null when none are needed. */
  eventsub: { connected: boolean; subscriptions: Record<string, string>; updatedAt: string } | null;
}

export const SOURCE_TEXT: Record<string, string> = {
  chat_command: "!роаст",
  chat_keyword: "Слово в чате",
  reward: "Награда",
  cheer: "Битсы",
  subscription: "Подписка",
  gift_sub: "Гифт-сабы",
  raid: "Рейд",
  follow: "Фоллоу",
  prediction: "Прогноз",
  ad_break: "Реклама",
  donation: "Донат",
  dashboard_test: "Тест"
};

/** The event simulator: what a dashboard test pretends happened. */
export type SimulatedKind =
  | "plain"
  | "reward"
  | "keyword"
  | "donation"
  | "raid"
  | "prediction"
  | "cheer"
  | "subscription"
  | "follow";
export interface SimulatedKindInfo {
  label: string;
  /** Whether the viewer writes a text with this event. */
  text: boolean;
  placeholder?: string;
  /** Label of the number field (sum, viewers, bits), if the event has one. */
  amount?: { label: string; value: number };
  /** Label of the login field. */
  who: string;
}
export const SIMULATED_KINDS: Record<SimulatedKind, SimulatedKindInfo> = {
  plain: { label: "Сообщение", text: true, placeholder: "опять проиграл катку", who: "Зритель" },
  reward: {
    label: "Награда с текстом",
    text: true,
    placeholder: "скажи стримеру, что он плохо стреляет",
    who: "Зритель"
  },
  keyword: {
    label: "Слово в чате",
    text: true,
    placeholder: "ну всё, слился стример",
    who: "Зритель"
  },
  donation: {
    label: "Донат",
    text: true,
    placeholder: "на новую мышку, старая промахивается",
    amount: { label: "Сумма, ₽", value: 100 },
    who: "Донатер"
  },
  raid: { label: "Рейд", text: false, amount: { label: "Зрителей", value: 40 }, who: "Канал" },
  prediction: {
    label: "Итог прогноза",
    text: false,
    amount: { label: "Проиграли зрителей", value: 12 },
    who: "Главный проигравший"
  },
  cheer: {
    label: "Битсы",
    text: true,
    placeholder: "держи на патроны",
    amount: { label: "Битсов", value: 100 },
    who: "Зритель"
  },
  subscription: { label: "Подписка", text: true, placeholder: "", who: "Подписчик" },
  follow: { label: "Фоллоу", text: false, who: "Фолловер" }
};

// Rough rates for a small channel, events per minute of stream. They only have to show the
// order of magnitude: "the quota lasts ten minutes" versus "the whole stream".
const RATES = {
  keywordPerWord: 0.5,
  maxKeywords: 6,
  reward: 0.3,
  command: 0.5,
  follow: 0.5,
  cheer: 0.05,
  subscription: 0.05,
  giftSub: 0.02,
  raid: 0.01,
  prediction: 0.03,
  adBreak: 0.03,
  donation: 0.05
};

/** Expected roasts per minute of stream with these triggers; cooldowns cap chat and rewards. */
export function roastsPerMinute(
  triggers: Triggers,
  cooldownSec: number,
  commandAvailable: boolean
): number {
  const chance = (percent: number) => Math.max(0, Math.min(100, percent)) / 100;
  let throttled =
    (Math.min(triggers.keywords.length, RATES.maxKeywords) * RATES.keywordPerWord) /
    KEYWORD_EVERY[triggers.chatFrequency];
  if (triggers.rewardId) throttled += RATES.reward / REWARD_EVERY[triggers.chatFrequency];
  if (commandAvailable && triggers.command) throttled += RATES.command;
  const events = triggers.events;
  if (events.follow.enabled) throttled += RATES.follow * chance(events.follow.chancePercent);
  if (cooldownSec > 0) throttled = Math.min(throttled, 60 / cooldownSec);
  let always = 0;
  for (const key of [
    "cheer",
    "subscription",
    "giftSub",
    "raid",
    "prediction",
    "adBreak",
    "donation"
  ] as const) {
    if (events[key].enabled) always += RATES[key];
  }
  return throttled + always;
}

/** Minutes of stream the remaining quota lasts, or null when nothing is switched on. */
export function quotaMinutes(remaining: number, perMinute: number): number | null {
  if (perMinute <= 0) return null;
  return Math.floor(remaining / perMinute);
}

export const SUBSCRIPTION_TEXT: Record<string, string> = {
  "channel.channel_points_custom_reward_redemption.add": "Награда за баллы",
  "channel.cheer": "Битсы",
  "channel.subscribe": "Подписки",
  "channel.subscription.message": "Ресабы",
  "channel.subscription.gift": "Гифт-сабы",
  "channel.raid": "Рейды",
  "channel.follow": "Фоллоу",
  "channel.prediction.end": "Прогнозы",
  "channel.ad_break.begin": "Реклама"
};

/** Why a roast ended the way it did, in the streamer's words. */
export function activityOutcome(roast: ActivityRoast): { ok: boolean; text: string } {
  const reason = roast.error ?? "";
  switch (roast.status) {
    case "queued":
      return { ok: true, text: "в очереди" };
    case "done":
      if (roast.overlayStatus === "expired") {
        return { ok: false, text: "оверлей не был открыт, роаст истёк" };
      }
      if (roast.overlayStatus === "pending") return { ok: true, text: "ждёт оверлей" };
      return { ok: true, text: "прозвучало" };
    case "blocked_output":
      return { ok: false, text: "ответ не прошёл модерацию, прозвучала заглушка" };
    case "blocked_input":
      if (reason.startsWith("nickname:")) return { ok: false, text: "ник зрителя в стоп-листе" };
      if (reason === "prompt_injection") {
        return { ok: false, text: "похоже на попытку управлять ботом, промолчала" };
      }
      if (reason.startsWith("event:")) return { ok: false, text: "в событии слово из стоп-листа" };
      return { ok: false, text: "в сообщении слово из стоп-листа, промолчала" };
    case "failed":
      return { ok: false, text: "ошибка генерации, попробуйте ещё раз" };
    case "skipped":
      // A stub is an answer too: the viewer heard the bot.
      return {
        ok: reason.startsWith("stub_"),
        text: SKIP_REASON_TEXT[reason] ?? `пропущено: ${reason}`
      };
  }
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
  cooldown_active: "действует пауза из «Тонкой настройки»",
  viewer_limit: "зритель уже получил 3 ответа за полчаса",
  stub_cooldown: "пауза — прозвучала заглушка",
  stub_viewer_limit: "зритель частит — прозвучала заглушка",
  stub_quota: "квота закончилась — прозвучала заглушка",
  stub_declined: "награда без роаста по частоте — «Мммммм, нет!»",
  command_not_in_plan: "команда недоступна на бесплатном тарифе",
  test_limit_reached: "тесты на сегодня закончились",
  stale_job: "задача устарела"
};
