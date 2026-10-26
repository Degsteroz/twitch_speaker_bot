import { readdirSync, readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { TOUR_STEPS, TOUR_STORAGE_KEY, isTourDone, markTourDone } from "./tour-steps.js";

// The panel is split into dashboard/*.tsx; a tour target may live in any of them.
const dashboardDir = new URL("./dashboard/", import.meta.url);
const dashboardSource = readdirSync(dashboardDir)
  .filter((name) => name.endsWith(".tsx"))
  .map((name) => readFileSync(new URL(name, dashboardDir), "utf8"))
  .join("\n");

describe("streamer tour", () => {
  it("points every step at an element that exists on the dashboard", () => {
    const targets = TOUR_STEPS.map((step) => step.target);
    expect(new Set(targets).size).toBe(targets.length);
    for (const target of targets) {
      const marked =
        dashboardSource.includes(`data-tour="${target}"`) ||
        dashboardSource.includes(`tour="${target}"`);
      expect(marked, `missing data-tour="${target}"`).toBe(true);
    }
  });

  it("covers the setup a streamer must do: overlay, reward and test", () => {
    const text = TOUR_STEPS.flatMap((step) => step.body).join(" ");
    expect(text).toContain("Браузер");
    expect(text).toContain("1920");
    expect(text).toContain("Управлять звуком через OBS");
    expect(text).toContain("ввод текста");
  });

  it("remembers completion and survives broken storage", () => {
    const store = new Map<string, string>();
    const storage = {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => void store.set(key, value)
    };
    expect(isTourDone(storage)).toBe(false);
    markTourDone(storage);
    expect(store.get(TOUR_STORAGE_KEY)).toBe("1");
    expect(isTourDone(storage)).toBe(true);

    const broken = {
      getItem: () => {
        throw new Error("blocked");
      },
      setItem: () => {
        throw new Error("blocked");
      }
    };
    expect(isTourDone(broken)).toBe(false);
    expect(() => markTourDone(broken)).not.toThrow();
  });
});
