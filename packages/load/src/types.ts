import type { JourneyRunResult } from "@doit/runtime";
import type { LatencyPercentiles } from "./percentiles.js";

/**
 * `"measured"` = derived from real `runLoadTest` executions.
 * `"modeled"` = derived from the offline `simulateTiming()` estimate.
 * NEVER produced by the other path's code — see `runLoadTest` and
 * `modeledCapacityReport`.
 */
export type Provenance = "measured" | "modeled";

export interface CapacityReport {
  provenance: Provenance;
  concurrency: number;
  seed: number;
  totalRuns: number;
  okRuns: number;
  quarantinedRuns: number;
  errorRuns: number;
  durationMs: number;
  throughputPerSecond: number;
  latency: LatencyPercentiles;
  /** Wall-clock bounds of the real run. Absent for `modeled` reports — there is no real clock to bound. */
  startedAtIso?: string;
  endedAtIso?: string;
}

/** One pool member's ability to run one Journey iteration. Callers (e.g. the CLI's load-api.ts) implement this over a real JourneyRunner + browser session. */
export interface LoadActorRunner {
  run(): Promise<JourneyRunResult>;
}

export type LoadActorRunnerFactory = (
  actorIndex: number,
  seed: number,
) => LoadActorRunner | Promise<LoadActorRunner>;
