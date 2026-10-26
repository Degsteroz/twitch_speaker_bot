import { describe, expect, it } from "vitest";

import { auditText, reasonText, statusText } from "./text.js";

describe("back-office texts", () => {
  it("names statuses and block reasons in words, keeping unknown codes", () => {
    expect(statusText("blocked_output")).toBe("ответ заблокирован");
    expect(reasonText("stop_word:скуф")).toBe("стоп-слово «скуф»");
    expect(reasonText("nickname:пидор")).toBe("ник в стоп-листе «пидор»");
    expect(reasonText("classifier_block")).toBe("классификатор не пропустил ответ");
    expect(reasonText("cooldown_active")).toBe("действует пауза из «Тонкой настройки»");
    expect(reasonText("tts_failed_502")).toBe("tts_failed_502");
    expect(reasonText(null)).toBe("");
  });

  it("tells who did what to whom in the audit log", () => {
    expect(
      auditText({
        action: "subscription.set",
        target: "uuid",
        target_login: "vasya",
        payload: { plan: "basic", validUntil: null }
      })
    ).toEqual({ action: "сменил тариф", detail: "@vasya → basic" });
    expect(
      auditText({ action: "quota.gift", target: "uuid", payload: { amount: 20 } }).detail
    ).toBe("uuid: +20");
    expect(auditText({ action: "something.new", target: "x", payload: {} })).toEqual({
      action: "something.new",
      detail: "x"
    });
  });
});
