import { describe, expect, it } from "vitest";
import type { Journey } from "@jevitate/journey";
import { effectiveAllowedOrigins } from "./journey-api.js";
import { replayAllowFromFlags } from "./environments.js";

const journey = (allowedOrigins?: string[]): Journey => ({
  metadata: { id: "j", name: "j", promoted: false, params: [], createdAtIso: "2026-10-15T00:00:00.000Z", ...(allowedOrigins === undefined ? {} : { allowedOrigins }) },
  recording: { version: "1", site: "http://localhost:3001", pages: [] },
});
const env = { baseUrl: "http://staging:80", allowedOrigins: ["http://staging:80"], source: "t" };

describe("effectiveAllowedOrigins (#542)", () => {
  it("is the recorded site alone for a Journey with no extra origins", () => {
    expect(effectiveAllowedOrigins(journey(), undefined)).toEqual(["http://localhost:3001"]);
  });
  it("adds the Journey's metadata.allowedOrigins after the site, without duplicates", () => {
    expect(effectiveAllowedOrigins(journey(["http://localhost:3001", "http://127.0.0.1:26110"]), undefined)).toEqual(["http://localhost:3001", "http://127.0.0.1:26110"]);
  });
  it("adds --allow origins", () => {
    expect(effectiveAllowedOrigins(journey(), undefined, ["http://127.0.0.1:26110"])).toEqual(["http://localhost:3001", "http://127.0.0.1:26110"]);
  });
  it("starts from the environment's origins under --env", () => {
    expect(effectiveAllowedOrigins(journey(["http://api:1"]), env, ["http://x:2"])).toEqual(["http://staging:80", "http://api:1", "http://x:2"]);
  });
});

describe("replayAllowFromFlags (#542)", () => {
  it("normalizes a full URL to its origin", () => {
    expect(replayAllowFromFlags(["http://127.0.0.1:26110/api/"])).toEqual(["http://127.0.0.1:26110"]);
  });
  it("refuses an entry that is not an http(s) origin", () => {
    expect(() => replayAllowFromFlags(["not a url"])).toThrow(/not an http\(s\) origin/);
  });
});
