// The back-office in words: roast statuses, block reasons and audit entries instead of codes.
import { SKIP_REASON_TEXT } from "../api.js";

export const ROAST_STATUSES = [
  ["done", "прозвучал"],
  ["blocked_output", "ответ заблокирован"],
  ["blocked_input", "вход заблокирован"],
  ["skipped", "пропущен"],
  ["failed", "ошибка"],
  ["queued", "в очереди"]
] as const;
const STATUS_TEXT: Record<string, string> = Object.fromEntries(ROAST_STATUSES);
export const statusText = (status: string) => STATUS_TEXT[status] ?? status;

const BLOCK_REASON_TEXT: Record<string, string> = {
  prompt_injection: "попытка управлять ботом",
  classifier_block: "классификатор не пропустил ответ",
  model_refusal: "модель отказалась отвечать",
  empty_output: "модель вернула пустой ответ",
  link_or_contact: "ссылка или контакт в ответе",
  prompt_leak: "ответ пересказывает инструкции",
  echo_input: "ответ дословно повторяет зрителя"
};
// Reasons with the matched word after a colon: "stop_word:скуф".
const MATCH_REASON_TEXT: Record<string, string> = {
  stop_word: "стоп-слово",
  nickname: "ник в стоп-листе",
  event: "стоп-слово в событии"
};

/** Why a roast ended as it did; unknown codes (raw worker errors) are shown as they are. */
export function reasonText(error: string | null | undefined): string {
  if (!error) return "";
  const colon = error.indexOf(":");
  const kind = colon > 0 ? error.slice(0, colon) : "";
  if (kind in MATCH_REASON_TEXT) return `${MATCH_REASON_TEXT[kind]!} «${error.slice(colon + 1)}»`;
  return BLOCK_REASON_TEXT[error] ?? SKIP_REASON_TEXT[error] ?? error;
}

export interface AuditRow {
  action: string;
  target: string;
  target_login?: string | null;
  payload: unknown;
}

const AUDIT_ACTIONS: Record<string, string> = {
  "user.signup": "заявка на вход",
  "user.activate": "одобрил или вернул доступ",
  "user.suspend": "приостановил",
  "invite.create": "пригласил",
  "invite.delete": "отозвал приглашение",
  "subscription.set": "сменил тариф",
  "quota.gift": "подарил квоту",
  "plan.update": "изменил тариф в настройках",
  "global_setting.update": "изменил настройку",
  "global_stop_words.update": "изменил глобальные стоп-слова",
  "moderation.review": "проверил блок",
  "mfa.enable": "включил 2FA",
  "mfa.disable": "отключил 2FA",
  "mfa.reset": "сбросил 2FA",
  "mfa.recovery_code_used": "вошёл по резервному коду",
  "mfa.recovery_codes_regenerated": "создал новые резервные коды",
  "donationalerts.connect": "подключил DonationAlerts",
  "donationalerts.disconnect": "отключил DonationAlerts",
  "invite_link.create": "создал инвайт-ссылку",
  "invite_link.revoke": "отозвал инвайт-ссылку",
  "invite_link.use": "вошёл по инвайт-ссылке",
  "showcase.review": "решил по витрине",
  "payment.stars": "оплатил звёздами",
  "payment.refund": "вернул звёзды"
};
export const AUDIT_ACTION_LIST = Object.entries(AUDIT_ACTIONS);

const record = (value: unknown): Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};

/** "сменил тариф" + "@vasya → basic до 01.12.2026". */
export function auditText(row: AuditRow): { action: string; detail: string } {
  const payload = record(row.payload);
  const who = row.target_login ? `@${row.target_login}` : row.target;
  const action = AUDIT_ACTIONS[row.action] ?? row.action;
  switch (row.action) {
    case "subscription.set": {
      const until =
        typeof payload.validUntil === "string"
          ? ` до ${new Date(payload.validUntil).toLocaleDateString("ru-RU")}`
          : "";
      return { action, detail: `${who} → ${String(payload.plan)}${until}` };
    }
    case "quota.gift":
      return { action, detail: `${who}: +${String(payload.amount)}` };
    case "invite.create":
      return {
        action,
        detail: `@${row.target}${payload.approvedExisting ? ", заявка одобрена сразу" : ""}`
      };
    case "invite.delete":
      return { action, detail: `@${row.target}` };
    case "global_setting.update":
      return { action, detail: `${row.target} = ${JSON.stringify(payload.value)}` };
    case "global_stop_words.update":
      return {
        action,
        detail: `${String(Array.isArray(payload.words) ? payload.words.length : 0)} слов`
      };
    case "moderation.review":
      return {
        action,
        detail:
          typeof payload.addStopWord === "string" ? `+ стоп-слово «${payload.addStopWord}»` : ""
      };
    case "plan.update":
      return {
        action,
        detail: `${row.target}: лучших ${typeof payload.premiumRoasts === "number" ? String(payload.premiumRoasts) : "все"}, потом ${String(payload.economyModel)} и ${String(payload.economyVoice)}`
      };
    case "payment.stars":
      return { action, detail: `${String(payload.plan)}: ${String(payload.stars)} ⭐` };
    case "invite_link.use":
      return {
        action,
        detail:
          typeof payload.plan === "string"
            ? `${payload.plan} на ${String(payload.planDays)} дн.`
            : ""
      };
    case "showcase.review":
      return { action, detail: payload.approved ? "на сайт" : "убрал с сайта" };
    case "user.signup":
      return { action, detail: `${who}${payload.status === "active" ? ", по приглашению" : ""}` };
    default:
      return { action, detail: who };
  }
}
