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

/** The process exit code of a Journey run's outcome: 0 ok · 5 healed-pending-review · 1 otherwise. */
export function journeyExitCode(outcome: JourneyRunOutcome): number {
  return MISSION_EXIT_CODES[JOURNEY_MISSION_OUTCOME[outcome]];
}
