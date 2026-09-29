// ux-review.ts — offline UX review of a saved Recording (`jevitate ux`) (#231).
import { logsDirFor } from "./project-dir.js";
import { existsSync, statSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { JudgmentPort, GenerationPort, UsageTracker, UsageCounts } from "@jevitate/ai-core";
import type { Recording } from "@jevitate/recording";
import { UxAnalyzer, a11yChecks, buildReport, calibrationCaveat, detectFriction, detectRepeatedReplies, detectSignals, evidenceFromFile, groundFindings, loadV1Rubric, parseUxEvidenceFile, resolveMinConfidence, resolveMaxFindingsPerRoute, resolveQualityPolicy, withSignalFindings, type AppContext, type JourneyOutcome, type SignalOptions, type UxEvidenceFile, type UxEvidence, type UxReport } from "@jevitate/ux";
import { loadUxMaxFindingsPerPage, loadUxMinConfidence, loadUxMinConfidenceByAppClass, loadUxShow } from "./ux-config.js";
import { writeUsageSidecar } from "./mission-journal.js";
import { DEFAULT_JUDGMENT_BUDGET, type MissionTranscriptEntryLike, captureFromTranscript, recordingToEvidence } from "./ux-evidence.js";

// ---------- Offline: `jevitate ux <recording>` ----------

export interface RunUxReviewOptions {
  readonly recording: Recording;
  readonly appContext: AppContext;
  readonly judge: JudgmentPort;
  /** Structured-output specifics (observation / implicated controls / fix) for flagged items. */
  readonly gen: GenerationPort;
  /**
   * Usage accounting (#100): when supplied, its snapshot (judgments/generations/tokens/`usd`) lands
   * in the result as `usage`. The CLI builds one per invocation and hands it to `judge`/`gen`.
   */
  readonly usage?: UsageTracker;
  /**
   * Report cutoff; findings below it are suppressed (counted in `report.suppressed`). Precedence:
   * this (CLI `--min-confidence`) > `JEVITATE_UX_MIN_CONFIDENCE` > config `ux.minConfidence`
   * (`~/.jevitate/config.json`) > `DEFAULT_MIN_CONFIDENCE`.
   */
  readonly minConfidence?: number | string;
  /**
   * Quality grades to show, e.g. "actionable,relevant-minor". Precedence: this (CLI `--show`) >
   * `JEVITATE_UX_SHOW` > config `ux.show` > every grade (#133: the uncalibrated grader labels, it does not filter).
   */
  readonly show?: string;
  /**
   * Cap on findings per route (issue #198 interim, 0.2.0). Precedence: this (CLI
   * `--max-findings-per-page`) > `JEVITATE_UX_MAX_FINDINGS_PER_PAGE` > config
   * `ux.maxFindingsPerPage` > `DEFAULT_MAX_FINDINGS_PER_ROUTE` (5).
   */
  readonly maxFindingsPerRoute?: number | string;
  readonly env?: Readonly<Record<string, string | undefined>>;
  /** Path of the config file holding `ux.minConfidence`. Default `~/.jevitate/config.json`. */
  readonly configPath?: string;
  readonly secrets?: readonly string[];
  /** Local file the `upload` op attaches (CLI `--fixture`); validated before any browser opens. */
  readonly fixture?: string;
  readonly judgmentBudget?: number;
  /** Where to write the report. Default `.jevitate/logs/<date>` (project, else `~/.jevitate`). */
  readonly outDir?: string;
  readonly nowIso?: () => string;
  /**
   * The source run's mission transcript (#85 item 2) — from `--result`'s `<recording>.result.json`
   * (`result.transcript`), or the sibling `<recording>.transcript.json` directly. Gives offline
   * analysis the same blocked/disabled-target evidence a live usability run sees. Absent, the
   * report says so (`report.evidenceCaveats`) rather than silently seeing less.
   */
  readonly missionTranscript?: readonly MissionTranscriptEntryLike[];
  /** Why `missionTranscript` is absent (e.g. no `--result` given, or the file could not be read) — becomes a report caveat. */
  readonly missionTranscriptUnavailable?: string;
  /** The source run's end state (a mission result's `outcome`), for the goal-not-reached friction (#132). */
  readonly missionOutcome?: JourneyOutcome;
  /**
   * #134: the live usability run's evidence sidecar (`<stamp>.evidence.json`): every screen as the
   * live analyzer saw it (redacted) and the run-signal capture. With it, offline review reproduces
   * the live run's rubric AND signal findings; without it, the report says what it could not see.
   */
  readonly evidenceFile?: UxEvidenceFile;
  /** Why no evidence sidecar was used (not found next to the Recording, or unreadable) — a report caveat. */
  readonly evidenceUnavailable?: string;
  /** Tuning of the run-signal oracles (#96/#131). */
  readonly signals?: SignalOptions;
}

export interface RunUxReviewResult {
  readonly report: UxReport;
  readonly reportPath: string;
  /** Judgment/generation call counts and tokens for this run (#100); present only when `opts.usage` was supplied. */
  readonly usage?: UsageCounts;
}

const NO_EVIDENCE_CAVEAT =
  "no usability evidence sidecar (<stamp>.evidence.json, written next to the Recording by live usability runs, #134): this pass sees only the Recording's touched controls and urls — rubric items needing visible text or a11y facts are Skipped, and the run signals that need the live capture (hung request, stuck job, duplicate write/create, failed submit, inert control, internal id, url mismatch) could not be checked; with a transcript, journey friction and repeated replies still are.";

const NO_TRANSCRIPT_CAVEAT =
  "blocked/disabled-target evidence not available: this offline pass has no mission transcript, so a dead end like a button that never enables cannot be seen (pass --result <mission-result.json>, as written by `jevitate explore`, to include it — the same evidence a live usability run sees).";

/**
 * Offline UX review. FAIL-FAST: an analyzer `failed` outcome throws
 * `UxAnalysisFailedError` (the CLI maps it to a non-zero fail envelope) — never
 * a fabricated "clean" report.
 */
export async function runUxReview(opts: RunUxReviewOptions): Promise<RunUxReviewResult> {
  // #163: this review's own share of a (possibly shared) tracker.
  const runUsage = opts.usage?.scope();
  const minConfidence = resolveMinConfidence(
    opts.minConfidence,
    opts.env ?? process.env,
    loadUxMinConfidence(opts.configPath),
    loadUxMinConfidenceByAppClass(opts.configPath, opts.appContext.appClass),
  );
  const quality = resolveQualityPolicy(opts.show, opts.env ?? process.env, loadUxShow(opts.configPath), opts.appContext.appClass);
  const maxFindingsPerRoute = resolveMaxFindingsPerRoute(opts.maxFindingsPerRoute, opts.env ?? process.env, loadUxMaxFindingsPerPage(opts.configPath));
  const analyzer = new UxAnalyzer({ judge: opts.judge, gen: opts.gen, a11yChecker: a11yChecks });
  // #134: a live usability run's evidence sidecar gives offline review the SAME screens and run
  // signals the live analysis had; otherwise the Recording (+ transcript) is all there is.
  let screens: UxEvidence[];
  let appContext = opts.appContext;
  let signalFindings: ReturnType<typeof detectSignals> = [];
  let friction: ReturnType<typeof detectFriction> = [];
  const evidenceCaveats: string[] = [];
  if (opts.evidenceFile !== undefined) {
    ({ screens, appContext } = evidenceFromFile(opts.evidenceFile, opts.appContext));
    signalFindings = detectSignals(opts.evidenceFile.signals, opts.signals);
    friction = detectFriction(opts.evidenceFile.signals, opts.evidenceFile.outcome ?? opts.missionOutcome);
  } else {
    screens = recordingToEvidence(opts.recording, opts.appContext, opts.appContext.job, opts.missionTranscript);
    if (opts.missionTranscript !== undefined) {
      const partial = captureFromTranscript(opts.missionTranscript);
      signalFindings = detectRepeatedReplies(partial, opts.signals);
      friction = detectFriction(partial, opts.missionOutcome);
    } else {
      evidenceCaveats.push(opts.missionTranscriptUnavailable ?? NO_TRANSCRIPT_CAVEAT);
    }
    evidenceCaveats.push(opts.evidenceUnavailable === undefined ? NO_EVIDENCE_CAVEAT : `${opts.evidenceUnavailable} — ${NO_EVIDENCE_CAVEAT}`);
  }
  const outcome = await analyzer.analyze({
    screens,
    rubric: loadV1Rubric(),
    appContext,
    secrets: opts.secrets,
    judgmentBudget: opts.judgmentBudget ?? DEFAULT_JUDGMENT_BUDGET,
  });
  if (outcome.kind === "failed") {
    throw new UxAnalysisFailedError(outcome.reason, outcome.screenId, outcome.rubricItemId);
  }
  const calibrationCaveats = [calibrationCaveat(opts.appContext.appClass)];
  const report = buildReport(groundFindings(withSignalFindings(outcome, signalFindings), friction), {
    minConfidence,
    quality,
    maxFindingsPerRoute,
    evidenceCaveats,
    calibrationCaveats,
  });
  const outDir = opts.outDir ?? logsDirFor();
  await mkdir(outDir, { recursive: true });
  const iso = (opts.nowIso ?? (() => new Date().toISOString()))();
  const reportPath = join(outDir, `ux-${iso.replace(/[:.]/g, "-")}.json`);
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  if (runUsage !== undefined) writeUsageSidecar(reportPath, runUsage);
  return { report, reportPath, ...(runUsage === undefined ? {} : { usage: runUsage.snapshot() }) };
}

/** #134: the artifacts a run writes next to its Recording (`<stem>.recording.json`). */
export interface RecordingSidecars {
  /** `<stem>.evidence.json` — the live usability run's evidence sidecar. */
  readonly evidencePath?: string;
  /** `<stem>.transcript.json` — the decision transcript (each step's screenshot). */
  readonly transcriptPath?: string;
  /** `<stem>.result.json` — a mission result (explore/adversarial), carrying transcript + outcome. */
  readonly resultPath?: string;
  /** `<stem>.screens/` — the per-step screenshots. */
  readonly screenshotDir?: string;
}

/** Finds the sidecars that exist next to `recordingPath` (only `<stem>.recording.json` has a stem). */
export function discoverRecordingSidecars(recordingPath: string): RecordingSidecars {
  if (!recordingPath.endsWith(".recording.json")) return {};
  const stem = recordingPath.slice(0, -".recording.json".length);
  const file = (p: string) => (existsSync(p) && statSync(p).isFile() ? p : undefined);
  const dir = (p: string) => (existsSync(p) && statSync(p).isDirectory() ? p : undefined);
  const evidencePath = file(`${stem}.evidence.json`);
  const transcriptPath = file(`${stem}.transcript.json`);
  const resultPath = file(`${stem}.result.json`);
  const screenshotDir = dir(`${stem}.screens`);
  return {
    ...(evidencePath === undefined ? {} : { evidencePath }),
    ...(transcriptPath === undefined ? {} : { transcriptPath }),
    ...(resultPath === undefined ? {} : { resultPath }),
    ...(screenshotDir === undefined ? {} : { screenshotDir }),
  };
}

/** What the discovered (or given) sidecars supply to `runUxReview`, and why anything is missing. */
export interface LoadedSidecars {
  readonly evidenceFile?: UxEvidenceFile;
  readonly evidenceUnavailable?: string;
  readonly missionTranscript?: MissionTranscriptEntryLike[];
  readonly missionTranscriptUnavailable?: string;
  readonly missionOutcome?: JourneyOutcome;
}

function asOutcome(v: unknown): JourneyOutcome | undefined {
  if (v === null || typeof v !== "object") return undefined;
  const o = v as { status?: unknown; reason?: unknown };
  if (o.status === "completed") return { status: "completed" };
  if (o.status === "incomplete") return { status: "incomplete", reason: typeof o.reason === "string" ? o.reason : "not completed" };
  return undefined;
}

/**
 * Reads the evidence sidecar and the transcript/result (explicit paths win over discovered ones).
 * Never throws: an unreadable file becomes the matching `…Unavailable` caveat.
 */
export async function loadRecordingSidecars(paths: {
  readonly evidencePath?: string;
  readonly resultPath?: string;
  readonly transcriptPath?: string;
}): Promise<LoadedSidecars> {
  const out: {
    evidenceFile?: UxEvidenceFile;
    evidenceUnavailable?: string;
    missionTranscript?: MissionTranscriptEntryLike[];
    missionTranscriptUnavailable?: string;
    missionOutcome?: JourneyOutcome;
  } = {};
  if (paths.evidencePath !== undefined) {
    try {
      out.evidenceFile = parseUxEvidenceFile(JSON.parse(await readFile(paths.evidencePath, "utf8")));
    } catch (err) {
      out.evidenceUnavailable = `could not read the evidence sidecar ${paths.evidencePath}: ${err instanceof Error ? err.message : String(err)}`;
    }
  } else {
    out.evidenceUnavailable = "no evidence sidecar next to the Recording";
  }
  const source = paths.resultPath ?? paths.transcriptPath;
  if (source !== undefined) {
    try {
      const raw = JSON.parse(await readFile(source, "utf8")) as unknown;
      const obj = (raw ?? {}) as { result?: { transcript?: unknown; outcome?: unknown }; transcript?: unknown; outcome?: unknown };
      const transcript = Array.isArray(raw) ? raw : (obj.result?.transcript ?? obj.transcript);
      if (Array.isArray(transcript)) out.missionTranscript = transcript as MissionTranscriptEntryLike[];
      else out.missionTranscriptUnavailable = `${source} has no transcript`;
      const outcome = Array.isArray(raw) ? undefined : asOutcome(obj.result?.outcome ?? obj.outcome);
      if (outcome !== undefined) out.missionOutcome = outcome;
    } catch (err) {
      out.missionTranscriptUnavailable = `could not read ${source}: ${err instanceof Error ? err.message : String(err)}`;
    }
  }
  return out;
}

export class UxAnalysisFailedError extends Error {
  readonly code = "E_UX_ANALYSIS" as const;
  constructor(reason: string, readonly screenId?: string, readonly rubricItemId?: string) {
    super(`UX analysis failed: ${reason}${screenId ? ` (screen ${screenId})` : ""}`);
    this.name = "UxAnalysisFailedError";
  }
}
