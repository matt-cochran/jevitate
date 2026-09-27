import { MISSION_EXIT_CODES, outcomeExitCode, type MissionOutcome } from "@jevitate/domain";
import type { GoalBasedOutcome } from "@jevitate/explore";

/**
 * Exit codes for mission runs (documented in the CLI README / `explore --help`):
 *
 *  - `0` clean (goal: succeeded)
 *  - `1` defects found (goal: the success assertion did not hold — the existing convention)
 *  - `2` inconclusive or crashed — the run itself broke, so it proves nothing
 *  - `3` hang — the app under test hung and it reproduced on replay
 *  - `4` intermittent — a hang that did not reproduce on every replay
 *
 * Codes 0 and 1 keep their pre-existing meaning; 2–4 are new and never overlap a finding with a
 * broken run.
 */
export function missionExitCode(outcome: MissionOutcome): number {
  return MISSION_EXIT_CODES[outcome];
}

/**
 * The goal mission's own outcome → exit code. The mapping itself lives in ONE place —
 * `outcomeExitCode`/`GOAL_OUTCOME_FOLD` in `@jevitate/domain` (`mission-outcome.ts`) — so the CLI,
 * MCP and the result schema can never disagree: `succeeded` 0 · `failed`/`exhausted`/`blocked`/
 * `defects-found` 1 · `inconclusive`/`crashed` 2 · `hang` 3 · `intermittent` 4.
 */
export function goalExitCode(outcome: GoalBasedOutcome): number {
  return outcomeExitCode(outcome);
}
