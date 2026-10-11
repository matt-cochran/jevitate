import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FakeClock, installClock, resetClock } from "@jevitate/domain";
import type { SuccessCheck } from "@jevitate/recording";
import type { CapturedRequest } from "./page-monitor.js";
import { detectColdStart, evaluateNetworkCheckAwaiting } from "./success-checks.js";

const check: SuccessCheck = { kind: "responseStatus", method: "POST", pathGlob: "/api/save", status: { class: 2 } };
const pending: CapturedRequest = { method: "POST", url: "http://x/api/save", path: "/api/save", status: null, failed: false, pending: true, startedAt: 1000 };
const answered = (status: number, durationMs: number): CapturedRequest => ({
  method: "POST", url: "http://x/api/save", path: "/api/save", status, failed: false, startedAt: 1000, durationMs,
});

let fake: FakeClock;
beforeEach(() => {
  fake = new FakeClock();
  installClock(fake);
});
afterEach(() => resetClock());

/** A capture whose request answers after `afterMs` of fake time with `status`. */
function slowCapture(afterMs: number, status: number) {
  const t0 = fake.now();
  return () => ({
    requests: [fake.now() - t0 >= afterMs ? answered(status, afterMs) : pending],
    truncated: false,
  });
}

describe("a step response check awaiting an in-flight request", () => {
  it("passes when a 2xx arrives within the bound", async () => {
    const p = evaluateNetworkCheckAwaiting(check, slowCapture(10_000, 200), 15_000);
    await fake.advanceBy(10_500);
    expect((await p).result.passed).toBe(true);
  });

  it("reports a late 2xx as a slow-step advisory with its measured latency", async () => {
    const p = evaluateNetworkCheckAwaiting(check, slowCapture(10_000, 200), 15_000);
    await fake.advanceBy(10_500);
    expect((await p).slowStep).toMatchObject({ kind: "slow-step", latencyMs: 10_000 });
  });

  it("fails when the response is a non-2xx", async () => {
    const p = evaluateNetworkCheckAwaiting(check, slowCapture(2_000, 500), 15_000);
    await fake.advanceBy(3_000);
    expect((await p).result.passed).toBe(false);
  });

  it("keeps the still-awaiting detail when the bound is exceeded", async () => {
    const p = evaluateNetworkCheckAwaiting(check, slowCapture(60_000, 200), 5_000);
    await fake.advanceBy(6_000);
    expect((await p).result.detail).toContain("are still awaiting a response");
  });

  it("reports no slow-step for a request already answered", async () => {
    const r = await evaluateNetworkCheckAwaiting(check, () => ({ requests: [answered(200, 40)], truncated: false }), 15_000);
    expect(r.slowStep).toBeUndefined();
  });
});

describe("cold-start detection across a replay set", () => {
  const slow = { kind: "slow-step", check: "responseStatus:POST /api/save=2xx", latencyMs: 10_000 } as const;

  it("names a check slow on the first replay and fast on later ones", () => {
    expect(detectColdStart([[slow], [], []])).toEqual([slow]);
  });

  it("names nothing when a later replay is slow too", () => {
    expect(detectColdStart([[slow], [slow]])).toEqual([]);
  });

  it("names nothing for a single replay", () => {
    expect(detectColdStart([[slow]])).toEqual([]);
  });
});
