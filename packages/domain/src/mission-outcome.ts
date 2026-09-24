/**
 * The typed verdict every mission run ends with — CLI and MCP alike. Finding a defect is the
 * mission's SUCCESS case, so it is data (`defects-found`), never an exception; a mission that
 * could not finish its work is `inconclusive` or `crashed` and is NEVER `clean`. Fail closed on
 * meaning: a broken run proves nothing, so it can never read as a pass.
 *
 *  - `clean`          — the run completed its budget and found nothing.
 *  - `defects-found`  — at least one confirmed defect (hard signal) was recorded.
 *  - `hang`           — the app under test hung and the hang reproduced on replay.
 *  - `intermittent`   — a hang was observed but did not reproduce on every replay.
 *  - `inconclusive`   — the run could not do its work (e.g. the page never rendered, a required
 *                       model call stayed unavailable after retries).
 *  - `crashed`        — the engine failed (browser/page crash, unexpected exception).
 */
export const MISSION_OUTCOMES = [
  "clean",
  "defects-found",
  "hang",
  "intermittent",
  "inconclusive",
  "crashed",
] as const;

export type MissionOutcome = (typeof MISSION_OUTCOMES)[number];

/**
 * Process exit code per outcome. `0` (clean) and `1` (defects found — a failing check, the
 * existing CLI convention) are unchanged; the new codes are distinct so a caller can tell a
 * broken run from a finding:
 *
 *  - `0` clean · `1` defects-found · `2` inconclusive / crashed · `3` hang · `4` intermittent
 */
export const MISSION_EXIT_CODES: Readonly<Record<MissionOutcome, number>> = {
  clean: 0,
  "defects-found": 1,
  inconclusive: 2,
  crashed: 2,
  hang: 3,
  intermittent: 4,
};

/**
 * Severity order used when a run has several verdict inputs: a broken run dominates any
 * finding (its findings are kept, but the run proves nothing about what it did not reach);
 * a confirmed hang dominates a defect; an unconfirmed (intermittent) hang still beats clean.
 */
const SEVERITY: Readonly<Record<MissionOutcome, number>> = {
  clean: 0,
  intermittent: 1,
  "defects-found": 2,
  hang: 3,
  inconclusive: 4,
  crashed: 5,
};

/** The more severe of two outcomes. */
export function worstOutcome(a: MissionOutcome, b: MissionOutcome): MissionOutcome {
  return SEVERITY[b] > SEVERITY[a] ? b : a;
}

/** The most severe outcome in a list; `clean` for an empty list. */
export function combineOutcomes(outcomes: readonly MissionOutcome[]): MissionOutcome {
  return outcomes.reduce<MissionOutcome>((acc, o) => worstOutcome(acc, o), "clean");
}

/** True for outcomes that mean the run itself broke (its silence proves nothing). */
export function isBrokenRun(outcome: MissionOutcome): boolean {
  return outcome === "inconclusive" || outcome === "crashed";
}

/** What went wrong when an engine failure ended a run. */
export type MissionFailureKind =
  | "exception"
  | "page-crash"
  | "browser-disconnected"
  | "page-closed"
  /** The run could not reach (or stay on) the page it was asked to test — e.g. the start URL redirects elsewhere. */
  | "target-unreachable"
  /** The run found nothing but exercised too little of its target for that to mean `clean`. */
  | "insufficient-coverage";

export interface MissionFailure {
  readonly kind: MissionFailureKind;
  readonly message: string;
  /** The error stack, when one was available (used for attribution, never sent to a model). */
  readonly stack?: string;
}
