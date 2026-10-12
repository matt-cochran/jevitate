/** The goal mission's hang reproduction and hang result (#500: moved verbatim out of `goal-based.ts`). */
import type { ExploreRun } from "../../explore.js";
import { NOT_REPLAYED, hangFinding, reproduceHang, withheldReason, type HangReproduction } from "../../hang-repro.js";
import type { GoalBasedMissionConfig, GoalBasedResult } from "../goal-based.js";

/** Reproduce a hang the loop stopped on, in fresh contexts (owner ruling 7). */
export async function reproduceSeedHang(
  cfg: GoalBasedMissionConfig,
  run: ExploreRun,
  h: NonNullable<ExploreRun["hang"]>,
): Promise<HangReproduction> {
  return cfg.openFreshSession === undefined
    ? NOT_REPLAYED
    : await reproduceHang({
        recording: run.recording,
        recordingStepIndex: h.recordingStepIndex,
        hang: h.signal,
        openSession: cfg.openFreshSession,
        ...(cfg.hangReplays === undefined ? {} : { attempts: cfg.hangReplays }),
        perceive: {
          ...(cfg.renderWaitMs === undefined ? {} : { renderWaitMs: cfg.renderWaitMs }),
          ...(cfg.hangProbeMs === undefined ? {} : { hangProbeMs: cfg.hangProbeMs }),
          ...(cfg.requestBoundMs === undefined ? {} : { requestBoundMs: cfg.requestBoundMs }),
          ...(cfg.settle === undefined ? {} : { settleConfig: cfg.settle }),
          ...(cfg.hangs === undefined ? {} : { hangConfig: cfg.hangs }),
        },
        ...(cfg.stallMs === undefined ? {} : { stallMs: cfg.stallMs }),
        ...(cfg.safety === undefined ? {} : { safety: cfg.safety }),
        ...(cfg.fixtureRoot === undefined ? {} : { fixtureBaseDir: cfg.fixtureRoot }),
        // #181: a control the run saw fire a write is never replayed by default, whatever its name.
        writtenBy: run.sideEffects.map((e) => e.control),
      });
}

/** The mission-ending result for a hang whose reproduction is already known. */
export function hangResult(run: ExploreRun, h: NonNullable<ExploreRun["hang"]>, reproduction: HangReproduction): GoalBasedResult {
  const finding = hangFinding(h.signal, run.transcript, h.recordingStepIndex, reproduction);
  return {
    // A hang whose replays could not run at all is `inconclusive`, never a non-reproduction.
    outcome: reproduction.status === "reproduced" ? "hang" : reproduction.status,
    assertionPassed: false,
    checks: [],
    run,
    recording: run.recording,
    transcript: run.transcript,
    finalUrl: run.finalUrl,
    hang: finding,
    reason:
      reproduction.withheld !== undefined
        ? `${finding.title} (${withheldReason(reproduction.withheld)})`
        : reproduction.attempts === 0
        ? `${finding.title} (unconfirmed: not replayed)`
        : `${finding.title} (reproduced ${reproduction.reproduced}/${reproduction.attempts})`,
  };
}
