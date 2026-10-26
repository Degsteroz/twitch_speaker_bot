import type { RoastTarget, SimulatedEvent } from "@roastbot/shared";

export interface SimulatedRoast {
  viewerLogin: string;
  inputText: string;
  /** Worded like the twitch service words the real event (services/twitch/src/triggers.ts). */
  eventSummary?: string;
  target: RoastTarget;
}

/**
 * A dashboard test dressed as a real trigger: the worker gets the same message, event summary
 * and target as it would from Twitch or DonationAlerts, so the streamer hears the real reaction.
 */
export function simulatedRoast(input: {
  kind: SimulatedEvent;
  viewerLogin: string;
  inputText: string;
  amount?: number | undefined;
}): SimulatedRoast {
  const { kind, viewerLogin, inputText } = input;
  const amount = input.amount ?? 0;
  const roast = (eventSummary: string, text = inputText): SimulatedRoast => ({
    viewerLogin,
    inputText: text,
    eventSummary,
    target: "viewer"
  });
  switch (kind) {
    case "plain":
    case "keyword":
      return { viewerLogin, inputText, target: "viewer" };
    case "reward":
      return { viewerLogin, inputText: inputText || viewerLogin, target: "viewer" };
    case "donation":
      return roast(`Донат ${String(amount || 100)} RUB`);
    case "cheer":
      return roast(`Зритель отправил ${String(amount || 100)} битсов`);
    case "raid":
      return roast(`Рейд с канала ${viewerLogin}: ${String(amount || 40)} зрителей`, "");
    case "prediction":
      return roast(
        `Прогноз «Выиграем катку?» завершён: победил исход «Нет», проиграли ${String(amount || 12)} зрителей`,
        ""
      );
    case "subscription":
      return roast("Новая подписка на канал");
    case "follow":
      return roast("Новый фолловер", "");
  }
}
