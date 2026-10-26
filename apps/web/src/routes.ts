// Addresses of the panel pages. No routing library: the app reads location and history.pushState
// moves it, so every page and filter has a link that survives a reload and can be shared.

export const ADMIN_TABS = [
  ["overview", "Обзор"],
  ["users", "Пользователи"],
  ["roasts", "Роасты"],
  ["moderation", "Модерация"],
  ["payments", "Платежи"],
  ["settings", "Глобальные"],
  ["audit", "Аудит"]
] as const;
export type AdminTab = (typeof ADMIN_TABS)[number][0];

export type Route =
  | { page: "dashboard" }
  | { page: "security" }
  | { page: "admin"; tab: AdminTab }
  | { page: "roast"; id: string }
  | { page: "invite"; code: string };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
export const isUuid = (value: string) => UUID.test(value);

export function parseRoute(pathname: string): Route {
  const parts = pathname.split("/").filter(Boolean);
  if (parts[0] === "admin") {
    const tab = ADMIN_TABS.find(([id]) => id === parts[1])?.[0] ?? "overview";
    return { page: "admin", tab };
  }
  if (parts[0] === "security" && parts.length === 1) return { page: "security" };
  if (
    parts[0] === "i" &&
    parts[1] &&
    /^[A-Za-z0-9_-]{8,64}$/u.test(parts[1]) &&
    parts.length === 2
  ) {
    return { page: "invite", code: parts[1] };
  }
  if (parts[0] === "roasts" && parts[1] && isUuid(parts[1]) && parts.length === 2) {
    return { page: "roast", id: parts[1].toLowerCase() };
  }
  return { page: "dashboard" };
}

export interface RoastFilter {
  /** A Twitch login or a channel UUID. */
  channel: string;
  status: string;
  /** Dates as yyyy-mm-dd, inclusive. */
  from: string;
  to: string;
}
const FILTER_KEYS = ["channel", "status", "from", "to"] as const;

export function roastFilterFromSearch(search: string): RoastFilter {
  const params = new URLSearchParams(search);
  return Object.fromEntries(
    FILTER_KEYS.map((key) => [key, params.get(key)?.trim() ?? ""])
  ) as unknown as RoastFilter;
}

/** The page address for a filter: only the fields that are set. */
export function roastFilterSearch(filter: RoastFilter): string {
  const params = new URLSearchParams();
  for (const key of FILTER_KEYS) if (filter[key]) params.set(key, filter[key]);
  const query = params.toString();
  return query ? `?${query}` : "";
}

/** The API query for a filter: a UUID filters by channel id, anything else by login. */
export function roastFilterQuery(filter: RoastFilter): string {
  const params = new URLSearchParams();
  const channel = filter.channel.trim();
  if (isUuid(channel)) params.set("channelId", channel);
  else if (channel) params.set("channel", channel);
  if (filter.status) params.set("status", filter.status);
  if (filter.from) params.set("from", new Date(`${filter.from}T00:00:00`).toISOString());
  if (filter.to) params.set("to", new Date(`${filter.to}T23:59:59`).toISOString());
  params.set("limit", "200");
  return params.toString();
}
