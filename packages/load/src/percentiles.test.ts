import { describe, it, expect } from "vitest";
import { percentile, computeLatencyPercentiles } from "./percentiles.js";

describe("percentile", () => {
  it("returns the nearest-rank value for a sorted array", () => {
    const sorted = [10, 20, 30, 40, 50];
    expect(percentile(sorted, 50)).toBe(30);
    expect(percentile(sorted, 100)).toBe(50);
    expect(percentile(sorted, 1)).toBe(10);
  });

  it("returns 0 for an empty array", () => {
    expect(percentile([], 50)).toBe(0);
  });
});

describe("computeLatencyPercentiles", () => {
  it("computes p50/p95/p99/mean/min/max over unsorted input", () => {
    const durations = [50, 10, 30, 20, 40];
    const stats = computeLatencyPercentiles(durations);
    expect(stats.minMs).toBe(10);
    expect(stats.maxMs).toBe(50);
    expect(stats.meanMs).toBe(30);
    expect(stats.p50Ms).toBe(30);
  });

  it("returns all-zero stats for an empty array (never throws on no data)", () => {
    expect(computeLatencyPercentiles([])).toEqual({
      p50Ms: 0,
      p95Ms: 0,
      p99Ms: 0,
      meanMs: 0,
      minMs: 0,
      maxMs: 0,
    });
  });
});
