import { expect, test } from "vitest";
import { evaluateGate } from "./throttle-gate.js";
import type { QuietHours } from "./interaction-policy.js";

const quietHours: QuietHours = {
  timezone: "America/New_York",
  windows: [{ start: "22:00", end: "08:00" }],
};

test("within quiet hours → throttled(quiet_hours) with nextOpenAfter as retryAfter", () => {
  const nowIso = "2026-09-17T02:00:00-04:00";
  const result = evaluateGate({
    nowIso,
    resolved: {},
    lastAtIso: null,
    quietHours,
    maxInlineWaitMs: 60_000,
  });
  expect(result).toEqual({
    kind: "throttled",
    reason: "quiet_hours",
    retryAfter: "2026-09-17T08:00:00-04:00",
  });
});

test("recent lastAtIso within maxInlineWaitMs → wait{ms>0}", () => {
  const nowIso = "2026-09-17T12:00:00-04:00";
  const lastAtIso = "2026-09-17T11:59:55-04:00"; // 5s ago
  const result = evaluateGate({
    nowIso,
    resolved: { minIntervalSeconds: 10 },
    lastAtIso,
    maxInlineWaitMs: 60_000,
  });
  expect(result.kind).toBe("wait");
  if (result.kind === "wait") {
    expect(result.ms).toBe(5000); // 10s interval - 5s elapsed = 5s shortfall
    expect(result.ms).toBeGreaterThan(0);
  }
});

test("old lastAtIso (enough time elapsed) → proceed", () => {
  const nowIso = "2026-09-17T12:00:00-04:00";
  const lastAtIso = "2026-09-17T11:00:00-04:00"; // 1hr ago
  const result = evaluateGate({
    nowIso,
    resolved: { minIntervalSeconds: 10 },
    lastAtIso,
    maxInlineWaitMs: 60_000,
  });
  expect(result).toEqual({ kind: "proceed" });
});

test("no lastAtIso → proceed", () => {
  const nowIso = "2026-09-17T12:00:00-04:00";
  const result = evaluateGate({
    nowIso,
    resolved: { minIntervalSeconds: 10 },
    lastAtIso: null,
    maxInlineWaitMs: 60_000,
  });
  expect(result).toEqual({ kind: "proceed" });
});

test("no minIntervalSeconds configured → proceed even with recent lastAtIso", () => {
  const nowIso = "2026-09-17T12:00:00-04:00";
  const lastAtIso = "2026-09-17T11:59:59-04:00"; // 1s ago
  const result = evaluateGate({
    nowIso,
    resolved: {},
    lastAtIso,
    maxInlineWaitMs: 60_000,
  });
  expect(result).toEqual({ kind: "proceed" });
});

test("large shortfall (exceeds maxInlineWaitMs) → throttled(min_interval) with retryAfter", () => {
  const nowIso = "2026-09-17T12:00:00-04:00";
  const lastAtIso = "2026-09-17T11:59:00-04:00"; // 60s ago
  const result = evaluateGate({
    nowIso,
    resolved: { minIntervalSeconds: 3600 }, // 1hr min interval
    lastAtIso,
    maxInlineWaitMs: 5_000, // only willing to wait 5s inline
  });
  expect(result).toEqual({
    kind: "throttled",
    reason: "min_interval",
    retryAfter: "2026-09-17T16:59:00.000Z", // lastAtIso (11:59-04:00 = 15:59 UTC) + 3600s
  });
});

test("shortfall exactly equal to maxInlineWaitMs → wait (boundary is inclusive)", () => {
  const nowIso = "2026-09-17T12:00:00-04:00";
  const lastAtIso = "2026-09-17T11:59:55-04:00"; // 5s ago
  const result = evaluateGate({
    nowIso,
    resolved: { minIntervalSeconds: 10 }, // shortfall = 5000ms
    lastAtIso,
    maxInlineWaitMs: 5_000,
  });
  expect(result.kind).toBe("wait");
  if (result.kind === "wait") {
    expect(result.ms).toBe(5000);
  }
});

test("order: quiet hours wins over min-interval when both would fire", () => {
  const nowIso = "2026-09-17T02:00:00-04:00"; // inside quiet hours
  const lastAtIso = "2026-09-17T01:59:00-04:00"; // 60s ago, would also trigger min-interval throttle
  const result = evaluateGate({
    nowIso,
    resolved: { minIntervalSeconds: 3600 },
    lastAtIso,
    quietHours,
    maxInlineWaitMs: 5_000,
  });
  expect(result).toEqual({
    kind: "throttled",
    reason: "quiet_hours",
    retryAfter: "2026-09-17T08:00:00-04:00",
  });
});

test("quietHours undefined → skips quiet-hours check, falls through to min-interval", () => {
  const nowIso = "2026-09-17T12:00:00-04:00";
  const lastAtIso = "2026-09-17T11:00:00-04:00"; // 1hr ago, enough elapsed
  const result = evaluateGate({
    nowIso,
    resolved: { minIntervalSeconds: 10 },
    lastAtIso,
    maxInlineWaitMs: 60_000,
  });
  expect(result).toEqual({ kind: "proceed" });
});
