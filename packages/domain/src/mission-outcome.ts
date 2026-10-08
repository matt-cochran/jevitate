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
  | "identity-changed"
  /**
   * #427: the pre-flight auth check found the run's session (`--storage-state`, a persona's) expired —
   * the start URL landed on a sign-in page — and it could not be refreshed. The run ended before the
   * mission started (the login page is never explored): `inconclusive`. `persona` names whose.
   */
  | "auth-expired";

export interface MissionFailure {
  readonly kind: MissionFailureKind;
  readonly message: string;
  /** #427 (`auth-expired`): the persona whose session expired, when the session was a persona's. */
  readonly persona?: string;
  /** The error stack, when one was available (used for attribution, never sent to a model). */
  readonly stack?: string;
}

/**
 * #421/#423 — a run's defect verdict, orthogonal to whether a goal was reached: `defects` when at
 * least one GATING defect (`result.defects[]` not marked `advisory: true`) was recorded, else `none`.
 * `byKind` counts those gating defects per `kind` (`server-log`, `http-5xx`, `invariant`, …) — THE
 * per-run defect summary; `advisoryByKind` (omitted when empty) counts the advisory ones a strategy
 * reports but never gates on. Hangs are not defects: they have their own outcome (`hang`/`intermittent`).
 */
export const DEFECT_OUTCOME_STATUSES = ["none", "defects"] as const;
export type DefectOutcomeStatus = (typeof DEFECT_OUTCOME_STATUSES)[number];

export interface DefectOutcome {
  readonly status: DefectOutcomeStatus;
  readonly byKind: Readonly<Record<string, number>>;
  readonly advisoryByKind?: Readonly<Record<string, number>>;
}

/** The defect verdict of a run's `defects[]` (see `DefectOutcome`). */
export function defectOutcomeOf(defects: ReadonlyArray<{ readonly kind: string; readonly advisory?: true }>): DefectOutcome {
  const byKind: Record<string, number> = {};
  const advisoryByKind: Record<string, number> = {};
  for (const d of defects) {
    const into = d.advisory === true ? advisoryByKind : byKind;
    into[d.kind] = (into[d.kind] ?? 0) + 1;
  }
  return {
    status: Object.keys(byKind).length > 0 ? "defects" : "none",
    byKind,
    ...(Object.keys(advisoryByKind).length > 0 ? { advisoryByKind } : {}),
  };
}

/**
 * #423 — THE table: a goal run's `missionOutcome` derived from its two orthogonal verdicts, the goal's
 * own ending (`goalOutcome`: did the agent reach the goal?) and the run's defects (`defectOutcome`:
 * did the app break?). The exit code is `MISSION_EXIT_CODES[missionOutcome]`, unchanged from before
 * the split (0.7.0) for every combination:
 *
 * | goalOutcome                          | defectOutcome `none`  | defectOutcome `defects` |
 * |--------------------------------------|-----------------------|-------------------------|
 * | `succeeded` (`clean`)                | `clean` (0)           | `defects-found` (1)     |
 * | `failed` / `exhausted` / `blocked`   | `defects-found` (1)   | `defects-found` (1)     |
 * | `defects-found`                      | `defects-found` (1)   | `defects-found` (1)     |
 * | `hang`                               | `hang` (3)            | `hang` (3)              |
 * | `intermittent`                       | `intermittent` (4)    | `intermittent` (4)      |
 * | `inconclusive` / `crashed`           | that outcome (2)      | that outcome (2)        |
 *
 * A goal not achieved with zero defects stays `defects-found` (exit 1, the CLI's long-standing
 * "the check failed" code) — `goalOutcome` + `goalReason` and `defectOutcome.status: "none"` are what
 * tell "untested because the agent could not do it" from "tested and found bugs". A hang or a broken
 * run dominates defects (they are still listed and counted). `goalOutcome: "defects-found"` only
 * remains when a violated invariant overrode an `inconclusive` budget/vacuous stop (#150/#209).
 */
export function goalMissionOutcome(goalOutcome: GoalOnlyOutcome | MissionOutcome, defects: DefectOutcomeStatus): MissionOutcome {
  const folded = foldGoalOutcome(goalOutcome);
  return defects === "defects" && folded === "clean" ? "defects-found" : folded;
}

/**
 * #423 — why a goal was NOT achieved (`goalReason`, on every goal result whose `goalOutcome` is not
 * `succeeded`), decided by code from the run's own state, never parsed from `reason`:
 *
 *  - `success-check-failed` — the model said done, but an independent success check did not hold.
 *  - `not-found`        — a find-out goal's report found no answer on the pages it searched.
 *  - `ungrounded`       — the model's answer was rejected as not grounded until the run gave up.
 *  - `blocked-by-policy` — the model gave up after the safety policy refused a control it chose.
 *  - `gave-up`          — the model reported the goal cannot be advanced (no other cause known).
 *  - `no-progress`      — the run stopped because its actions changed nothing.
 *  - `budget`           — an action/decision budget (`exhausted`) or a spend budget ran out.
 *  - `hang`             — the app hung (`hang` / `intermittent`).
 *  - `vacuous-check`    — every failing check was satisfied before the first action.
 *  - `broken-run`       — the run itself broke or proved nothing (crash, unreachable/unresponsive
 *                         target, starved host, unreadable `--log-defect` oracle, kill, …).
 *  - `defects`          — only for `goalOutcome: "defects-found"` with no other known cause.
 */
export const GOAL_REASONS = [
  "success-check-failed",
  "not-found",
  "ungrounded",
  "blocked-by-policy",
  "gave-up",
  "no-progress",
  "budget",
  "hang",
  "vacuous-check",
  "broken-run",
  "defects",
] as const;
export type GoalReason = (typeof GOAL_REASONS)[number];

export interface GoalReasonInput {
  /** The goal's own ending (`goalOutcome`). */
  readonly goalOutcome: GoalOnlyOutcome | MissionOutcome;
  /** The ending a violated invariant overrode, when it did (`goalOutcome` is then `defects-found`). */
  readonly overridden?: GoalOnlyOutcome | MissionOutcome;
  /** The loop's stop reason (`done`, `blocked`, `no-progress`, `exhausted`, `budget`, …). */
  readonly stop?: string;
  /** The run's `failure.kind`, when it had one. */
  readonly failureKind?: string;
  /** The loop's structured miss cause (`not-found`, `ungrounded`, `blocked-by-policy`). */
  readonly missCause?: string;
}

/** The goal's structured miss reason (see `GOAL_REASONS`); `undefined` for a `succeeded` goal. */
export function goalReasonOf(i: GoalReasonInput): GoalReason | undefined {
  const own = i.goalOutcome === "defects-found" && i.overridden !== undefined ? i.overridden : i.goalOutcome;
  const cause = (GOAL_REASONS as readonly string[]).includes(i.missCause ?? "") ? (i.missCause as GoalReason) : undefined;
  switch (own) {
    case "succeeded":
    case "clean":
      return undefined;
    case "failed":
      return "success-check-failed";
    case "exhausted":
      return "budget";
    case "blocked":
      return cause ?? (i.stop === "no-progress" ? "no-progress" : "gave-up");
    case "hang":
    case "intermittent":
      return "hang";
    case "inconclusive":
      if (i.failureKind === "vacuous-check") return "vacuous-check";
      if (i.stop === "budget") return "budget";
      return "broken-run";
    case "crashed":
      return "broken-run";
    case "defects-found":
      return "defects";
  }
}
