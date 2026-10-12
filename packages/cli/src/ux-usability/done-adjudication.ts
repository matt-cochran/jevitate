// ux-usability/done-adjudication.ts — phase 5 of `runUsabilityMission` (#500): was the job done? The mission's verdict.
import { hangOutcome, type HangFinding } from "@jevitate/explore";
import { foldGoalOutcome, type MissionFailure, type MissionOutcome } from "@jevitate/domain";
import { finishHostHealth } from "../host-health-run.js";
import type { UsabilitySetup } from "./setup.js";
import type { UsabilityLoop } from "./loop.js";

/**
 * Phase 5 — done adjudication: the job's verdict from the loop's stop, its outcome (was the job
 * completed / verified?) and its success checks, then the host-health fold. The ONE place the
 * mission decides whether the job under review was done (#209/#213/#225).
 */
export async function adjudicateUsabilityJob(ctx: UsabilitySetup, loop: UsabilityLoop, hang: HangFinding | undefined) {
  const { health } = ctx;
  const { run, adjudication } = loop;
  // #150 — a declared mission spend budget crossed (or a paid action was refused before crossing
  // it): a clean, deliberate stop, never `crashed` — but never `clean` either (the run's own work
  // past the stop is unproven), so it maps to `inconclusive` the same as `run.stop === "inconclusive"`.
  const loopOutcome: MissionOutcome =
    run.stop === "crashed"
      ? "crashed"
      : run.stop === "inconclusive" || run.stop === "budget"
        ? "inconclusive"
        : run.stop === "hang"
          ? hangOutcome(hang?.reproduction.status ?? "inconclusive")
          : "clean";
  // #209: a review whose job was never completed (the loop gave up, ran out of budget, or its
  // `done` was never verified) did not see what a user who finished it would: its silence about
  // the rest proves nothing, so it is `inconclusive` (`job-incomplete`) — never `clean`, whatever
  // the advisory UX findings say.
  const jobIncomplete: MissionFailure | undefined =
    loopOutcome === "clean" && run.outcome.status === "incomplete"
      ? { kind: "job-incomplete", message: `the job under review was not completed: ${run.outcome.reason}` }
      : undefined;
  // #225: with success checks, THEY decide whether the job was done — folded exactly like a goal
  // run's ending (a failed check `defects-found`, a vacuous one `inconclusive`, all held `clean`).
  const checked: MissionOutcome | undefined = adjudication === undefined ? undefined : foldGoalOutcome(adjudication.outcome);
  const jobVerdict: MissionOutcome =
    loopOutcome !== "clean" ? loopOutcome : checked !== undefined ? checked : jobIncomplete === undefined ? "clean" : "inconclusive";
  // #225/#209: a failed success check is named as such (never "job-incomplete"), as on a goal run.
  const failedChecks = adjudication?.checks.filter((c) => !c.passed) ?? [];
  const checkFailure: MissionFailure | undefined =
    adjudication?.failure ??
    (failedChecks.length === 0
      ? undefined
      : { kind: "success-check-failed", message: `success check ${failedChecks.map((c) => `'${c.check}' ${c.detail}`).join("; ")}` });
  const jobFailure: MissionFailure | undefined =
    loopOutcome !== "clean" ? undefined : checked === undefined ? jobIncomplete : checked === "clean" ? undefined : (checkFailure ?? jobIncomplete);
  // #203: most steps on a starved host → `inconclusive` (degraded-environment), never `clean`.
  // #213: a job whose completion code verified (#225: its success checks held, or its done was
  // adjudicated from save signals) is a positive proof — a starved host does not undo it. Only an
  // unverified ending is downgraded, and it keeps its own reason (a failed check) in the degraded one.
  // A model-only `grounded-judgment` is not code's proof, so it is still downgraded.
  const jobVerified =
    jobVerdict === "clean" &&
    (checked === "clean" || (checked === undefined && run.outcome.status === "completed" && run.outcome.verifiedBy !== "grounded-judgment"));
  const host = await finishHostHealth(health, jobVerdict, {
    verified: jobVerified,
    ...(run.failure === undefined ? {} : { failure: run.failure }),
    ...(jobFailure === undefined ? {} : { wouldHaveBeen: jobFailure.message }),
  });
  const runOutcome: MissionOutcome = host.outcome;
  return { host, runOutcome, jobFailure };
}

export type UsabilityVerdict = Awaited<ReturnType<typeof adjudicateUsabilityJob>>;
