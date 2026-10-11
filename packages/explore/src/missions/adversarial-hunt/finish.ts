/**
 * The hunt's outcome (#64, #116, #150, #300, #303): finishing every Recording segment and assembling
 * the AdversarialOutcome — moved out of `runAdversarialHunt` unchanged (#232), installed on `ctx`.
 */

import type { MissionFailure, MissionOutcome } from "@jevitate/domain";
import { deltaStatsOf } from "../../action-delta.js";
import { buildCrashReport } from "../../crash-report.js";
import { RunRecorder, emptyRecording } from "../../record.js";
import { summarizeTimings } from "../../timing.js";
import { blockedWriteCauses } from "../../blocked-cause.js";
import type { AdversarialOutcome, AdversarialStop } from "../adversarial.js";
import type { HuntState } from "./context.js";
import { MAX_LISTED_DEPARTURES, freeze, freezeAdvisory } from "./helpers.js";

/** Installs `ctx.finish`. */
export function installFinish(ctx: HuntState): void {
  ctx.finish = (
    outcome: AdversarialOutcome["outcome"],
    stop: AdversarialStop,
    failure?: MissionFailure,
  ): AdversarialOutcome => {
    ctx.noteBlocked(ctx.offAllowlist.drain(), Math.max(0, ctx.transcript.nextStep - 1));
    const finished = (ctx.segments[0] as RunRecorder).tryFinish({ intent: "adversarial" });
    const later = ctx.segments.map((r, i) => {
      if (i === 0) return null;
      const f = r.tryFinish({ intent: "adversarial (after reset)" });
      return f.ok ? f.recording : null;
    });
    const recordingFailure: MissionFailure | undefined = finished.ok
      ? undefined
      : { kind: "exception", message: `recording rejected: ${finished.reason}` };
    const coverage = ctx.cov.report(ctx.thresholds, ctx.outOfScopeSteps);
    // A run that found nothing only means something if it tried: below the coverage thresholds a
    // silent run proved nothing about its target, so it is `inconclusive` — never `clean`.
    const thin = outcome === "clean" && !coverage.sufficient;
    const coverageFailure: MissionFailure | undefined = thin
      ? { kind: "insufficient-coverage", message: `coverage below thresholds: ${coverage.shortfalls.join("; ")}` }
      : undefined;
    const finalFailure = failure ?? recordingFailure ?? coverageFailure;
    const honest: MissionOutcome = thin ? "inconclusive" : outcome;
    return {
      coverage,
      outcome: finished.ok ? honest : "crashed",
      stop: finished.ok ? stop : "crashed",
      defects: [...ctx.defects.values()].map((d) => freeze(d, later, ctx.stepDeltas)),
      advisories: [...ctx.advisories.values()].map(freezeAdvisory),
      hangs: [...ctx.hangs.values()],
      recording: finished.ok ? finished.recording : emptyRecording(ctx.site, finished.reason),
      transcript: ctx.transcript.entries(),
      ...(finalFailure === undefined ? {} : { failure: finalFailure }),
      heap: ctx.heap.samples(),
      timing: summarizeTimings(ctx.timings),
      scope: { routeGlobs: ctx.routeGlobs, outOfScopeSteps: ctx.outOfScopeSteps, departures: ctx.departures.slice(0, MAX_LISTED_DEPARTURES), resets: ctx.sessions.resets },
      ...(ctx.declared === null ? {} : { invariants: ctx.declared.report() }),
      ...(ctx.budget === null ? {} : { budget: ctx.budget.trajectory() }),
      ...(ctx.identityChanges.length === 0 ? {} : { identityChanges: [...ctx.identityChanges] }),
      ...(ctx.pageDeltas === null ? {} : { actionDeltas: deltaStatsOf([...ctx.stepDeltas.values()]) }),
      ...ctx.safety.result(),
      ...(ctx.blockedWrites.length === 0 ? {} : { blockedWrites: [...ctx.blockedWrites] }),
      // #484: each blocked write is an environment fault, the findings it caused grouped beneath it.
      ...(ctx.blockedConsequences.size === 0 ? {} : { blockedConsequences: [...ctx.blockedConsequences.values()] }),
      ...(ctx.blockedRoots.length === 0
        ? {}
        : { environmentFaults: { causes: blockedWriteCauses(ctx.blockedRoots, [...ctx.blockedConsequences.values()]) } }),
      ...(outcome === "crashed" && finalFailure !== undefined
        ? {
            crash: buildCrashReport(finalFailure, ctx.crashWatch.signals(), ctx.heap.samples(), {
              ...(ctx.crashHost === undefined ? {} : { host: ctx.crashHost }),
            }),
          }
        : {}),
    };
  };
}
