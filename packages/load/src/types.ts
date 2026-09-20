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

/**
 * Thrown when a load-test harness call is misconfigured or cannot even
 * start (e.g. a non-positive `concurrency`/`iterationsPerActor`, or — for
 * `runLoadTest` specifically — a pool member's runner factory itself
 * failing to set up, such as no real browser/target available). Distinct
 * from a per-iteration failure (counted as `errorRuns`) — this aborts the
 * WHOLE run rather than under-reporting it, and is the invariant #9
 * refusal: never silently substitute a modeled number for a run that could
 * not actually happen.
 *
 * Shared by BOTH `runLoadTest` (measured-load-runner.ts) and
 * `modeledCapacityReport` (modeled-capacity.ts) so a config error looks the
 * same regardless of provenance — defined once here (not duplicated) and
 * re-exported from `measured-load-runner.ts` for backward-compatible
 * imports.
 */
export class LoadHarnessSetupError extends Error {}
