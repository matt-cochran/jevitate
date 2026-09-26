import { HostHealthSampler, degradedEnvironmentOutcome } from "@jevitate/explore";
import type { EnvironmentDegraded, HostHealthSummary, MissionFailure } from "@jevitate/domain";

/**
 * One host-health sampler per mission run (#203), shared by every strategy's runner: started (with
 * one sample taken) BEFORE the browser opens, fed every transcript entry, handed to the mission so a
 * hang/no-progress met on a starved host is marked `environment-degraded`, and summarised into the
 * result's `hostHealth`. `injected` is the test seam (a deterministic fake host).
 */
export async function startHostHealth(injected?: HostHealthSampler): Promise<HostHealthSampler> {
  const health = (injected ?? new HostHealthSampler()).start();
  await health.sample();
  return health;
}

/** What every result carries from the sampler, and the degraded-environment verdict rule applied. */
export interface HostHealthVerdict<O extends string> {
  readonly outcome: O | "inconclusive";
  /** Set when the rule turned the outcome `inconclusive` (reason `degraded-environment`). */
  readonly failure?: MissionFailure;
  readonly fields: { readonly hostHealth: HostHealthSummary; readonly environmentDegraded: EnvironmentDegraded[] };
}

/**
 * Takes the closing sample and applies the run-level rule: most steps starved → `inconclusive`
 * (`degraded-environment`), never `clean` (see `degradedEnvironmentOutcome`).
 */
export async function finishHostHealth<O extends string>(health: HostHealthSampler, outcome: O): Promise<HostHealthVerdict<O>> {
  await health.sample();
  const hostHealth = health.summary();
  const verdict = degradedEnvironmentOutcome(outcome, hostHealth);
  return {
    outcome: verdict.outcome,
    ...(verdict.failure === undefined ? {} : { failure: verdict.failure }),
    fields: { hostHealth, environmentDegraded: health.findings() },
  };
}
