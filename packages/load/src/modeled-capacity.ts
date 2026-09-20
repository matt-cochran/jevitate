import { simulateTiming, type InteractionPolicy, type PlannedStep } from "@doit/domain";
import { assertAuthorizedTarget } from "./authorized-targets.js";
import { deriveActorSeeds } from "./seeded-pool.js";
import { computeLatencyPercentiles } from "./percentiles.js";
import type { CapacityReport } from "./types.js";

export interface RunModeledCapacityConfig {
  targetOrigin: string;
  authorizedOrigins: readonly string[];
  concurrency: number;
  iterationsPerActor: number;
  seed: number;
  policy: InteractionPolicy;
  script: PlannedStep[];
}

/**
 * Offline estimate, reusing `@doit/domain`'s `simulateTiming()` — used when
 * a real browser/target is not available. ALWAYS returns
 * `provenance: "modeled"`; there is no code path here that returns
 * `"measured"`. See `runLoadTest` (measured-load-runner.ts) for the real
 * path — the two never call into each other.
 */
export function modeledCapacityReport(config: RunModeledCapacityConfig): CapacityReport {
  assertAuthorizedTarget(config.targetOrigin, config.authorizedOrigins); // #10 applies offline too

  if (config.concurrency < 1 || config.iterationsPerActor < 1) {
    throw new RangeError("concurrency and iterationsPerActor must each be >= 1");
  }

  const seeds = deriveActorSeeds(config.seed, config.concurrency);
  const durations: number[] = [];
  let maxActorTotalMs = 0;

  for (const actorSeed of seeds) {
    let actorTotalMs = 0;
    for (let i = 0; i < config.iterationsPerActor; i++) {
      // Distinct-but-deterministic seed per iteration: repeated iterations
      // by the same actor aren't identical samples, while the whole report
      // stays reproducible given `config.seed`.
      const iterationSeed = (actorSeed + i * 2654435761) >>> 0;
      const profile = simulateTiming(config.policy, iterationSeed, config.script);
      durations.push(profile.totalMs);
      actorTotalMs += profile.totalMs;
    }
    maxActorTotalMs = Math.max(maxActorTotalMs, actorTotalMs);
  }

  const totalRuns = config.concurrency * config.iterationsPerActor;

  return {
    provenance: "modeled",
    concurrency: config.concurrency,
    seed: config.seed,
    totalRuns,
    okRuns: totalRuns,
    quarantinedRuns: 0,
    errorRuns: 0,
    durationMs: maxActorTotalMs,
    throughputPerSecond: maxActorTotalMs > 0 ? (totalRuns * 1000) / maxActorTotalMs : 0,
    latency: computeLatencyPercentiles(durations),
  };
}
