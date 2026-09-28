import { describe, expect, it } from "vitest";
import { BrowseTheWeb, CastActor } from "@jevitate/screenplay";
import type { BrowserSession } from "@jevitate/playwright";
import { TargetUnresponsiveError, describeFailure, describeUnreachable, isUnreachableTarget, targetStoppedAnswering, type LivenessAnswer, assertSeedReachable } from "./mission-failure.js";

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

describe("targetStoppedAnswering — the app stopped answering vs a slow host (#230)", () => {
  const probeOf =
    (answers: Record<string, LivenessAnswer>, seen: string[] = []) =>
    async (url: string): Promise<LivenessAnswer> => {
      seen.push(url);
      return answers[new URL(url).origin] ?? "answered";
    };

  it("a fresh request that gets no response at all (or is refused) is target-unresponsive, in plain words", async () => {
    const quiet = await targetStoppedAnswering({ pageUrl: "http://app.test/a?t=secret", probe: probeOf({ "http://app.test": "no-response" }), timeoutMs: 10_000 });
    expect(quiet).toBe("the app stopped responding on /a (a fresh request for it got no response within 10s)");
    const refused = await targetStoppedAnswering({ pageUrl: "http://app.test/a", probe: probeOf({ "http://app.test": "refused" }) });
    expect(refused).toMatch(/connection refused/);
  });

  it("an app that answers (slowly, or with an error status) is not; a probe that proved nothing is not either", async () => {
    expect(await targetStoppedAnswering({ pageUrl: "http://app.test/a", probe: probeOf({}) })).toBeNull();
    expect(await targetStoppedAnswering({ pageUrl: "http://app.test/a", probe: probeOf({ "http://app.test": "unknown" }) })).toBeNull();
    expect(await targetStoppedAnswering({ pageUrl: "about:blank", probe: probeOf({}) })).toBeNull();
  });

  it("re-requests the page's own path without its query (never re-sends a token) and never an unauthorized page", async () => {
    const seen: string[] = [];
    expect(await targetStoppedAnswering({ pageUrl: "http://app.test/confirm?token=abc#x", probe: probeOf({}, seen) })).toBeNull();
    expect(seen).toEqual(["http://app.test/confirm"]);
    const unauthorized = await targetStoppedAnswering({
      pageUrl: "http://elsewhere.test/a",
      authorized: (u) => u.startsWith("http://app.test"),
      probe: probeOf({ "http://elsewhere.test": "no-response" }, seen),
    });
    expect(unauthorized).toBeNull();
    expect(seen).toHaveLength(1);
  });

  it("describeFailure types a TargetUnresponsiveError as target-unresponsive with no stack", () => {
    const f = describeFailure(new TargetUnresponsiveError("the app stopped responding on /a (x)"), { pageCrashed: false, pageClosed: false, browserDisconnected: false });
    expect(f).toEqual({ kind: "target-unresponsive", message: "the app stopped responding on /a (x)" });
  });
});

describe("assertSeedReachable — #213: a target that is not running fails fast, in plain words", () => {
  const actorWith = (probeReachable?: (url: string) => Promise<string | null>) =>
    CastActor.named("x").whoCan(new BrowseTheWeb({ ...(probeReachable === undefined ? {} : { probeReachable }) } as unknown as BrowserSession, []));

  it("a refused probe throws an unreachable-target error whose description is the probe's own words", async () => {
    const actor = actorWith(async () => "connection refused — is the app running at http://127.0.0.1:5999?");
    const err = await assertSeedReachable(actor, "http://127.0.0.1:5999/").then(() => null, (e: Error) => e);
    expect(err).not.toBeNull();
    expect(isUnreachableTarget(err!.message)).toBe(true);
    expect(describeUnreachable(err!.message)).toBe("connection refused — is the app running at http://127.0.0.1:5999?");
  });

  it("a reachable target, or a session with no probe (a test double), passes", async () => {
    await expect(assertSeedReachable(actorWith(async () => null), "http://x/")).resolves.toBeUndefined();
    await expect(assertSeedReachable(actorWith(), "http://x/")).resolves.toBeUndefined();
  });
});
