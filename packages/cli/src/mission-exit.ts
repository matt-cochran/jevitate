import { MISSION_EXIT_CODES, type MissionOutcome } from "@jevitate/domain";
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

/** The goal mission keeps its assertion-based codes and adds the broken-run / hang codes. */
export function goalExitCode(outcome: GoalBasedOutcome): number {
  switch (outcome) {
    case "succeeded":
      return 0;
    case "exhausted":
    case "blocked":
      return 1;
    case "inconclusive":
    case "crashed":
    case "hang":
    case "intermittent":
      return MISSION_EXIT_CODES[outcome];
  }
}
