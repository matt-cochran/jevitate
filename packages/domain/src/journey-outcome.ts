import { DEFAULT_DONE_CHECK_POLICY, type DoneCheckPolicy, type JobAttainment } from "./job-attainment.js";
import { MISSION_EXIT_CODES, type MissionOutcome } from "./mission-outcome.js";

/**
 * #453: every ending of a Journey run (`JourneyRunner`), and the one place it folds onto the portable
 * mission verdict — and so onto its exit code:
 *
 *  - `ok`                    → `clean` (0): every step and its proof held, nothing was healed.
 *  - `healed-pending-review` → `pending-review` (5): a change-explained self-heal produced a proposed
 *                              Journey revision; nothing passes until a person accepts it.
 *  - `heal-exhausted`        → `defects-found` (1): the break was explained by the change, but every
 *                              candidate was refuted or the heal budget ran out.
 *  - `quarantined`           → `defects-found` (1): a step failed and was not healed (fail-closed, an
 *                              unexplained break, a refused proof or write step).
 */
export const JOURNEY_RUN_OUTCOMES = ["ok", "healed-pending-review", "heal-exhausted", "quarantined"] as const;
export type JourneyRunOutcome = (typeof JOURNEY_RUN_OUTCOMES)[number];

export const JOURNEY_MISSION_OUTCOME: Readonly<Record<JourneyRunOutcome, MissionOutcome>> = {
  ok: "clean",
  "healed-pending-review": "pending-review",
  "heal-exhausted": "defects-found",
  quarantined: "defects-found",
};

/**
 * 0.30.0 (#800, owner decisions 2/3): what a Journey run knows about its job. Every field is optional:
 * a call that passes none (or no argument) folds exactly as before 0.30.0.
 */
export interface JourneyJobInput {
  /** The run's `job.attainment`; absent when the caller has no job verdict. */
  readonly attainment?: JobAttainment;
  /** The run's `failure.kind`; `done-check-failed` reads as `attainment: "not-achieved"`. */
  readonly failureKind?: string;
  /** `project.json` `doneCheckPolicy`; default `require` (owner decision 3). */
  readonly doneCheckPolicy?: DoneCheckPolicy;
}

/**
 * The canonical outcome of a Journey run, with its job verdict folded in (0.30.0):
 *
 *  - attainment `not-achieved` (or `failure.kind: "done-check-failed"`) → `defects-found` (1), over a
 *    pass or a pending review — never over a run already failing for another reason.
 *  - attainment `unverified` on a pass → `inconclusive` (2) under policy `require` (the default),
 *    `clean` (0) under `advisory`. A pending review stays a pending review (5).
 *  - attainment `achieved`, or no job info at all → the step outcome's own fold.
 */
export function journeyMissionOutcome(outcome: JourneyRunOutcome, job?: JourneyJobInput): MissionOutcome {
  const folded = JOURNEY_MISSION_OUTCOME[outcome];
  if (job === undefined) return folded;
  const notAchieved = job.attainment === "not-achieved" || job.failureKind === "done-check-failed";
  if (notAchieved) return folded === "clean" || folded === "pending-review" ? "defects-found" : folded;
  if (job.attainment === "unverified" && folded === "clean") {
    return (job.doneCheckPolicy ?? DEFAULT_DONE_CHECK_POLICY) === "require" ? "inconclusive" : "clean";
  }
  return folded;
}

/**
 * The process exit code of a Journey run's outcome: 0 ok · 5 healed-pending-review · 1 otherwise; with
 * job info (0.30.0) 1 for a job not achieved, and 2 for an unverified pass under policy `require`.
 */
export function journeyExitCode(outcome: JourneyRunOutcome, job?: JourneyJobInput): number {
  return MISSION_EXIT_CODES[journeyMissionOutcome(outcome, job)];
}
