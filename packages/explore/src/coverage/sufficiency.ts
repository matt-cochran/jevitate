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

/**
 * The shortfall of a run that only followed global navigation (#209: with the hint on how to reach
 * `clean`). "Global navigation" is page chrome: a link inside `<nav>`/`<header>`/`<footer>`, or one
 * repeated on 2+ pages — a link in a page's own body is in-page coverage.
 */
export const ONLY_GLOBAL_NAVIGATION =
  "no non-nav (in-page) control was exercised — only global navigation (links in <nav>/<header>/<footer>, or repeated on every page); to reach clean, start --url on a page with its own controls or content links, or widen the scope with --route";

/**
 * #213: why a run took no action at all, from what the frontier saw — so "no action was taken" can
 * say why and how to reach `clean`, never just that it happened.
 */
export interface NoActionContext {
  /** Actionable (enabled, clickable) controls the seed page offered. */
  readonly seedCandidates: number;
  /** Controls the safety policy refused (name + category: session-end/destructive/paid/denied). */
  readonly refused: readonly { readonly name: string; readonly risk: string }[];
  /** Navigation chrome leaving the route scope that was never tried (the leaving-chrome share). */
  readonly outOfScopeChrome: number;
}

/** "no action was taken — <why>; to reach clean, <how>" (#213). */
export function noActionShortfall(ctx: NoActionContext | undefined): string {
  if (ctx === undefined) return "no action was taken";
  const why: string[] = [];
  const how: string[] = [];
  if (ctx.seedCandidates === 0 && ctx.refused.length === 0) {
    why.push("the start page offered no enabled control to act on");
    how.push("start --url on a page with its own controls (a signed-out page? pass --storage-state)");
  }
  if (ctx.refused.length > 0) {
    const names = ctx.refused.slice(0, 5).map((r) => `"${r.name}" (${r.risk})`).join(", ");
    const more = ctx.refused.length > 5 ? ` and ${ctx.refused.length - 5} more` : "";
    why.push(`${ctx.refused.length} control(s) were refused by the safety policy: ${names}${more}`);
    if (ctx.refused.some((r) => r.risk !== "denied")) how.push("--allow-destructive to permit the refused session-end/destructive/paid controls");
    if (ctx.refused.some((r) => r.risk === "denied")) how.push("remove the --deny pattern that matches them");
  }
  if (ctx.outOfScopeChrome > 0) {
    why.push(`${ctx.outOfScopeChrome} control(s) were only navigation chrome leaving the route scope (links in <nav>/<header>/<footer>)`);
    how.push("widen the scope with --route '<glob>' or --scope app, or start --url on a page inside the scope");
  }
  if (why.length === 0) {
    why.push("every candidate control vanished or was out of reach before it could be acted on");
    how.push("re-run it, or start --url on a page with stable controls");
  }
  return `no action was taken — ${why.join("; ")}; to reach clean: ${how.join(", or ")}`;
}

/** Accumulates a coverage run's action outcomes and reports whether they meet the thresholds. */
export function assessCoverageSufficiency(
  counts: {
    readonly actions: number;
    readonly failedActions: number;
    readonly nonNavActionsExercised: number;
    /** #213: of `failedActions`, the ones that timed out even after one retry. */
    readonly timedOutActions?: number;
    /** #213: why nothing was acted on, when nothing was. */
    readonly noAction?: NoActionContext;
  },
  thresholds: CoverageSufficiencyThresholds,
): CoverageSufficiency {
  const { actions, failedActions, nonNavActionsExercised } = counts;
  const timedOut = Math.min(counts.timedOutActions ?? 0, failedActions);
  const failedActionRatio = actions === 0 ? 0 : failedActions / actions;
  const shortfalls: string[] = [];
  if (actions === 0) shortfalls.push(noActionShortfall(counts.noAction));
  // ">=" — a run where a QUARTER of its actions failed is already inconclusive, not only above it.
  // `failedActions > 0` guards a threshold of exactly 0: a run with no failures at all must not be
  // flagged just because 0 >= 0.
  if (failedActions > 0 && failedActionRatio >= thresholds.maxFailedActionRatio) {
    const head = `${failedActions}/${actions} actions failed (${pct(failedActionRatio)}), at or above the ${pct(thresholds.maxFailedActionRatio)} threshold`;
    // #213: a TIMEOUT on a working control (a slow moment on a loaded host) is not a reason to
    // withhold it — the advice is to re-run or raise the click timeout, never --deny.
    const rerun = `re-run it, or raise the click timeout with JEVITATE_CLICK_TIMEOUT_MS (default ${DEFAULT_CLICK_TIMEOUT_MS}ms)`;
    shortfalls.push(
      timedOut === failedActions
        ? `${head} — every one timed out, even after a retry; a slow app or a loaded host can time out a working control: ${rerun}`
        : timedOut > 0
          ? `${head} — ${timedOut} timed out even after a retry (${rerun}); the other failing controls are in the transcript (actOk: false) — to reach clean they must act (or be withheld with --deny)`
          : `${head} — the failing controls are in the transcript (actOk: false); to reach clean they must act (or be withheld with --deny)`,
    );
  }
  if (thresholds.requireNonNavControl && actions > 0 && nonNavActionsExercised === 0) {
    shortfalls.push(ONLY_GLOBAL_NAVIGATION);
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

/** The default click bound (`act.ts`'s `clickTimeoutMs`), named in the timeout advice. */
const DEFAULT_CLICK_TIMEOUT_MS = 5_000;

function pct(r: number): string {
  return `${Math.round(r * 100)}%`;
}
