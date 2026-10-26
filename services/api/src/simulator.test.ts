import { describe, expect, it } from "vitest";

import { simulatedRoast } from "./simulator.js";

describe("simulatedRoast", () => {
  it("words events like the twitch service and keeps the viewer's text where it belongs", () => {
    expect(
      simulatedRoast({ kind: "donation", viewerLogin: "vasya", inputText: "на мышку", amount: 300 })
    ).toEqual({
      viewerLogin: "vasya",
      inputText: "на мышку",
      eventSummary: "Донат 300 RUB",
      target: "viewer"
    });
    expect(simulatedRoast({ kind: "raid", viewerLogin: "other", inputText: "x" })).toMatchObject({
      inputText: "",
      eventSummary: "Рейд с канала other: 40 зрителей"
    });
    // An empty reward text is the login, as for a real redemption.
    expect(simulatedRoast({ kind: "reward", viewerLogin: "vasya", inputText: "" })).toEqual({
      viewerLogin: "vasya",
      inputText: "vasya",
      target: "viewer"
    });
    expect(simulatedRoast({ kind: "plain", viewerLogin: "v", inputText: "гг" })).not.toHaveProperty(
      "eventSummary"
    );
  });
});
