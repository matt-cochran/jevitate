export interface LatencyPercentiles {
  p50Ms: number;
  p95Ms: number;
  p99Ms: number;
  meanMs: number;
  minMs: number;
  maxMs: number;
}

/** Nearest-rank percentile over an already-sorted-ascending array. */
export function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[idx];
}

export function computeLatencyPercentiles(durationsMs: number[]): LatencyPercentiles {
  if (durationsMs.length === 0) {
    return { p50Ms: 0, p95Ms: 0, p99Ms: 0, meanMs: 0, minMs: 0, maxMs: 0 };
  }
  const sorted = [...durationsMs].sort((a, b) => a - b);
  const sum = sorted.reduce((acc, v) => acc + v, 0);
  return {
    p50Ms: percentile(sorted, 50),
    p95Ms: percentile(sorted, 95),
    p99Ms: percentile(sorted, 99),
    meanMs: sum / sorted.length,
    minMs: sorted[0],
    maxMs: sorted[sorted.length - 1],
  };
}
