// ux-usability/result.ts — phase 6 of `runUsabilityMission` (#500): the report and the typed, persisted result.
import { writeFile } from "node:fs/promises";
import { resolve as resolvePath } from "node:path";
import { finalizeVideos } from "../browser-run-options.js";
import { evidenceOf, withRunEvidence } from "../defect-evidence.js";
import type { HangFinding } from "@jevitate/explore";
import { buildReport, calibrationCaveat, claimsCaveat, groundFindings, withSignalFindings } from "@jevitate/ux";
import { NO_PRODUCT_FACTS_CAVEAT } from "../ux-product.js";
import type { MissionFailure, MissionOutcome } from "@jevitate/domain";
import { resultPathFor, writeMissionResult } from "../mission-journal.js";
import { MISSION_RESULT_SCHEMA_VERSION, advisoryDefects, defectFields, type AdvisoryServerLogDefect } from "../result-schema.js";
import { missionExitCode } from "../mission-exit.js";
import { branchFields } from "../journey-prefix.js";
import { failureWithHostStarved } from "../host-health-run.js";
import type { Http5xxDefect } from "@jevitate/explore";
import { currentEngineInfo } from "../engine.js";
import { triageOf } from "../explore-shared.js";
import { serverLogResult } from "../explore-api.js";
import { UxAnalysisFailedError } from "../ux-review.js";
import type { RunUsabilityMissionOptions, RunUsabilityMissionResult } from "../ux-usability.js";
import type { UsabilitySetup } from "./setup.js";
import type { UsabilityLoop } from "./loop.js";
import type { UsabilityAnalysis } from "./analysis.js";
import type { UsabilityVerdict } from "./done-adjudication.js";

/**
 * Phase 6 — result: every context closed (videos finalized), the result's common fields, then the
 * report (or the typed analysis-unavailable result), persisted and returned with its run evidence.
 */
export async function writeUsabilityResult(
  ctx: UsabilitySetup,
  loop: UsabilityLoop,
  analysis: UsabilityAnalysis,
  hang: HangFinding | undefined,
  verdict: UsabilityVerdict,
): Promise<RunUsabilityMissionResult> {
  const { opts, runCapture, videoDir, closeSession, journal, collected, screenshotDir, capture, runUsage, http5xx, secrets, minConfidence, quality, maxFindingsPerRoute, product, reportPath } = ctx;
  const { start, run, serverLogRun, budget, adjudication } = loop;
  const { signalFindings, friction, outcome, evidenceWritten } = analysis;
  const { host, runOutcome, jobFailure } = verdict;
  // #245: every context closed (videos finalized) before the result naming them is written.
  const shotFields = await runCapture.finish();
  const videos = await finalizeVideos(videoDir, closeSession);
  const base = {
    schemaVersion: MISSION_RESULT_SCHEMA_VERSION,
    strategy: "usability" as const,
    target: {
      seedUrl: start.persistUrl,
      allowlist: [...opts.allowlist],
      ...(opts.storageState !== undefined ? { storageStatePath: resolvePath(opts.storageState) } : {}),
    },
    ...branchFields(start),
    recordingPaths: [journal.recordingPath],
    ...videos,
    ...shotFields,
    resultPath: resultPathFor(journal.recordingPath),
    hangs: hang === undefined ? [] : [hang],
    timing: run.timing,
    stop: run.stop,
    outcome: run.outcome,
    ...(run.answer === undefined ? {} : { answer: run.answer }),
    screensObserved: collected.length,
    transcriptPath: journal.transcriptPath,
    screenshotDir,
    evidencePath: evidenceWritten,
    screenshots: capture.screenshots(),
    sideEffects: run.sideEffects,
    ...(run.sideEffectsTruncated === undefined ? {} : { sideEffectsTruncated: run.sideEffectsTruncated }),
    ...(run.safetyOverrides === undefined ? {} : { safetyOverrides: run.safetyOverrides }),
    ...(run.actionDeltas === undefined ? {} : { actionDeltas: run.actionDeltas }),
    engine: currentEngineInfo(),
    ...((): { failure?: MissionFailure } => {
      const f = failureWithHostStarved(host, run.failure ?? host.failure ?? jobFailure);
      return f === undefined ? {} : { failure: f };
    })(),
    ...(run.crash === undefined ? {} : { crash: run.crash }),
    finalUrl: run.finalUrl,
    decisions: run.decisions,
    actions: run.actions,
    depth: run.depth,
    ...(runUsage === undefined ? {} : { usage: runUsage.snapshot() }),
    ...(hang === undefined ? {} : { hang }),
    // #142 follow-up: reported but never gates `missionOutcome`/`exitCode` — a UX finding is
    // always advisory, and a `server-log` defect here is treated the same way. So is an HTTP 5xx
    // hard-signal defect (#208): listed with its fingerprint (verify-fix replays it), advisory here.
    ...serverLogResult(serverLogRun),
    ...defectFields<AdvisoryServerLogDefect | (Http5xxDefect & { readonly advisory: true })>([
      ...http5xx.defects(run.transcript, run.recording.pages.flatMap((p) => p.steps)[0]?.step.kind === "navigate" ? 1 : 0).map((d) => ({ ...d, advisory: true as const })),
      ...advisoryDefects(serverLogRun?.defects),
    ]),
    ...(budget === null ? {} : { budget: budget.trajectory() }),
    ...(adjudication === undefined
      ? {}
      : {
          goalOutcome: adjudication.outcome,
          checks: adjudication.checks,
          ...(adjudication.warnings === undefined ? {} : { checkWarnings: adjudication.warnings }),
        }),
    ...host.fields,
  };
  if (outcome.kind === "failed") {
    // The analysis is the review's product: without it the review is inconclusive (never a
    // fabricated clean report) — but the run's transcript is kept, and this is a typed result.
    const why = new UxAnalysisFailedError(outcome.reason, outcome.screenId, outcome.rubricItemId).message;
    const missionOutcome: MissionOutcome = runOutcome === "clean" ? "inconclusive" : runOutcome;
    const unavailable = {
      ...base,
      report: null,
      reportPath: null,
      missionOutcome,
      exitCode: missionExitCode(missionOutcome),
      analysisUnavailable: why,
    };
    // Persisted like every other mission's typed result, so MCP `get_mission_result` can read it (#117).
    return await withRunEvidence({ ...unavailable, resultPath: writeMissionResult(journal.recordingPath, missionOutcome, unavailable.exitCode, unavailable, runUsage) }, evidenceOf(opts, secrets), triageOf(opts, serverLogRun, secrets));
  }
  const report = buildReport(groundFindings(withSignalFindings(outcome, signalFindings), friction), {
    minConfidence,
    quality,
    maxFindingsPerRoute,
    ...(product.facts === undefined ? { evidenceCaveats: [NO_PRODUCT_FACTS_CAVEAT] } : {}),
    calibrationCaveats: [calibrationCaveat(opts.appContext.appClass), claimsCaveat()],
  });
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  const reviewed = { ...base, report, reportPath, missionOutcome: runOutcome, exitCode: missionExitCode(runOutcome) };
  return await withRunEvidence({ ...reviewed, resultPath: writeMissionResult(journal.recordingPath, runOutcome, reviewed.exitCode, reviewed, runUsage) }, evidenceOf(opts, secrets), triageOf(opts, serverLogRun, secrets));
}
