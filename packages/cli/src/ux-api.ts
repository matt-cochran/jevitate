// ux-api.ts — the CLI layer over @jevitate/ux. Two surfaces:
//   - runUxReview(): offline analysis over a saved Recording (`jevitate ux`).
//   - runUsabilityMission(): live analysis during an exploration
//     (`explore --strategy usability`) — reuses explore()'s loop via the
//     additive onSnapshot hook, collects evidence per screen, and analyzes
//     ONCE post-run (proper batching/budget; no model calls slow the browser).
//
// This is the ONLY place @jevitate/ux meets @jevitate/explore — the dep
// direction stays ux ⟂ explore (both are consumed here, neither imports the
// other). Findings are advisory; a UX finding never gates a run.
import { logsDirFor } from "./project-dir.js";
import { existsSync, statSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { JudgmentPort, GenerationPort, UsageTracker, UsageCounts } from "@jevitate/ai-core";
import { PlaywrightBrowserPort, type BrowserLaunchOptions, type BrowserPort, type EmulationSpec } from "@jevitate/playwright";
import { CastActor, BrowseTheWeb } from "@jevitate/screenplay";
import type { InvariantSpec } from "@jevitate/recording";
import type { Recording, TargetDescriptor } from "@jevitate/recording";
import {
  explore,
  assertAuthorizedExploreTarget,
  resolveMissionFixture,
  reproduceHang,
  hangFinding,
  hangOutcome,
  InvariantMonitor,
  BudgetMonitor,
  type Snapshot,
  type Control as ExploreControl,
  type Bounds,
  type TimingSummary,
  type RunAnswer,
  type RunOutcome,
  type SecretField,
  type HangFinding,
  type VerifySession,
  type SideEffect,
  type TranscriptEntry,
  type BudgetTrajectory,
  secretFieldSecrets,
  detectOverflow,
  shouldCheckOverflow,
  type CrashReport,
} from "@jevitate/explore";
import {
  UxAnalyzer,
  a11yChecks,
  buildReport,
  calibrationCaveat,
  detectFriction,
  detectRepeatedReplies,
  detectSignals,
  evidenceFromFile,
  groundFindings,
  loadV1Rubric,
  parseUxEvidenceFile,
  persistableScreen,
  resolveMinConfidence,
  resolveMaxFindingsPerRoute,
  resolveQualityPolicy,
  withSignalFindings,
  makeSignalFinding,
  type AppContext,
  type JourneyOutcome,
  type RunSignalCapture,
  type SignalOptions,
  type UxEvidenceFile,
  type Control as UxControl,
  type ScreenRef,
  type UxEvidence,
  type UxFinding,
  type UxReport,
} from "@jevitate/ux";
import { resolveDataDir } from "./data-dir.js";
import { conversationConfig, type ConversationOptions } from "./conversation-options.js";
import { loadUxMaxFindingsPerPage, loadUxMinConfidence, loadUxMinConfidenceByAppClass, loadUxShow } from "./ux-config.js";
import type { MissionFailure, MissionOutcome } from "@jevitate/domain";
import { MissionJournal, artifactStamp, closeQuietly, writeMissionResult, writeUsageSidecar } from "./mission-journal.js";
import { missionExitCode } from "./mission-exit.js";
import { armMissionKillSwitch } from "./kill-signal.js";
import { currentEngineInfo, type EngineInfo } from "./engine.js";
import { openServerLogRuntime, type ServerLogDefect, type ServerLogsSummary } from "./log-correlation.js";
import { assertSaveStorageStateOutsideProject, currentUrlSafe, persistStorageState, serverLogResult, type ServerLogOptions } from "./explore-api.js";
import type { TargetConfig } from "./target-config.js";
import { transcriptPathFor } from "./transcript-file.js";
import { UsabilityCapture } from "./usability-capture.js";
import { StorageStateSnapshotter } from "./storage-state-snapshot.js";

const DEFAULT_JUDGMENT_BUDGET = 40;

function emptyBehavior() {
  return { noProgress: false, backtracks: 0, formReentry: 0, dwellMs: 0, errors: 0 } as const;
}

/** explore's live `Control` → ux `Control` (same shape by design; drop `stability`). */
function toUxControl(c: ExploreControl): UxControl {
  return {
    index: c.index,
    role: c.role,
    name: c.name,
    tag: c.tag,
    inputType: c.inputType,
    enabled: c.enabled,
    summary: c.summary,
    descriptor: c.descriptor,
  };
}

/** a11y facts computable from a live snapshot's controls (honest subset). */
function a11yFactsFromControls(controls: readonly UxControl[]) {
  return {
    controls: controls.map((c) => ({
      controlRef: `control:${c.index}`,
      accessibleName: c.name.trim().length > 0 ? c.name : null,
      focusOrder: c.index,
      targetSize: null,
      contrastRatio: null,
    })),
  };
}

/** A live Snapshot (+ extracted page text) → one screen's UxEvidence. */
export function snapshotToEvidence(
  snap: Snapshot,
  visibleText: string,
  appContext: AppContext,
  job: string | undefined,
  history: readonly ScreenRef[],
): UxEvidence {
  const controls = snap.controls.map(toUxControl);
  return {
    screenId: snap.signature,
    url: snap.url,
    controls,
    visibleText,
    appContext,
    ...(job !== undefined ? { job } : {}),
    history,
    behavior: emptyBehavior(),
    a11yFacts: a11yFactsFromControls(controls),
  };
}

function descriptorSummary(d: TargetDescriptor): string {
  const parts = [d.role, d.name ?? d.testId ?? d.text].filter((s): s is string => !!s);
  return parts.join(" ") || "control";
}

function stepTarget(step: Recording["pages"][number]["steps"][number]["step"]): TargetDescriptor | undefined {
  if ("target" in step && step.target) return step.target;
  return undefined;
}

/**
 * Values the run itself typed or selected — a Recording's own `fill`/`select` steps whose value
 * was NOT redacted (a secret field's value is always `{redacted:true}` and never surfaces here).
 * #85 item 1: feeds the vocabulary/jargon tier (nielsen-2) so a quote/label that is really the
 * user's own content (e.g. a piece title echoed back onto a card) is not mistaken for app copy.
 */
export function extractTypedValues(recording: Recording): string[] {
  const values: string[] = [];
  for (const page of recording.pages) {
    for (const rs of page.steps) {
      const step = rs.step;
      if ((step.kind === "fill" || step.kind === "select") && !("var" in step.value) && !step.value.redacted) {
        values.push(step.value.value);
      }
    }
  }
  return [...new Set(values)];
}

/**
 * The minimal shape of a mission transcript entry `recordingToEvidence` needs — duck-typed against
 * `@jevitate/explore`'s `TranscriptEntry` (this file already imports plenty from there; kept
 * separate so `recordingToEvidence` itself stays decoupled from the live explore-control shape).
 */
export interface MissionTranscriptEntryLike {
  readonly step?: number;
  readonly op?: string | null;
  readonly target?: string | null;
  readonly actOk: boolean;
  readonly reason?: string;
  readonly url: string;
  readonly signature?: string;
  readonly descriptor?: TargetDescriptor;
  readonly value?: string;
  readonly message?: string;
  readonly reply?: { readonly received?: boolean; readonly text?: string };
  readonly screenshot?: string;
}

/**
 * #134: the run-signal capture a transcript ALONE supports (no visible text, no requests) — enough
 * for the journey friction (retries, dead ends, waits, backtracks, abandoned fields) and repeated
 * replies, NOT for the oracles that need requests or page text (they would misfire on the blanks).
 */
export function captureFromTranscript(transcript: readonly MissionTranscriptEntryLike[]): RunSignalCapture {
  const steps = transcript.map((t, i) => ({
    step: t.step ?? i + 1,
    op: t.op ?? null,
    target: t.target ?? null,
    actOk: t.actOk,
    url: t.url,
    ...(t.descriptor === undefined ? {} : { descriptor: t.descriptor }),
    ...(t.reason === undefined ? {} : { reason: t.reason }),
    ...(t.value === undefined ? {} : { value: t.value }),
    ...(t.message === undefined ? {} : { message: t.message }),
    ...(t.reply?.text === undefined || t.reply.received === false ? {} : { reply: t.reply.text }),
  }));
  const screens = transcript.map((t, i) => ({
    index: i,
    step: t.step ?? i + 1,
    at: 0,
    url: t.url,
    signature: t.signature ?? `step:${t.step ?? i + 1}`,
    visibleText: "",
    busy: false,
    ...(t.screenshot === undefined ? {} : { screenshot: t.screenshot }),
  }));
  return { steps, requests: [], screens, endedAt: 0 };
}

const ACTIONABLE_OPS = new Set(["click", "type", "select"]);

/**
 * Blocked/disabled-target controls derived from a mission transcript (#85 item 2), grouped by the
 * page url they were observed on. A failed action is never recorded as a Recording step (see #81:
 * `RunRecorder` records only successful actions), so this is the only source that gives offline
 * `jevitate ux` the same evidence a LIVE usability run sees for free via `Control.enabled` on its
 * snapshot — e.g. a "Pay" button that stayed disabled.
 */
function blockedControlsByUrl(transcript: readonly MissionTranscriptEntryLike[], startIndex: number): Map<string, UxControl[]> {
  const byUrl = new Map<string, UxControl[]>();
  const seen = new Set<string>();
  let idx = startIndex;
  for (const t of transcript) {
    if (t.actOk || t.descriptor === undefined || !t.op || !ACTIONABLE_OPS.has(t.op)) continue;
    const key = `${t.url}|${JSON.stringify(t.descriptor)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const d = t.descriptor;
    const list = byUrl.get(t.url) ?? [];
    list.push({
      index: idx++,
      role: d.role ?? "",
      name: d.name ?? d.testId ?? d.text ?? "",
      tag: "",
      inputType: null,
      enabled: false,
      summary: `${descriptorSummary(d)} (blocked: ${t.reason ?? "action did not succeed"})`,
      descriptor: d,
    });
    byUrl.set(t.url, list);
  }
  return byUrl;
}

/**
 * A saved Recording → per-page UxEvidence. A Recording is deterministic and
 * thin: it carries the CONTROLS the user touched (via each step's descriptor)
 * and the page url, but NOT the full visible text or a11y geometry. So offline
 * analysis is honestly partial — items needing `visibleText`/`a11yFacts` Skip,
 * and coverage reports it. (The live mode carries the rich per-screen snapshot.)
 *
 * `missionTranscript` (#85 item 2, optional) adds blocked/disabled-target controls the Recording
 * itself cannot carry, on whichever screen(s) share the blocked action's url — the same evidence a
 * live usability run gets from its snapshot. `typedValues` (every screen's own #85 item 1 input)
 * is always derived from the Recording, with or without a transcript.
 */
export function recordingToEvidence(
  recording: Recording,
  appContext: AppContext,
  job?: string,
  missionTranscript?: readonly MissionTranscriptEntryLike[],
): UxEvidence[] {
  const screens: UxEvidence[] = [];
  const history: ScreenRef[] = [];
  const typedValues = extractTypedValues(recording);
  const blockedByUrl = blockedControlsByUrl(missionTranscript ?? [], recording.pages.reduce((n, p) => n + p.steps.length, 0) + 1000);
  for (let i = 0; i < recording.pages.length; i++) {
    const page = recording.pages[i];
    const controls: UxControl[] = [];
    let idx = 0;
    const seen = new Set<string>();
    for (const rs of page.steps) {
      const d = stepTarget(rs.step);
      if (!d) continue;
      const key = JSON.stringify(d);
      if (seen.has(key)) continue;
      seen.add(key);
      controls.push({
        index: idx++,
        role: d.role ?? "",
        name: d.name ?? d.testId ?? d.text ?? "",
        tag: "",
        inputType: null,
        enabled: true,
        summary: descriptorSummary(d),
        descriptor: d,
      });
    }
    for (const blocked of blockedByUrl.get(page.url) ?? []) controls.push(blocked);
    const screenId = `${page.url}#${i}`;
    screens.push({
      screenId,
      url: page.url,
      controls,
      visibleText: "",
      appContext,
      ...(job !== undefined ? { job } : {}),
      history: [...history],
      behavior: emptyBehavior(),
      a11yFacts: { controls: [] },
      ...(typedValues.length > 0 ? { typedValues } : {}),
    });
    history.push({ screenId, url: page.url });
  }
  return screens;
}

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

// ---------- Live: `explore --strategy usability` ----------

export interface RunUsabilityMissionOptions {
  readonly url: string;
  readonly job: string;
  readonly allowlist: readonly string[];
  readonly appContext: AppContext;
  readonly judge: JudgmentPort;
  readonly gen: GenerationPort;
  /** Usage accounting (#100): see `RunUxReviewOptions.usage`. */
  readonly usage?: UsageTracker;
  /** Report cutoff (see `RunUxReviewOptions.minConfidence`). */
  readonly minConfidence?: number | string;
  /**
   * Quality grades to show, e.g. "actionable,relevant-minor". Precedence: this (CLI `--show`) >
   * `JEVITATE_UX_SHOW` > config `ux.show` > every grade (#133: the uncalibrated grader labels, it does not filter).
   */
  readonly show?: string;
  /** Cap on findings per route (see `RunUxReviewOptions.maxFindingsPerRoute`). */
  readonly maxFindingsPerRoute?: number | string;
  readonly env?: Readonly<Record<string, string | undefined>>;
  /** Path of the config file holding `ux.minConfidence`. Default `~/.jevitate/config.json`. */
  readonly configPath?: string;
  readonly bounds?: Partial<Bounds>;
  readonly secrets?: readonly string[];
  /**
   * Secret field bindings (`--secret-field` / `--totp`, #72): typed by code, never by the model;
   * masked in every screenshot and redacted from the transcript, Recording and report.
   */
  readonly secretFields?: readonly SecretField[];
  /** Tuning of the run-signal oracles (#96), e.g. the hung-request floor. Defaults suit real apps. */
  readonly signals?: SignalOptions;
  /** Local file the `upload` op attaches (CLI `--fixture`); validated before any browser opens. */
  readonly fixture?: string;
  readonly judgmentBudget?: number;
  /** Conversational pages: the reply wait (ms) and the cap (chars) on each generated message. */
  readonly conversation?: ConversationOptions;
  readonly outDir?: string;
  readonly browserPortFactory?: () => BrowserPort;
  /** How Chromium is launched (executable/channel/extra args). Default: pinned Chromium. */
  readonly browser?: BrowserLaunchOptions;
  /** Per-mission viewport/device emulation (#149, CLI `--viewport <W>x<H>` / `--device "<name>"`). */
  readonly emulation?: EmulationSpec;
  /**
   * Playwright storageState JSON to seed the session from (CLI `--storage-state`) — the
   * deterministic authenticated pre-step. Holds live session cookies: handed only to the
   * browser, never to a model or a finding.
   */
  readonly storageState?: string;
  /**
   * Writes the browser context's storageState here when the run ends (CLI `--save-storage-state`) —
   * see `RunExplorationOptions.saveStorageState`'s doc for the full behaviour (written on every exit
   * path including a crash/kill signal, never over a lost/logged-out session, mode 0600).
   */
  readonly saveStorageState?: string;
  readonly nowIso?: () => string;
  /** The target's settle/hang configuration (`~/.jevitate/targets.json` + flags). */
  readonly target?: TargetConfig;
  /** Test seam: extract a page's visible text. Default reads the live page. */
  readonly extractText?: (session: { page: { evaluate: (fn: () => string) => Promise<string> } }) => Promise<string>;
  /**
   * Backend log sources (`--log-source`/`--log-defect`, #142), already validated. Lines attach to
   * usability steps the same way as every other strategy; a `server-log` defect is reported in the
   * result but — like every UX finding — never gates `missionOutcome`/`exitCode` (advisory-only).
   */
  readonly serverLog?: ServerLogOptions;
  /**
   * Horizontal-overflow hard signal (#149, CLI `--check-overflow` / `--ignore-overflow`): checked
   * on every observed screen and, when it fires, reported as a `tier: "signal"` UxFinding — pure
   * DOM geometry (`detectOverflow`), never a model judgment. Runs by default only when the emulated
   * viewport is narrower than 1024px, or always when `checkOverflow` is set.
   */
  readonly overflow?: {
    readonly checkOverflow?: boolean;
    readonly toleranceCss?: number;
    /** `--ignore-overflow <selector>` (repeatable): intentional overflow, never a finding. */
    readonly ignoreSelectors?: readonly string[];
  };
  /**
   * `--invariants` (#150 only): usability does not check app-declared invariants (#86) or captures
   * (#147) today — a spec carrying either is refused. Only its `budget` (over its `observe` map) is
   * read: a pre-action guard and a post-settle check, the same as every other mission.
   */
  readonly invariants?: InvariantSpec;
  /** Resolved `authFrom.secret` refs (#135) a declared budget's probe may use: `env:VAR` → its value. */
  readonly invariantAuthTokens?: ReadonlyMap<string, string>;
}

/** Usability reads only a spec's `budget` (#150) — never its `invariants`/`capture` (#86/#147, not supported here). */
export class UsabilityInvariantsUnsupportedError extends Error {
  readonly code = "E_USABILITY_INVARIANTS" as const;
  constructor() {
    super(
      "usability does not check app-declared invariants or captures — only a `budget` is read; " +
        "give a spec with an empty invariants array (and no capture) to use --invariants with usability",
    );
    this.name = "UsabilityInvariantsUnsupportedError";
  }
}

export interface RunUsabilityMissionResult {
  /** The UX report; `null` when the analysis was unavailable (see `analysisUnavailable`). */
  readonly report: UxReport | null;
  readonly reportPath: string | null;
  readonly stop: string;
  /**
   * Did the review's journey complete (`completed`: the job's success condition was observably met),
   * or why not (`incomplete` + reason)? Never a silent early stop.
   */
  readonly outcome: RunOutcome;
  /** A find-out job's answer (#101), present only when code grounded it on the observed pages. */
  readonly answer?: RunAnswer;
  readonly screensObserved: number;
  /** The explore loop's decision transcript, written next to the report (each step: its screenshot). */
  readonly transcriptPath: string;
  /** The run's Recording, written next to the report (crash-safe: flushed after every step). */
  readonly recordingPath: string;
  /** Where the per-step screenshots are written (secret fields masked). */
  readonly screenshotDir: string;
  /**
   * #134: the evidence sidecar (`usability-<stamp>.evidence.json`) — every screen as the analyzer
   * saw it after redaction, plus the run-signal capture — so `jevitate ux <recording>` reproduces
   * this run's findings offline. `null` when it could not be written (redaction unavailable).
   */
  readonly evidencePath: string | null;
  /** Every per-step screenshot written, in order. */
  readonly screenshots: readonly string[];
  /** The writes the run's actions fired (#116), marked when the control was paid / destructive. */
  readonly sideEffects: readonly SideEffect[];
  readonly sideEffectsTruncated?: number;
  /**
   * The typed verdict. UX findings are advisory, so a completed review is `clean`; a run whose
   * loop broke is `crashed`/`inconclusive`, and so is one whose analysis could not be produced.
   */
  readonly missionOutcome: MissionOutcome;
  readonly exitCode: number;
  readonly failure?: MissionFailure;
  /** For a `crashed` review: the evidence and its attribution (jevitate / system under test / uncertain). */
  readonly crash?: CrashReport;
  /** Where the review ended (redacted), and how many decisions/actions it spent — as a goal run reports them. */
  readonly finalUrl: string;
  readonly decisions: number;
  readonly actions: number;
  /** Why the analysis could not be produced (the run's evidence is still kept). */
  readonly analysisUnavailable?: string;
  /** Slowest pages/transitions and endpoints (p50/max), keyed by normalized route/endpoint. */
  readonly timing: TimingSummary;
  /** Which build produced this result (issue #83): `{version, commit, builtAt}`. */
  readonly engine: EngineInfo;
  /** Judgment/generation call counts and tokens for this run (#100); present only when `opts.usage` was supplied. */
  readonly usage?: UsageCounts;
  /** The hang finding (with its reproduction k/N), present when the run stopped on a hang (#126). */
  readonly hang?: HangFinding;
  /** The persisted typed result (`usability-<stamp>.recording.result.json`), readable via MCP `get_mission_result`. */
  readonly resultPath?: string;
  /** Backend log correlation summary (#142) — present only when `--log-source` was given. */
  readonly serverLogs?: ServerLogsSummary;
  /** `server-log` defects (#142, `--log-defect`) — advisory here, like every UX finding; never gates the outcome. */
  readonly serverLogDefects?: ServerLogDefect[];
  /** Declared mission spend budgets (#150): the observed trajectory, present when any were declared. */
  readonly budget?: BudgetTrajectory[];
}

/**
 * Opens a FRESH browser session for replays (hang reproduction): a new context from the same port
 * and options — same authenticated storageState, never the session the finding was made in.
 */
function freshSessionOpener(
  portFactory: () => BrowserPort,
  launch: Parameters<BrowserPort["open"]>[0],
  allowlist: readonly string[],
): () => Promise<VerifySession> {
  return async () => {
    const session = await portFactory().open(launch);
    const actor = CastActor.named("replay").whoCan(new BrowseTheWeb(session, [...allowlist]));
    return { page: session.page, actor, close: () => session.close() };
  };
}

/**
 * Live usability mission. Guardrail #1 authorizes BEFORE opening a browser.
 * Reuses explore()'s loop (goal = the job) and, via the additive onSnapshot
 * hook, collects one screen's evidence per observation — then analyzes ONCE
 * after the run. A UX finding NEVER gates the loop (the hook's result is
 * ignored by explore). The temp profile dir is always removed.
 */
export async function runUsabilityMission(opts: RunUsabilityMissionOptions): Promise<RunUsabilityMissionResult> {
  const origin = assertAuthorizedExploreTarget(opts.url, opts.allowlist);
  assertSaveStorageStateOutsideProject(opts.saveStorageState);
  // #150 — usability reads only a spec's `budget`: it does not check invariants or captures (#86/
  // #147) today. Refused BEFORE a browser opens, same as every other bad-input refusal here.
  if (opts.invariants !== undefined && (opts.invariants.invariants.length > 0 || opts.invariants.capture !== undefined)) {
    throw new UsabilityInvariantsUnsupportedError();
  }
  // Validate the cutoff before a browser opens — a bad value fails fast, never mid-run.
  const minConfidence = resolveMinConfidence(
    opts.minConfidence,
    opts.env ?? process.env,
    loadUxMinConfidence(opts.configPath),
    loadUxMinConfidenceByAppClass(opts.configPath, opts.appContext.appClass),
  );
  const quality = resolveQualityPolicy(opts.show, opts.env ?? process.env, loadUxShow(opts.configPath), opts.appContext.appClass);
  const maxFindingsPerRoute = resolveMaxFindingsPerRoute(opts.maxFindingsPerRoute, opts.env ?? process.env, loadUxMaxFindingsPerPage(opts.configPath));
  const fixture = opts.fixture === undefined ? undefined : await resolveMissionFixture(opts.fixture);
  const portFactory = opts.browserPortFactory ?? (() => new PlaywrightBrowserPort());
  const port = portFactory();
  const launch = {
    headless: true,
    allowedOrigins: [...opts.allowlist],
    baseUrl: origin,
    ...opts.browser,
    ...opts.emulation,
    ...(opts.storageState !== undefined ? { storageState: opts.storageState } : {}),
  };
  const session = await port.open(launch);
  const collected: UxEvidence[] = [];
  const history: ScreenRef[] = [];
  // #149: one signal finding per distinct fingerprint (route + element) — a wide table seen across
  // many observed screens is still ONE finding, never a finding per occurrence.
  const overflowFindings: UxFinding[] = [];
  const seenOverflow = new Set<string>();
  const extract =
    opts.extractText ??
    (async (s: { page: { evaluate: (fn: () => string) => Promise<string> } }) =>
      s.page.evaluate(() => (typeof document !== "undefined" && document.body ? document.body.innerText : "")));
  const outDir = opts.outDir ?? logsDirFor();
  const iso = (opts.nowIso ?? (() => new Date().toISOString()))();
  const stamp = artifactStamp(iso);
  const reportPath = join(outDir, `usability-${stamp}.json`);
  // #98 — the same artifact shape as goal/adversarial missions, next to the report: the decision
  // transcript (each step's redacted typed value and screenshot), the Recording and the per-step
  // screenshots. Crash-safe: the transcript and partial Recording are flushed after every step.
  const journal = new MissionJournal(join(outDir, `usability-${stamp}.recording.json`), transcriptPathFor(reportPath));
  const screenshotDir = join(outDir, `usability-${stamp}.screens`);
  // A bound secret (or TOTP seed) is a run secret too: masked on screen, redacted everywhere.
  const secrets = [...(opts.secrets ?? []), ...secretFieldSecrets(opts.secretFields)];
  const capture = new UsabilityCapture({
    page: session.page,
    screenshotDir,
    secrets,
    ...(opts.secretFields === undefined ? {} : { secretFields: opts.secretFields }),
  });
  // Crash-safe on SIGTERM/SIGINT too (#94): a partial `inconclusive` result is written from
  // whatever the journal has already flushed, and the process exits with the conventional code.
  // #120: the transcript lives next to the REPORT (`usability-<stamp>.transcript.json`), not the
  // Recording — so the killed run's result names the real file, and reports the live step list,
  // the tokens spent so far and the screens already observed.
  // #163: this run's own share of a (possibly shared) tracker: its usage and sidecar.
  const runUsage = opts.usage?.scope();
  // #159: see RunExplorationOptions.saveStorageState / runExploration's own doc comment.
  const snapshotter = new StorageStateSnapshotter(session, opts.saveStorageState !== undefined);
  const disarmKillSwitch = armMissionKillSwitch({
    recordingPath: journal.recordingPath,
    transcriptPath: journal.transcriptPath,
    transcript: () => journal.transcript,
    ...(runUsage === undefined ? {} : { usage: runUsage }),
    partialReport: () => ({ screensObserved: collected.length, screenshotDir, screenshots: capture.screenshots() }),
    ...(opts.saveStorageState === undefined
      ? {}
      : { storageState: { path: opts.saveStorageState, snapshot: () => snapshotter.snapshot() } }),
  });
  // The usability capture (screenshots) and the journal (crash-safe flush) are the EXISTING listener
  // chain; a server-log runtime (#142) is inserted in FRONT of it (never replacing it) so every step
  // still gets its screenshot/flush exactly as before, whether or not --log-source was given. #159:
  // every settled step also refreshes the in-memory storageState snapshot (a cheap no-op when
  // `--save-storage-state` was not given).
  const journalListener = (entry: TranscriptEntry, all: readonly TranscriptEntry[]): void => {
    capture.noteEntry(entry, all);
    journal.onTranscriptEntry(entry, capture.withScreenshots(all));
    snapshotter.noteSettledStep(currentUrlSafe(session));
  };
  const serverLog = openServerLogRuntime({
    sources: opts.serverLog?.sources ?? [],
    logDefect: opts.serverLog?.logDefect ?? [],
    ...(opts.serverLog?.drainMs === undefined ? {} : { drainMs: opts.serverLog.drainMs }),
    secrets,
    onTranscriptEntry: journalListener,
  });
  try {
    const actor = CastActor.named("usability-mission").whoCan(new BrowseTheWeb(session, [...opts.allowlist]));
    // #150 — usability's own budget wiring: a plain `InvariantMonitor` reads a budget's declared
    // observables (the same #86/#135 read/auth/redaction machinery), but this mission folds NO
    // invariant defects — only a budget crossing can end the run early, via the same pre-action
    // guard / post-settle hooks `explore()` offers every mission.
    const budgetDecls = opts.invariants?.budget ?? [];
    const invariantMonitor =
      opts.invariants === undefined || budgetDecls.length === 0
        ? null
        : new InvariantMonitor(opts.invariants, {
            allowlist: opts.allowlist,
            baseUrl: opts.url,
            ...(opts.secrets === undefined ? {} : { secrets: opts.secrets }),
            ...(opts.invariantAuthTokens === undefined ? {} : { authTokens: opts.invariantAuthTokens }),
          });
    const budget = invariantMonitor === null ? null : new BudgetMonitor(budgetDecls, invariantMonitor);
    let budgetSettledSteps = 0;
    const run = await explore({
      ...(opts.target?.timing === undefined ? {} : { timingConfig: opts.target.timing }),
      ...(opts.target?.settle === undefined ? {} : { settle: opts.target.settle }),
      ...(opts.target?.hangs === undefined ? {} : { hangs: opts.target.hangs }),
      ...(opts.target?.safety === undefined ? {} : { safety: opts.target.safety }),
      onTranscriptEntry: serverLog?.onTranscriptEntry ?? journalListener,
      onRecording: journal.onRecording,
      ...(opts.secretFields === undefined ? {} : { secretFields: opts.secretFields }),
      actor,
      judge: opts.judge,
      gen: opts.gen,
      goal: opts.job,
      allowlist: opts.allowlist,
      startUrl: opts.url,
      bounds: opts.bounds,
      secrets: opts.secrets,
      site: origin,
      fixture,
      ...conversationConfig(opts.conversation),
      missionContext:
        "usability review: pursue the stated job as a plausible first-time user, using only what is on screen",
      onSnapshot: async (snap) => {
        let visibleText = "";
        try {
          visibleText = await extract(session as never);
        } catch {
          visibleText = ""; // best-effort; the analyzer Skips visibleText items honestly
        }
        const ev = snapshotToEvidence(snap, visibleText, opts.appContext, opts.job, [...history]);
        collected.push(ev);
        history.push({ screenId: ev.screenId, url: ev.url });
        // #98 the step's (secret-masked) screenshot; #96 the screen's facts for the signal oracles.
        await capture.observe(snap, visibleText);
        // #149: horizontal-overflow hard signal — pure DOM geometry, never a model judgment.
        // Best-effort like visibleText extraction above: a detection failure never fails the mission.
        try {
          const vp = session.page.viewportSize();
          if (shouldCheckOverflow(vp?.width, opts.overflow?.checkOverflow ?? false)) {
            const overflow = await detectOverflow(session.page, {
              viewport: vp ?? { width: 1280, height: 720 },
              ...(opts.emulation?.device === undefined ? {} : { device: opts.emulation.device }),
              ...(opts.overflow?.toleranceCss === undefined ? {} : { toleranceCss: opts.overflow.toleranceCss }),
              ...(opts.overflow?.ignoreSelectors === undefined ? {} : { ignoreSelectors: opts.overflow.ignoreSelectors }),
              secrets,
            });
            if (overflow !== null && !seenOverflow.has(overflow.fingerprint)) {
              seenOverflow.add(overflow.fingerprint);
              overflowFindings.push(
                makeSignalFinding({
                  kind: "horizontal-overflow",
                  confidence: 0.9,
                  url: ev.url,
                  screenId: ev.screenId,
                  observation: `${overflow.element.descriptor} overflows the ${overflow.viewport.width}px viewport by ${overflow.overflowPx}px on ${overflow.route}.`,
                  userImpact:
                    "Content extends past the visible viewport; a user on this device must discover and use horizontal scrolling to see it, and may miss it entirely.",
                  recommendation: `Constrain ${overflow.element.descriptor} to the viewport width (e.g. a responsive layout, or an explicit scroll container) at ${overflow.viewport.width}px.`,
                  controls: [overflow.element.descriptor],
                  evidence: {
                    kind: "horizontal-overflow",
                    steps: [history.length],
                    requests: [],
                    detail: `scrollWidth exceeds innerWidth by ${overflow.overflowPx}px at a ${overflow.viewport.width}x${overflow.viewport.height} viewport`,
                  },
                }),
              );
            }
          }
        } catch {
          // Best-effort: the run's own explore loop is never held up or failed by this check.
        }
      },
      ...(budget === null
        ? {}
        : {
            onBeforeAction: async (info) => {
              const g = await budget.guard(session.page, info);
              return g.refuse ? { refuse: true, reason: g.reason ?? "budget guard refused the action" } : { refuse: false };
            },
            onSettled: async () => {
              budgetSettledSteps += 1;
              // The FIRST settled snapshot (before any action) is the budget's baseline.
              if (budgetSettledSteps === 1) {
                const b = await budget.baseline(session.page);
                return b.crossed ? { stop: true, reason: b.reason ?? "budget observable unreadable at run start" } : { stop: false };
              }
              const r = await budget.afterSettle(session.page, budgetSettledSteps);
              return r.crossed ? { stop: true, reason: r.reason ?? "mission budget crossed" } : { stop: false };
            },
          }),
    });
    // Never blocks the mission itself: the drain wait happens AFTER `explore()` returned.
    const serverLogRun = serverLog === undefined ? undefined : await serverLog.finish(run.transcript);
    journal.writeRecording(run.recording);
    journal.writeTranscript(capture.withScreenshots(serverLogRun?.transcript ?? run.transcript));

    // #85 item 1: the live run's own typed values (from its emitted Recording's fill/select
    // steps — never a secret), so the vocabulary/jargon tier can tell the app's own copy apart
    // from user-authored content it merely echoed back (same mechanism as the offline pass).
    const typedValues = extractTypedValues(run.recording);
    const screens = typedValues.length > 0 ? collected.map((ev) => ({ ...ev, typedValues })) : collected;
    // #96: findings from the run's own measurements (hung request, duplicate write, internal id,
    // inert control) — independent code, no model — reported alongside the rubric's.
    const signalCapture = await capture.signalCapture(run.transcript, typedValues);
    // A gRPC-web/Connect read is never a duplicate write (#110); `--read-rpc` marks more reads.
    const readRequests = opts.target?.safety?.readRequests;
    const signalFindings = [
      ...detectSignals(signalCapture, readRequests === undefined ? opts.signals : { ...opts.signals, readRequests }),
      // #149: horizontal-overflow, computed live during the run (never from the captured timeline).
      ...overflowFindings,
    ];
    // #132: the friction the run walked into — what grounds (or not) each rubric finding.
    const friction = detectFriction(signalCapture, run.outcome);
    // #134: the evidence sidecar, written through the redaction door BEFORE analysis (so it exists
    // even when analysis fails). Fail-closed: if any screen cannot be redacted, no file is written.
    const evidencePath = join(outDir, `usability-${stamp}.evidence.json`);
    let evidenceWritten: string | null = null;
    try {
      const file: UxEvidenceFile = {
        version: 1,
        appContext: opts.appContext,
        job: opts.job,
        screens: screens.map((ev) => persistableScreen(ev, secrets)),
        signals: signalCapture,
        outcome: run.outcome,
      };
      await mkdir(outDir, { recursive: true });
      await writeFile(evidencePath, `${JSON.stringify(file, null, 2)}\n`, "utf8");
      evidenceWritten = evidencePath;
    } catch {
      evidenceWritten = null;
    }
    const analyzer = new UxAnalyzer({ judge: opts.judge, gen: opts.gen, a11yChecker: a11yChecks });
    const outcome = await analyzer.analyze({
      screens,
      rubric: loadV1Rubric(),
      appContext: opts.appContext,
      secrets,
      judgmentBudget: opts.judgmentBudget ?? DEFAULT_JUDGMENT_BUDGET,
    });
    // #126: a run that stops on a hang is never `clean` — it is reproduced in fresh contexts (same
    // as a goal mission) and mapped through the same hang/intermittent/inconclusive rule.
    let hang: HangFinding | undefined;
    if (run.stop === "hang" && run.hang !== undefined) {
      const h = run.hang;
      const reproduction = await reproduceHang({
        recording: run.recording,
        recordingStepIndex: h.recordingStepIndex,
        hang: h.signal,
        openSession: freshSessionOpener(portFactory, launch, opts.allowlist),
        ...(opts.target?.safety === undefined ? {} : { safety: opts.target.safety }),
        writtenBy: run.sideEffects.map((e) => e.control), // #181
        perceive: {
          ...(opts.target?.settle === undefined ? {} : { settleConfig: opts.target.settle }),
          ...(opts.target?.hangs === undefined ? {} : { hangConfig: opts.target.hangs }),
        },
      });
      hang = hangFinding(h.signal, run.transcript, h.recordingStepIndex, reproduction);
    }
    // #150 — a declared mission spend budget crossed (or a paid action was refused before crossing
    // it): a clean, deliberate stop, never `crashed` — but never `clean` either (the run's own work
    // past the stop is unproven), so it maps to `inconclusive` the same as `run.stop === "inconclusive"`.
    const runOutcome: MissionOutcome =
      run.stop === "crashed"
        ? "crashed"
        : run.stop === "inconclusive" || run.stop === "budget"
          ? "inconclusive"
          : run.stop === "hang"
            ? hangOutcome(hang?.reproduction.status ?? "inconclusive")
            : "clean";
    const base = {
      timing: run.timing,
      stop: run.stop,
      outcome: run.outcome,
      ...(run.answer === undefined ? {} : { answer: run.answer }),
      screensObserved: collected.length,
      transcriptPath: journal.transcriptPath,
      recordingPath: journal.recordingPath,
      screenshotDir,
      evidencePath: evidenceWritten,
      screenshots: capture.screenshots(),
      sideEffects: run.sideEffects,
      ...(run.sideEffectsTruncated === undefined ? {} : { sideEffectsTruncated: run.sideEffectsTruncated }),
      engine: currentEngineInfo(),
      ...(run.failure === undefined ? {} : { failure: run.failure }),
      ...(run.crash === undefined ? {} : { crash: run.crash }),
      finalUrl: run.finalUrl,
      decisions: run.decisions,
      actions: run.actions,
      ...(runUsage === undefined ? {} : { usage: runUsage.snapshot() }),
      ...(hang === undefined ? {} : { hang }),
      // #142 follow-up: reported but never gates `missionOutcome`/`exitCode` — a UX finding is
      // always advisory, and a `server-log` defect here is treated the same way.
      ...serverLogResult(serverLogRun),
      ...(budget === null ? {} : { budget: budget.trajectory() }),
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
      return { ...unavailable, resultPath: writeMissionResult(journal.recordingPath, missionOutcome, unavailable.exitCode, unavailable, runUsage) };
    }
    const report = buildReport(groundFindings(withSignalFindings(outcome, signalFindings), friction), {
      minConfidence,
      quality,
      maxFindingsPerRoute,
      calibrationCaveats: [calibrationCaveat(opts.appContext.appClass)],
    });
    await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
    const reviewed = { ...base, report, reportPath, missionOutcome: runOutcome, exitCode: missionExitCode(runOutcome) };
    return { ...reviewed, resultPath: writeMissionResult(journal.recordingPath, runOutcome, reviewed.exitCode, reviewed, runUsage) };
  } finally {
    capture.detach();
    disarmKillSwitch();
    // Safety net: if the mission threw before `serverLog.finish()` ran, close sources immediately
    // (no drain wait) rather than leaving them open until process exit.
    await serverLog?.abort();
    // #159: reaches this even when the mission above threw — the context is still open here.
    await persistStorageState(session, opts.saveStorageState, snapshotter);
    await closeQuietly(session);
  }
}
