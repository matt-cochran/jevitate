import { readFile } from "node:fs/promises";
import { Command } from "commander";
import { RecordingSchema, type Recording } from "@jevitate/recording";
import { MissingCredentialError, UsageTracker, type JudgmentPort, type GenerationPort } from "@jevitate/ai-core";
import { ok, fail } from "./envelope.js";
import { withEngine } from "./engine.js";
import { discoverRecordingSidecars, loadRecordingSidecars, runUxReview, UxAnalysisFailedError } from "./ux-api.js";
import { UxConfigError } from "./ux-config.js";
import { MinConfidenceError, QualityPolicyError, MaxFindingsPerRouteError } from "@jevitate/ux";
import { type CliDeps, emitJson, GatewaySelectionError, buildExploreGateways } from "./cli-shared.js";

/** Registers `jevitate ux <recording>`. */
export function registerUxCommands(program: Command, deps: CliDeps): void {
  // Additive: `jevitate ux <recording>` (issue #30) — offline UX review of a
  // saved Recording. Findings are advisory; a `failed` analysis is a non-zero
  // fail envelope (never a fabricated clean report).
  program
    .command("ux <recording>")
    .description("offline UX review of a saved Recording — ranked, cited usability findings")
    .option("--app-class <class>", "app class for calibration (required), e.g. consumer|admin|internal")
    .option(
      "--show <labels>",
      "opt-in filter on the quality grade (comma list of actionable,relevant-minor,generic,wrong); others are suppressed and counted; default JEVITATE_UX_SHOW, then ~/.jevitate/config.json ux.show, then ALL grades — the grader is uncalibrated (#133), so by default every finding is shown with its grade",
    )
    .option(
      "--min-confidence <n>",
      "findings below this FINDING confidence (0..1, a finding's own violation/applicability/grounding score — NOT its quality-grade confidence, a separate independent-grader number shown as finding.quality.confidence) are suppressed and counted in report.suppressed; default JEVITATE_UX_MIN_CONFIDENCE, then ~/.jevitate/config.json ux.minConfidence, then 0.3",
    )
    .option(
      "--max-findings-per-page <n>",
      "cap on UX findings per route/page, highest-confidence first; the rest are counted in report.suppressed as per-page-cap, never dropped silently; default JEVITATE_UX_MAX_FINDINGS_PER_PAGE, then ~/.jevitate/config.json ux.maxFindingsPerPage, then 5",
    )
    .option("--persona <p>", "optional persona for calibration")
    .option("--job <text>", "the job the flow pursues (improves relevance)")
    .option("--out <dir>", "directory to write the UX report")
    .option(
      "--result <file>",
      "mission result JSON (as written alongside the Recording by `jevitate explore`) — supplies blocked/disabled-target evidence the Recording alone cannot carry; default: <stem>.result.json, else <stem>.transcript.json, next to the Recording",
    )
    .option(
      "--evidence <file>",
      "a live usability run's evidence sidecar (screens as analyzed + run signals); default: <stem>.evidence.json next to the Recording — with it, offline review reproduces the live run's findings",
    )
    .option("--real", "use live Jev gateways (requires keys)", false)
    .option("--fake-ai", "use deterministic fake gateways", false)
    .option("--json", "emit a JSON envelope")
    .action(async function (this: Command, recordingPath: string) {
      const o = this.opts<{
        appClass?: string;
        minConfidence?: string;
        maxFindingsPerPage?: string;
        show?: string;
        persona?: string;
        job?: string;
        out?: string;
        result?: string;
        evidence?: string;
        real?: boolean;
        fakeAi?: boolean;
        json?: boolean;
      }>();
      if (!o.appClass) {
        emitJson(program, fail("E_UX_ARGS", "--app-class is required"));
        return;
      }
      let recording: Recording;
      try {
        recording = RecordingSchema.parse(JSON.parse(await readFile(recordingPath, "utf8")));
      } catch (err) {
        // #218: an unreadable or invalid Recording is unusable input — a usage error (64).
        emitJson(program, fail("E_UX_INPUT", String(err instanceof Error ? err.message : err)));
        return;
      }
      // #85 item 2 / #134: the artifacts next to the Recording — the live usability run's evidence
      // sidecar, the mission result or transcript — are discovered automatically (explicit flags
      // win). Absent or unreadable, the report says so (`report.evidenceCaveats`) rather than
      // silently seeing less.
      const found = discoverRecordingSidecars(recordingPath);
      const sidecars = await loadRecordingSidecars({
        ...((o.evidence ?? found.evidencePath) === undefined ? {} : { evidencePath: o.evidence ?? found.evidencePath }),
        ...((o.result ?? found.resultPath) === undefined ? {} : { resultPath: o.result ?? found.resultPath }),
        ...(o.result === undefined && found.transcriptPath !== undefined ? { transcriptPath: found.transcriptPath } : {}),
      });
      let uxJudge: JudgmentPort;
      let uxGen: GenerationPort;
      let uxUsage: UsageTracker;
      try {
        ({ judge: uxJudge, gen: uxGen, usage: uxUsage } = await buildExploreGateways(deps, { real: o.real ?? false, fakeAi: o.fakeAi ?? false }));
      } catch (err) {
        if (err instanceof MissingCredentialError || err instanceof GatewaySelectionError) {
          emitJson(program, fail("E_AI_SETUP_REQUIRED", err.message));
        } else {
          emitJson(program, fail("E_UX_SETUP", String(err instanceof Error ? err.message : err)));
        }
        return;
      }
      try {
        const result = await runUxReview({
          recording,
          appContext: {
            appClass: o.appClass,
            ...(o.persona ? { persona: o.persona } : {}),
            ...(o.job ? { job: o.job } : {}),
          },
          judge: uxJudge,
          gen: uxGen,
          usage: uxUsage,
          ...(o.minConfidence !== undefined ? { minConfidence: o.minConfidence } : {}),
          ...(o.show !== undefined ? { show: o.show } : {}),
          ...(o.maxFindingsPerPage !== undefined ? { maxFindingsPerRoute: o.maxFindingsPerPage } : {}),
          outDir: o.out,
          ...sidecars,
        });
        emitJson(program, ok(withEngine({ ...result, sidecars: found })));
      } catch (err) {
        if (err instanceof UxAnalysisFailedError) {
          emitJson(program, fail("E_UX_ANALYSIS", err.message));
        } else if (err instanceof MinConfidenceError || err instanceof QualityPolicyError || err instanceof MaxFindingsPerRouteError || err instanceof UxConfigError) {
          emitJson(program, fail("E_UX_ARGS", err.message));
        } else {
          emitJson(program, fail("E_UX_RUN", String(err instanceof Error ? err.message : err)));
        }
      }
    });
}
