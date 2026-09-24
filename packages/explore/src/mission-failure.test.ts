import { describe, expect, it } from "vitest";
import { describeUnreachable, isUnreachableTarget } from "./mission-failure.js";

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
