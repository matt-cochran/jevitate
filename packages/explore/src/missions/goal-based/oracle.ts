/**
 * `adjudicatedRun`'s oracle phase (#500: moved verbatim out of `goal-based.ts`): every success check,
 * evaluated independently against the live page — an oracle that cannot be evaluated is a crash.
 */
import type { SuccessCheckResult } from "../../success-checks.js";
import type { ExploreRun } from "../../explore.js";
import type { HangFinding } from "../../hang-repro.js";
import type { GoalBasedResult } from "../goal-based.js";
import { evaluateChecks } from "./checks.js";
import type { Adjudication } from "./setup.js";

/** The oracle's results (and the vacuous network checks it met), or the crashed mission's result. */
export type OracleOutcome =
  | { readonly kind: "ended"; readonly result: GoalBasedResult }
  | { readonly kind: "evaluated"; readonly results: SuccessCheckResult[]; readonly vacuousNetwork: string[] };

export async function evaluateOracle(ctx: Adjudication, run: ExploreRun, intermittentHangs: HangFinding[]): Promise<OracleOutcome> {
  const { cfg, checks, page, capture, scope } = ctx;
  // Independent oracle: never Jev's self-report. Evaluated against the live page. An oracle that
  // cannot even be evaluated (the page died after the loop ended) is a crash, never a pass.
  let results: SuccessCheckResult[];
  /** #202: network checks matched only by a request sent before the run's first action. */
  const vacuousNetwork: string[] = [];
  try {
    results = await evaluateChecks(cfg, checks, page, capture, scope(), (spec) => vacuousNetwork.push(spec));
  } catch (e) {
    const message = e instanceof Error ? e.message.split("\n")[0] ?? e.message : String(e);
    const crashedRun: ExploreRun = {
      ...run,
      stop: "crashed",
      failure: { kind: "exception", message: `success oracle failed: ${message}` },
    };
    return { kind: "ended", result: {
      outcome: "crashed",
      assertionPassed: false,
      checks: [],
      run: crashedRun,
      recording: run.recording,
      transcript: run.transcript,
      finalUrl: run.finalUrl,
      reason: `success oracle failed: ${message}`,
      ...(intermittentHangs.length === 0 ? {} : { intermittentHangs }),
    } };
  }
  return { kind: "evaluated", results, vacuousNetwork };
}
