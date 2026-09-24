/**
 * What the coverage (induction) and exploratory missions actually exercised on their target (#75),
 * and whether that is enough to call a silent run `clean` — mirroring the adversarial mission's
 * coverage thresholds (`../adversarial/run-coverage.ts`, #69). A run that spent its budget re-trying
 * a control that keeps failing (a visually-hidden skip link, an occluded target) or never got past
 * global nav into the page's own controls proved nothing; it is `inconclusive`, never `clean`.
 */

export interface CoverageSufficiencyThresholds {
  /** A clean run's failed-action share (of all actions taken) must stay at or below this (0..1). */
  readonly maxFailedActionRatio: number;
  /** When the run took at least one action, a clean run must have exercised at least one non-nav
   *  (in-page) control — not just global navigation links. */
  readonly requireNonNavControl: boolean;
}

/** Defaults: at most a quarter of actions may fail, and at least one non-nav control exercised. */
export const DEFAULT_COVERAGE_SUFFICIENCY_THRESHOLDS: CoverageSufficiencyThresholds = {
  maxFailedActionRatio: 0.25,
  requireNonNavControl: true,
};

/** Resolves (and validates) thresholds. Throws on an out-of-range ratio — a setup error. */
export function resolveCoverageSufficiencyThresholds(
  partial?: Partial<CoverageSufficiencyThresholds>,
): CoverageSufficiencyThresholds {
  const t: CoverageSufficiencyThresholds = { ...DEFAULT_COVERAGE_SUFFICIENCY_THRESHOLDS, ...partial };
  if (!Number.isFinite(t.maxFailedActionRatio) || t.maxFailedActionRatio < 0 || t.maxFailedActionRatio > 1) {
    throw new Error(
      `coverage sufficiency threshold maxFailedActionRatio must be between 0 and 1, got ${String(t.maxFailedActionRatio)}`,
    );
  }
  return t;
}

export interface CoverageSufficiency {
  readonly actions: number;
  readonly failedActions: number;
  /** `failedActions / actions`, 0 when no actions were taken. */
  readonly failedActionRatio: number;
  /** Actions that succeeded on a control NOT classified as global navigation. */
  readonly nonNavActionsExercised: number;
  readonly thresholds: CoverageSufficiencyThresholds;
  /** Whether the run exercised enough of its target for silence to mean `clean`. */
  readonly sufficient: boolean;
  /** Why not, when it did not (empty when sufficient). */
  readonly shortfalls: string[];
}

/** Accumulates a coverage run's action outcomes and reports whether they meet the thresholds. */
export function assessCoverageSufficiency(
  counts: { readonly actions: number; readonly failedActions: number; readonly nonNavActionsExercised: number },
  thresholds: CoverageSufficiencyThresholds,
): CoverageSufficiency {
  const { actions, failedActions, nonNavActionsExercised } = counts;
  const failedActionRatio = actions === 0 ? 0 : failedActions / actions;
  const shortfalls: string[] = [];
  if (actions === 0) shortfalls.push("no action was taken");
  // ">=" — a run where a QUARTER of its actions failed is already inconclusive, not only above it.
  // `failedActions > 0` guards a threshold of exactly 0: a run with no failures at all must not be
  // flagged just because 0 >= 0.
  if (failedActions > 0 && failedActionRatio >= thresholds.maxFailedActionRatio) {
    shortfalls.push(
      `${failedActions}/${actions} actions failed (${pct(failedActionRatio)}), at or above the ${pct(thresholds.maxFailedActionRatio)} threshold`,
    );
  }
  if (thresholds.requireNonNavControl && actions > 0 && nonNavActionsExercised === 0) {
    shortfalls.push("no non-nav (in-page) control was exercised — only global navigation");
  }
  return {
    actions,
    failedActions,
    failedActionRatio,
    nonNavActionsExercised,
    thresholds,
    sufficient: shortfalls.length === 0,
    shortfalls,
  };
}

function pct(r: number): string {
  return `${Math.round(r * 100)}%`;
}
