import { describe, expect, test } from "vitest";
import { MAX_GLOB_ALTERNATIVES, expandBraces, isInScope, matchGlob, type CapabilityScope } from "./capability-scope.js";

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

describe("#325 — {a,b} alternation in path globs", () => {
  test("matches either alternative, and nothing else", () => {
    const g = "/api.v1.Calendar/{Reschedule,Cancel}Appointment";
    expect(matchGlob(g, "/api.v1.Calendar/RescheduleAppointment")).toBe(true);
    expect(matchGlob(g, "/api.v1.Calendar/CancelAppointment")).toBe(true);
    expect(matchGlob(g, "/api.v1.Calendar/GetAppointment")).toBe(false);
    expect(matchGlob(g, "/api.v1.Calendar/{Reschedule,Cancel}Appointment")).toBe(false);
  });

  test("combines with * and **, nests, and keeps a comma-less group literal", () => {
    expect(matchGlob("/{orders,carts}/*/items", "/carts/7/items")).toBe(true);
    expect(matchGlob("/api/{v1/**,legacy}", "/api/v1/a/b")).toBe(true);
    expect(matchGlob("/api/{v1/**,legacy}", "/api/legacy")).toBe(true);
    expect(expandBraces("/a/{b,{c,d}}x")).toEqual(["/a/bx", "/a/cx", "/a/dx"]);
    expect(expandBraces("/users/{id}")).toEqual(["/users/{id}"]);
    expect(matchGlob("/users/{id}", "/users/{id}")).toBe(true);
    expect(matchGlob("/users/{id}", "/users/42")).toBe(false);
  });

  test("a runaway expansion is refused", () => {
    const big = "/{a,b}{a,b}{a,b}{a,b}{a,b}{a,b}{a,b}";
    expect(() => expandBraces(big)).toThrow(new RegExp(`more than ${MAX_GLOB_ALTERNATIVES} alternatives`));
  });
});
