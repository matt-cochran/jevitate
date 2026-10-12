/**
 * `adjudicatedRun`'s early-verdict phase (#500: moved verbatim out of `goal-based.ts`): the endings
 * decided without the success oracle — a hang, a broken run, a budget stop, a find-out goal.
 */
import type { ExploreRun } from "../../explore.js";
import type { HangFinding } from "../../hang-repro.js";
import type { GoalBasedResult } from "../goal-based.js";
import { whyNot } from "./checks.js";
import { hangResult, reproduceSeedHang } from "./hang.js";
import type { Adjudication } from "./setup.js";

/** The mission's result when the run already decided it, else null (the oracle judges it). */
export async function earlyVerdict(ctx: Adjudication, run: ExploreRun, intermittentHangs: HangFinding[]): Promise<GoalBasedResult | null> {
  const { cfg, effort, hasChecks } = ctx;
  // A hang is a first-class finding: reproduce it in fresh contexts, then report k/N.
  if (run.stop === "hang" && run.hang !== undefined) {
    const h = run.hang;
    const reproduction = await reproduceSeedHang(cfg, run, h);
    return { ...hangResult(run, h, reproduction), ...(intermittentHangs.length === 0 ? {} : { intermittentHangs }) };
  }

  // A broken run proves nothing: its assertion is never evaluated into a pass.
  if (run.stop === "crashed" || run.stop === "inconclusive") {
    return {
      outcome: run.stop,
      assertionPassed: false,
      checks: [],
      run,
      recording: run.recording,
      transcript: run.transcript,
      finalUrl: run.finalUrl,
      reason: whyNot(run, []),
      ...(intermittentHangs.length === 0 ? {} : { intermittentHangs }),
    };
  }

  // #150 — a declared mission spend budget was crossed (or a paid action refused before crossing
  // it): the run stopped cleanly, before its next action. Never `succeeded`, never `crashed` — maps
  // to `inconclusive` (its own work past the stop is unproven), kept apart from `run.stop`.
  if (run.stop === "budget") {
    return {
      outcome: "inconclusive",
      assertionPassed: false,
      checks: [],
      run,
      recording: run.recording,
      transcript: run.transcript,
      finalUrl: run.finalUrl,
      reason: whyNot(run, []),
      ...(effort.warnings.length === 0 ? {} : { warnings: effort.warnings }),
      ...(intermittentHangs.length === 0 ? {} : { intermittentHangs }),
    };
  }

  // A find-out goal (#130d): no --success check was given, so there is nothing to evaluate against
  // the live page. The verdict is the run's own grounded outcome instead — `report` grounding an
  // answer (#101), or the advisory goal judgment grounding a `done`. Never a vacuous pass: a run that
  // exhausted its budget or got blocked without either is simply not succeeded.
  if (!hasChecks) {
    const succeeded = run.outcome.status === "completed";
    return {
      outcome: succeeded ? "succeeded" : run.stop === "exhausted" ? "exhausted" : "blocked",
      assertionPassed: succeeded,
      checks: [],
      run,
      recording: run.recording,
      transcript: run.transcript,
      finalUrl: run.finalUrl,
      ...(succeeded ? {} : { reason: whyNot(run, []) }),
      // #424: a minimum effort capped by the budget is named.
      ...(effort.warnings.length === 0 ? {} : { warnings: effort.warnings }),
      // #126 evidence on the find-out path too, like every other outcome (surface-wiring audit).
      ...(intermittentHangs.length === 0 ? {} : { intermittentHangs }),
    };
  }

  return null;
}
