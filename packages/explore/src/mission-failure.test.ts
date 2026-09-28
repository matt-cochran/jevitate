import { describe, expect, it } from "vitest";
import { describeFailure, describeUnreachable, isUnreachableTarget } from "./mission-failure.js";

/**
 * #128 — the pure rule for "the start URL simply could not be loaded": neither a defect in the app
 * under test nor a bug in jevitate, so it must never be misattributed as either.
 */
describe("isUnreachableTarget — net::ERR_*, connection refusal, or a bare navigation timeout", () => {
  it.each([
    ["page.goto: net::ERR_UNSAFE_PORT at http://127.0.0.1:1/", true],
    ["page.goto: net::ERR_CONNECTION_REFUSED at http://127.0.0.1:5999/", true],
    ["page.goto: net::ERR_NAME_NOT_RESOLVED at http://no-such-host.invalid/", true],
    ["connect ECONNREFUSED 127.0.0.1:5999", true],
    ["page.goto: Timeout 30000ms exceeded.", true],
    ["some unrelated exception", false],
  ])("%s -> %s", (message, want) => {
    expect(isUnreachableTarget(message)).toBe(want);
  });
});

describe("describeUnreachable — a plain-words cause, never fabricated without evidence", () => {
  it("reads a net::ERR_* code from the message as a plain phrase", () => {
    expect(describeUnreachable("page.goto: net::ERR_CONNECTION_REFUSED at http://x/")).toBe("connection refused");
    expect(describeUnreachable("page.goto: net::ERR_UNSAFE_PORT at http://x/")).toBe("unsafe port");
    expect(describeUnreachable("page.goto: net::ERR_NAME_NOT_RESOLVED at http://x/")).toBe("name not resolved");
  });

  it("prefers real network evidence (a requestfailed errorText) over the thrown message's own wording", () => {
    // Playwright's OWN exception says only "Timeout …ms exceeded", but a requestfailed listener
    // caught the real net::ERR_CONNECTION_REFUSED on the wire: the real evidence wins.
    expect(describeUnreachable("page.goto: Timeout 30000ms exceeded.", "net::ERR_CONNECTION_REFUSED")).toBe(
      "connection refused",
    );
  });

  it("falls back to a bare-timeout phrase — never fabricates a specific cause with no evidence for it", () => {
    expect(describeUnreachable("page.goto: Timeout 30000ms exceeded.")).toBe("timed out before any response");
    expect(describeUnreachable("page.goto: Timeout 30000ms exceeded.", null)).toBe("timed out before any response");
  });

  it("recognises a bare ECONNREFUSED with no net:: prefix", () => {
    expect(describeUnreachable("connect ECONNREFUSED 127.0.0.1:5999")).toBe("connection refused");
  });
});

describe("describeFailure — a page the liveness watchdog closed (#220)", () => {
  const base = { pageCrashed: false, pageClosed: true, browserDisconnected: false };
  it("is a typed `stalled` failure carrying the watchdog's reason, not a generic page-closed", () => {
    const f = describeFailure(new Error("locator.elementHandles: Target page, context or browser has been closed"), {
      ...base,
      unresponsive: "the page process stopped responding: no answer for 60s",
    });
    expect(f.kind).toBe("stalled");
    expect(f.message).toMatch(/^the page process stopped responding: no answer for 60s \(locator\.elementHandles/);
  });
  it("a real crash still wins over the watchdog's reason", () => {
    expect(describeFailure(new Error("Target crashed"), { ...base, pageCrashed: true, unresponsive: "x" }).kind).toBe("page-crash");
    expect(describeFailure(new Error("closed"), base).kind).toBe("page-closed");
  });
});

describe("describeFailure — a navigation the app never answered (#226)", () => {
  const live = { pageCrashed: false, pageClosed: false, browserDisconnected: false };
  const gotoTimeout = (): Error => {
    const e = new Error('page.goto: Timeout 30000ms exceeded.\nCall log:\n  - navigating to "http://127.0.0.1:4000/app?token=s3cret", waiting until "load"\n');
    e.stack = `${e.message}\n    at Object.performAs (interactions.ts:13:20)`;
    return e;
  };
  it("is a typed target-unresponsive failure with a plain reason naming the path — no stack, no query, no raw Playwright text", () => {
    const f = describeFailure(gotoTimeout(), live);
    expect(f).toEqual({ kind: "target-unresponsive", message: "the app stopped responding to navigation to /app (timed out before any response)" });
  });
  it("a network error on a reload is the same ending; a non-navigation timeout (a click) stays an exception", () => {
    expect(describeFailure(new Error("page.reload: net::ERR_CONNECTION_REFUSED at http://127.0.0.1:4000/"), live).kind).toBe("target-unresponsive");
    expect(describeFailure(new Error("locator.click: Timeout 30000ms exceeded."), live).kind).toBe("exception");
  });
  it("crash evidence still wins", () => {
    expect(describeFailure(gotoTimeout(), { ...live, pageCrashed: true }).kind).toBe("page-crash");
  });
});
