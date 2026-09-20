import { assertAuthorizedTarget } from "./authorized-targets.js";
import { deriveActorSeeds } from "./seeded-pool.js";
import { computeLatencyPercentiles } from "./percentiles.js";
import { LoadHarnessSetupError } from "./types.js";
import type { CapacityReport, LoadActorRunnerFactory } from "./types.js";

// Re-exported so existing `import { LoadHarnessSetupError } from
// "./measured-load-runner.js"` call sites keep working — the class itself
// is now defined once in `types.ts` and shared with `modeled-capacity.ts`
// (see that file's doc comment for why).
export { LoadHarnessSetupError };

export interface RunLoadTestConfig {
  targetOrigin: string;
  authorizedOrigins: readonly string[];
  concurrency: number;
  iterationsPerActor: number;
  seed: number;
  runnerFactory: LoadActorRunnerFactory;
}

export async function runLoadTest(config: RunLoadTestConfig): Promise<CapacityReport> {
  assertAuthorizedTarget(config.targetOrigin, config.authorizedOrigins); // #10 — before ANYTHING else

  if (config.concurrency < 1 || config.iterationsPerActor < 1) {
    throw new LoadHarnessSetupError("concurrency and iterationsPerActor must each be >= 1");
  }

  const seeds = deriveActorSeeds(config.seed, config.concurrency);
  const startedAtIso = new Date().toISOString();
  const startedAtMs = Date.now();

  const durations: number[] = [];
  let okRuns = 0;
  let quarantinedRuns = 0;
  let errorRuns = 0;

  await Promise.all(
    seeds.map(async (actorSeed, actorIndex) => {
      let runner: Awaited<ReturnType<LoadActorRunnerFactory>>;
      try {
        runner = await config.runnerFactory(actorIndex, actorSeed);
      } catch (err) {
        // #9: a setup failure is fatal to the whole report — never caught
        // higher up and papered over with a modeled estimate.
        throw new LoadHarnessSetupError(
          `actor ${actorIndex} runner setup failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      }

      for (let i = 0; i < config.iterationsPerActor; i++) {
        const iterationStartMs = Date.now();
        try {
          const result = await runner.run();
          durations.push(Date.now() - iterationStartMs);
          if (result.outcome === "ok") okRuns++;
          else quarantinedRuns++;
        } catch {
          errorRuns++;
        }
      }
    }),
  );

  const endedAtIso = new Date().toISOString();
  const durationMs = Date.now() - startedAtMs;
  const totalRuns = okRuns + quarantinedRuns + errorRuns;

  return {
    provenance: "measured",
    concurrency: config.concurrency,
    seed: config.seed,
    totalRuns,
    okRuns,
    quarantinedRuns,
    errorRuns,
    durationMs,
    throughputPerSecond: durationMs > 0 ? (totalRuns * 1000) / durationMs : 0,
    latency: computeLatencyPercentiles(durations),
    startedAtIso,
    endedAtIso,
  };
}
