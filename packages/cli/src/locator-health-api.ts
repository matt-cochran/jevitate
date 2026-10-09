import type { LocatorHealth, LocatorHealthSummary } from "./check-types.js";
import { NotImplementedError } from "./not-implemented.js";

/**
 * #470 — locator health: how stable each recorded step's target is against the team's test-id
 * convention (the selector-ladder rung it resolves by; `data-tflow-id` never counts, #468).
 * Advisory everywhere (result.json, report, check.json warnings, the review sheet); `check` gates
 * only past the team's opt-in threshold `--max-brittle-steps <n>`.
 *
 * - `jevitate locator-health [--journey <id> | --run <result.json>]` / MCP `locator_health`
 *   (read-only): every promoted Journey by default, one Journey, or the steps of one run result.
 * - The test-id attribute list is project config (`testIdAttributes` in the project's config;
 *   default `data-testid`, `data-test`; teams add e.g. `data-cy`, `data-qa`) — never a flag.
 *
 * STUB (d-surface-0): the feature deliverable replaces the bodies of `locatorHealth` and
 * `brittleStepGate` and owns this file.
 */

/** The default test-id convention when the project config names none. */
export const DEFAULT_TEST_ID_ATTRIBUTES: readonly string[] = ["data-testid", "data-test"];

export interface LocatorHealthRequest {
  /** The journeys dir (`--dir`, else the repo's `.jevitate/journeys`). */
  readonly journeysDir: string;
  /** The project data dir whose config holds `testIdAttributes`; null outside a project (defaults apply). */
  readonly projectDir: string | null;
  /** `--journey <id>`: just this Journey (exclusive with `runResult`). */
  readonly journeyId?: string;
  /** `--run <result.json>`: the steps of this run result (exclusive with `journeyId`). */
  readonly runResult?: string;
}

export interface LocatorHealthReport {
  readonly source: { readonly kind: "journeys" } | { readonly kind: "journey"; readonly id: string } | { readonly kind: "run"; readonly path: string };
  /** The convention applied (from project config, else DEFAULT_TEST_ID_ATTRIBUTES). */
  readonly testIdAttributes: readonly string[];
  readonly journeys: ReadonlyArray<{ readonly id: string; readonly health: LocatorHealth }>;
  readonly summary: LocatorHealthSummary;
}

/** Read-only: never changes a Journey and never gates (the exit code is 0 on any report). */
export async function locatorHealth(_req: LocatorHealthRequest): Promise<LocatorHealthReport> {
  throw new NotImplementedError("jevitate locator-health", "#470");
}

/** The human rendering (no `--json`). */
export function renderLocatorHealth(r: LocatorHealthReport): string {
  const lines = r.journeys.map((j) => `${String(j.health.brittle).padStart(4)} brittle / ${j.health.stable} stable  ${j.id}`);
  return `${lines.join("\n")}${lines.length === 0 ? "" : "\n"}${r.summary.brittle} brittle step(s), ${r.summary.stable} stable across ${r.summary.journeys} Journey(s) (test ids: ${r.testIdAttributes.join(", ")})\n`;
}

/**
 * `check --max-brittle-steps <n>`: the opt-in gate — a Journey item with more than `n` brittle steps
 * is a gating finding. Called by check-cli before the suite runs.
 *
 * Contract for the feature: return the gate, add `maxBrittleSteps?: number` to `RunCheckOptions`
 * (check-types.ts) and have check-cli pass `gate.maxBrittleSteps` through to `runCheck`; check.json
 * reports it in `LocatorHealthSummary.maxBrittleSteps` / `exceeded`.
 */
export interface BrittleStepGate {
  readonly maxBrittleSteps: number;
}

export function brittleStepGate(_maxBrittleSteps: number): BrittleStepGate {
  throw new NotImplementedError("jevitate check --max-brittle-steps", "#470");
}
