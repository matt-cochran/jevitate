import type { Assertion, Recording } from "@jevitate/recording";
import { checkAssertion } from "@jevitate/interpreter";
import { explore, type ExploreConfig, type ExploreRun, type TranscriptEntry } from "../explore.js";

/**
 * The goal-based exploratory mission (P1's first mission).
 *
 * Runs the bounded exploration loop toward `goal`, then adjudicates success
 * with an INDEPENDENT oracle: a user-supplied `Assertion` from the recording
 * schema, evaluated by the SAME assertion engine replay uses
 * (`@jevitate/interpreter`'s `checkAssertion`). Jev's `done` is advisory only —
 * it can propose the goal is met, but it never certifies it (guardrail #4).
 *
 * Outcome:
 *  - `succeeded`  — the success assertion holds against the live final page.
 *  - `exhausted`  — the assertion did not hold and the loop hit a budget cap.
 *  - `blocked`    — the assertion did not hold and the loop stopped otherwise
 *                   (model done/blocked, no valid target, no-progress, …).
 *
 * The durable product is always the emitted `Recording`, whatever the outcome.
 */

export interface GoalBasedMissionConfig extends Omit<ExploreConfig, "missionContext"> {
  /** The independent success oracle (user-supplied). */
  readonly successAssertion: Assertion;
  /** Overall bound for the oracle's bounded polling check (ms). Default 3000. */
  readonly oracleTimeoutMs?: number;
}

export type GoalBasedOutcome = "succeeded" | "exhausted" | "blocked";

export interface GoalBasedResult {
  readonly outcome: GoalBasedOutcome;
  /** Whether the independent assertion held (the ONLY success signal). */
  readonly assertionPassed: boolean;
  readonly run: ExploreRun;
  readonly recording: Recording;
  readonly transcript: TranscriptEntry[];
  readonly finalUrl: string;
}

export async function runGoalBasedMission(
  cfg: GoalBasedMissionConfig,
): Promise<GoalBasedResult> {
  const run = await explore({
    ...cfg,
    missionContext:
      "success is judged independently by a user-supplied assertion — your `done` is only a proposal, not the verdict",
  });

  // Independent oracle: never Jev's self-report. Evaluated against the live page.
  const assertionPassed = await checkAssertion(cfg.actor, cfg.successAssertion, {
    timeoutMs: cfg.oracleTimeoutMs ?? 3000,
  });

  const outcome: GoalBasedOutcome = assertionPassed
    ? "succeeded"
    : run.stop === "exhausted"
      ? "exhausted"
      : "blocked";

  return {
    outcome,
    assertionPassed,
    run,
    recording: run.recording,
    transcript: run.transcript,
    finalUrl: run.finalUrl,
  };
}
