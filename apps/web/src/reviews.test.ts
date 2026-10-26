import { describe, expect, it } from "vitest";

import { clipEmbedUrl, REVIEWS } from "./reviews.js";

describe("reviews", () => {
  it("embeds a clip for the domain that serves the page", () => {
    const url = new URL(clipEmbedUrl("Clip-Slug_1", "roast.recursia.online"));
    expect(url.origin).toBe("https://clips.twitch.tv");
    expect(url.searchParams.get("clip")).toBe("Clip-Slug_1");
    expect(url.searchParams.get("parent")).toBe("roast.recursia.online");
    expect(url.searchParams.get("autoplay")).toBe("false");
  });

  it("links real Twitch channels and pictures", () => {
    for (const review of REVIEWS) {
      expect(review.channel).toMatch(/^[a-z0-9_]{1,25}$/);
      expect(new URL(review.avatar).protocol).toBe("https:");
      expect(review.text.length).toBeGreaterThan(0);
    }
  });
});
