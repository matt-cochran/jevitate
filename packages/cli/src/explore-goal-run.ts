// explore-goal-run.ts — the goal-directed explore mission runner (#231). `runGoalExploration`
// orchestrates the phases in explore-goal-run-phases.ts; this file keeps its signature and the
// public type surface (re-exported for every existing importer/test/api-surface snapshot).
import { openModelSecretScope } from "@jevitate/ai-core";
import { evidenceOf, withRunEvidence } from "./defect-evidence.js";
import { triageOf } from "./explore-shared.js";
import { writeMissionResult } from "./mission-journal.js";
import {
  assembleGoalResult,
  buildGoalRecording,
  openGoalRunResources,
  openGoalRunSession,
  resolveGoalDefectsAndHost,
  resolveGoalJobVerdict,
  resolveGoalRunSetup,
  runGoalMission,
  writeGoalArtifacts,
  type GoalRunMissionPhase,
  type RunExplorationOptions,
  type RunExplorationResult,
} from "./explore-goal-run-phases.js";

export type { DoneCheckReader, RunExplorationOptions, RunExplorationResult } from "./explore-goal-run-phases.js";

export async function runGoalExploration(opts: RunExplorationOptions, modelSecrets: ReturnType<typeof openModelSecretScope>): Promise<RunExplorationResult> {
  const setup = await resolveGoalRunSetup(opts, modelSecrets);
  const resources = openGoalRunResources(opts, setup);
  const session = await openGoalRunSession(opts, setup, resources);
  try {
    const run: GoalRunMissionPhase = await runGoalMission(opts, setup, resources, session);
    await session.observers?.close();

    // The mission (and its hang replays) is done: restore now, so the persisted log includes it. The
    // caller restores again on every exit path (a no-op once restored).
    await setup.fx?.restore();
    const recording = buildGoalRecording(opts, setup, run.mission);
    // Never blocks the mission itself: the drain wait happens AFTER `runGoalBasedMission` returned.
    const serverLogRun = session.serverLog === undefined ? undefined : await session.serverLog.finish(run.mission.transcript);
    const defects = await resolveGoalDefectsAndHost(opts, run.mission, session, serverLogRun);
    const verdict = await resolveGoalJobVerdict(opts, run.mission, defects, run);
    const artifacts = await writeGoalArtifacts(opts, setup, resources, session, run.mission, recording, serverLogRun);

    const result = assembleGoalResult({ opts, setup, resources, session, run, recording, serverLogRun, defects, verdict, artifacts });
    // Persisted so `verify-fix` can replay a hang later (the typed result next to the Recording).
    writeMissionResult(resources.journal.recordingPath, result.missionOutcome, result.exitCode, result, resources.runUsage);
    return await withRunEvidence(result, evidenceOf(opts, setup.secrets), triageOf(opts, serverLogRun, setup.secrets));
  } finally {
    session.disarmKillSwitch();
    session.health.stop();
    // Safety net: if the mission threw before `serverLog.finish()` ran, close sources immediately
    // (no drain wait) rather than leaving them open until process exit.
    await session.serverLog?.abort();
    await session.observers?.close().catch(() => undefined);
    await session.closeSession();
  }
}
