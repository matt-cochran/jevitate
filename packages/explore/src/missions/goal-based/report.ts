/**
 * `adjudicatedRun`'s report phase (#500: moved verbatim out of `goal-based.ts`): the mission's
 * result, its run outcome kept in agreement with the final verdict (#113).
 */
import type { ExploreRun, RunOutcome } from "../../explore.js";
import type { HangFinding } from "../../hang-repro.js";
import type { GoalBasedResult } from "../goal-based.js";
import type { Verdict } from "./adjudicate.js";
import { whyNot } from "./checks.js";

export function report(run: ExploreRun, verdict: Verdict, intermittentHangs: HangFinding[]): GoalBasedResult {
  const { results, warnings, assertionPassed, outcome, failure } = verdict;
  // `runOutcome` and `outcome` must never disagree (#113): the in-run `done` grounding (the
  // `successCheck` given to `explore` above) evaluates every check EXCEPT `reloadThen` — a mid-run
  // reload would throw away state the run is still building — so a run can end `completed` there and
  // this, the final, full evaluation (including `reloadThen`) can still fail. The final verdict
  // overrides: a mission that did not succeed never carries a `completed` runOutcome.
  const runOutcome: RunOutcome =
    !assertionPassed && run.outcome.status === "completed"
      ? { status: "incomplete", reason: whyNot(run, results) }
      : run.outcome;
  const finalRun: ExploreRun = runOutcome === run.outcome ? run : { ...run, outcome: runOutcome };

  return {
    outcome,
    assertionPassed,
    checks: results,
    run: finalRun,
    recording: run.recording,
    transcript: run.transcript,
    finalUrl: run.finalUrl,
    ...(outcome === "succeeded" ? {} : { reason: whyNot(run, results) }),
    ...(failure === undefined ? {} : { failure }),
    ...(intermittentHangs.length === 0 ? {} : { intermittentHangs }),
    ...(warnings.length === 0 ? {} : { warnings }),
  };
}
