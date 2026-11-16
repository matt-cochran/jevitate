// explore-goal.ts — the programmatic surface behind `jevitate explore` (`runExploration`, #231).
import { openModelSecretScope } from "@jevitate/ai-core";
import { runGoalExploration } from "./explore-goal-run.js";
import type { RunExplorationOptions, RunExplorationResult } from "./explore-goal-run.js";

export type { DoneCheckReader, RunExplorationOptions, RunExplorationResult } from "./explore-goal-run.js";
export { withServerCause } from "./explore-goal-server-cause.js";

/**
 * The programmatic surface behind `jevitate explore` — wires a real Playwright
 * `Page` + gateways to `@jevitate/explore`'s goal-based mission, then persists
 * the emitted `Recording` under `.jevitate/logs/<date>`.
 *
 * The authorized-target guard runs FIRST (fail-closed), BEFORE any browser is
 * opened — an unauthorized origin never launches Chromium. Gateways are
 * injected (fakes in tests / live wiring in `program.ts`), so this file needs
 * no keys or network to be unit-tested.
 */

export async function runExploration(opts: RunExplorationOptions): Promise<RunExplorationResult> {
  // The gateways' backstop, for this run only.
  const modelSecrets = openModelSecretScope();
  try {
    return await runGoalExploration(opts, modelSecrets);
  } finally {
    modelSecrets.release();
  }
}
