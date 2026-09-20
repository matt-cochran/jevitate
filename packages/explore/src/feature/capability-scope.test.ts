import { describe, expect, test } from "vitest";
import { isInScope, type CapabilityScope } from "./capability-scope.js";

const scope: CapabilityScope = {
  name: "read messages",
  originAllowlist: ["https://x.test"],
  routeGlobs: ["/inbox"],
};

describe("isInScope", () => {
  test("true for an in-allowlist origin + matching route", () => {
    expect(isInScope("https://x.test/inbox", scope)).toBe(true);
  });

  test("false for a matching route on a different origin", () => {
    expect(isInScope("https://evil.test/inbox", scope)).toBe(false);
  });

  test("false for an in-allowlist origin but a route outside the globs (a boundary edge)", () => {
    expect(isInScope("https://x.test/thread/t-1", scope)).toBe(false);
  });

  test("supports a ** wildcard glob segment", () => {
    const wide: CapabilityScope = { ...scope, routeGlobs: ["/thread/**"] };
    expect(isInScope("https://x.test/thread/t-1", wide)).toBe(true);
    expect(isInScope("https://x.test/thread/t-1/reply", wide)).toBe(true);
    expect(isInScope("https://x.test/inbox", wide)).toBe(false);
  });

  test("an unparseable url is out of scope, fail-closed", () => {
    expect(isInScope("not a url", scope)).toBe(false);
  });

  test("an empty originAllowlist authorizes nothing (fail-closed)", () => {
    const closed: CapabilityScope = { ...scope, originAllowlist: [] };
    expect(isInScope("https://x.test/inbox", closed)).toBe(false);
  });
});
