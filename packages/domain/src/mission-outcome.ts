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

/**
 * A goal run's (`--goal`) own endings besides the shared `MissionOutcome`s, each folded onto the
 * canonical outcome — and so onto its exit code — HERE, the one place the goal vocabulary maps to
 * the portable verdict (the CLI's `goalExitCode`, MCP `get_mission_result` and the result schema all
 * read it). #217: a goal result's `missionOutcome` is ALWAYS the folded canonical outcome; the goal's
 * own ending is carried beside it as `goalOutcome`:
 *
 *  - `succeeded` → `clean` (0): every independent success check held.
 *  - `failed`    → `defects-found` (1): the model said `done`, but an independent success check did
 *                  not hold (#209) — the check names what failed (`failure.kind: "success-check-failed"`).
 *  - `exhausted` → `defects-found` (1): the action/decision budget ran out before the checks held.
 *  - `blocked`   → `defects-found` (1): the loop stopped without the goal met — the model gave up
 *                  (no matching control, repeated unverifiable `done`), or no progress was possible.
 *
 * A vacuous check (#202) — satisfied before the run's first action — proves nothing either way: a
 * run whose only failing checks are vacuous is `inconclusive` (`failure.kind: "vacuous-check"`),
 * never one of these.
 */
export const GOAL_ONLY_OUTCOMES = ["succeeded", "exhausted", "blocked", "failed"] as const;
export type GoalOnlyOutcome = (typeof GOAL_ONLY_OUTCOMES)[number];

export const GOAL_OUTCOME_FOLD: Readonly<Record<GoalOnlyOutcome, MissionOutcome>> = {
  succeeded: "clean",
  failed: "defects-found",
  exhausted: "defects-found",
  blocked: "defects-found",
};

/**
 * Every value a goal run's `goalOutcome` can hold (#217): its own endings plus the shared outcomes a
 * goal run can end with directly (a hang, a crash, a 5xx `defects-found`, …).
 */
export const GOAL_OUTCOMES = [...GOAL_ONLY_OUTCOMES, ...MISSION_OUTCOMES] as const;
export type GoalOutcome = (typeof GOAL_OUTCOMES)[number];

/** True for a value a goal result's `goalOutcome` may hold. */
export function isGoalOutcome(value: unknown): value is GoalOutcome {
  return typeof value === "string" && (GOAL_OUTCOMES as readonly string[]).includes(value);
}

/** The canonical outcome of a goal run's own ending (a shared `MissionOutcome` folds onto itself). */
export function foldGoalOutcome(outcome: GoalOnlyOutcome | MissionOutcome): MissionOutcome {
  return Object.hasOwn(GOAL_OUTCOME_FOLD, outcome) ? GOAL_OUTCOME_FOLD[outcome as GoalOnlyOutcome] : (outcome as MissionOutcome);
}

/** The process exit code of any mission ending — a shared `MissionOutcome` or a goal run's own. */
export function outcomeExitCode(outcome: GoalOnlyOutcome | MissionOutcome): number {
  return MISSION_EXIT_CODES[foldGoalOutcome(outcome)];
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
  /**
   * #226: the app stopped answering mid-run — a navigation it was asked for got no response (e.g. its
   * server froze). Never an engine crash and never a hang finding of the browser: `inconclusive`.
   */
  | "target-unresponsive"
  /**
   * The run found nothing but exercised too little of its target for that to mean `clean` — the ONE
   * name (#209) for a coverage/exploratory frontier drained by timed-out actions (#203), one that only
   * followed global navigation, a `--feature` run that exercised nothing relevant, and an adversarial
   * run below its thresholds (its message names why, e.g. targets refused by the safety policy).
   */
  | "insufficient-coverage"
  /** The operator's configuration failed before the app was exercised — e.g. a fixture setup (#140/#144). Never a SUT finding. */
  | "configuration"
  /** No step completed within the mission's stall watchdog: it ended rather than idle (#114). */
  | "stalled"
  /** Most steps (or the finding that ended the run) ran on a starved host: it proved nothing (#203). */
  | "degraded-environment"
  /**
   * #205: the run's browsers went over the memory ceiling (`--max-browser-memory`) and the resource
   * governor ended the session — the message names the measured value and the ceiling. `inconclusive`,
   * never a crash and never a finding about the app.
   */
  | "resource-limit"
  /** Goal (#209): the model said `done`, but an independent success check did not hold. Outcome `failed`. */
  | "success-check-failed"
  /** Goal (#209): the only failing checks were vacuous (#202) — satisfied before any action. Outcome `inconclusive`. */
  | "vacuous-check"
  /** Usability (#209): the job under review was never completed — the review proves nothing about the rest. */
  | "job-incomplete"
  /**
   * Adversarial (#300): an action switched the signed-in identity and the run could not return to the
   * original one — every later check would judge another user's session, so it proves nothing past it.
   */
  | "identity-changed";

export interface MissionFailure {
  readonly kind: MissionFailureKind;
  readonly message: string;
  /** The error stack, when one was available (used for attribution, never sent to a model). */
  readonly stack?: string;
}
