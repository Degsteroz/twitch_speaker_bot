import { describe, expect, it } from "vitest";

import {
  parseRoute,
  roastFilterFromSearch,
  roastFilterQuery,
  roastFilterSearch
} from "./routes.js";

const ROAST_ID = "0b7c1c1e-4f0a-4c55-9a8e-1d2f3a4b5c6d";

describe("parseRoute", () => {
  it("maps panel addresses to pages", () => {
    expect(parseRoute("/")).toEqual({ page: "dashboard" });
    expect(parseRoute("/security/")).toEqual({ page: "security" });
    expect(parseRoute("/admin")).toEqual({ page: "admin", tab: "overview" });
    expect(parseRoute("/admin/roasts")).toEqual({ page: "admin", tab: "roasts" });
    expect(parseRoute("/admin/nope")).toEqual({ page: "admin", tab: "overview" });
    expect(parseRoute(`/roasts/${ROAST_ID.toUpperCase()}`)).toEqual({
      page: "roast",
      id: ROAST_ID
    });
  });

  it("opens invite links before any session check", () => {
    expect(parseRoute("/i/AbC-123_xyz")).toEqual({ page: "invite", code: "AbC-123_xyz" });
    expect(parseRoute("/i/short")).toEqual({ page: "dashboard" });
    expect(parseRoute("/admin/payments")).toEqual({ page: "admin", tab: "payments" });
  });

  it("sends unknown addresses to the dashboard", () => {
    expect(parseRoute("/roasts/not-a-uuid")).toEqual({ page: "dashboard" });
    expect(parseRoute(`/roasts/${ROAST_ID}/extra`)).toEqual({ page: "dashboard" });
  });
});

describe("roast filter", () => {
  it("round-trips through the page address", () => {
    const filter = { channel: "streamer", status: "failed", from: "2026-10-01", to: "" };
    const search = roastFilterSearch(filter);
    expect(search).toBe("?channel=streamer&status=failed&from=2026-10-01");
    expect(roastFilterFromSearch(search)).toEqual(filter);
    expect(roastFilterSearch({ channel: "", status: "", from: "", to: "" })).toBe("");
  });

  it("asks the API by channel id or by login", () => {
    const empty = { status: "", from: "", to: "" };
    expect(roastFilterQuery({ ...empty, channel: ROAST_ID })).toBe(
      `channelId=${ROAST_ID}&limit=200`
    );
    expect(roastFilterQuery({ ...empty, channel: "@streamer" })).toBe(
      "channel=%40streamer&limit=200"
    );
  });
});
