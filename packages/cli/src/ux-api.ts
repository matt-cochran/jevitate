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
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { JudgmentPort, GenerationPort, UsageTracker, UsageCounts } from "@jevitate/ai-core";
import { PlaywrightBrowserPort, type BrowserLaunchOptions, type BrowserPort } from "@jevitate/playwright";
import { CastActor, BrowseTheWeb } from "@jevitate/screenplay";
import type { Recording, TargetDescriptor } from "@jevitate/recording";
import {
  explore,
  assertAuthorizedExploreTarget,
  resolveMissionFixture,
  type Snapshot,
  type Control as ExploreControl,
  type Bounds,
  type TimingSummary,
  type RunAnswer,
  type RunOutcome,
  type SecretField,
  secretFieldSecrets,
} from "@jevitate/explore";
import {
  UxAnalyzer,
  a11yChecks,
  buildReport,
  calibrationCaveat,
  detectSignals,
  loadV1Rubric,
  resolveMinConfidence,
  resolveQualityPolicy,
  withSignalFindings,
  type AppContext,
  type SignalOptions,
  type Control as UxControl,
  type ScreenRef,
  type UxEvidence,
  type UxReport,
} from "@jevitate/ux";
import { resolveDataDir } from "./data-dir.js";
import { conversationConfig, type ConversationOptions } from "./conversation-options.js";
import { loadUxMinConfidence, loadUxMinConfidenceByAppClass, loadUxShow } from "./ux-config.js";
import type { MissionFailure, MissionOutcome } from "@jevitate/domain";
import { MissionJournal, artifactStamp, closeQuietly, writeMissionResult } from "./mission-journal.js";
import { missionExitCode } from "./mission-exit.js";
import { armMissionKillSwitch } from "./kill-signal.js";
import { currentEngineInfo, type EngineInfo } from "./engine.js";
import type { TargetConfig } from "./target-config.js";
import { transcriptPathFor } from "./transcript-file.js";
import { UsabilityCapture } from "./usability-capture.js";

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
  readonly op?: string | null;
  readonly actOk: boolean;
  readonly reason?: string;
  readonly url: string;
  readonly descriptor?: TargetDescriptor;
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
   * `JEVITATE_UX_SHOW` > config `ux.show` > `DEFAULT_QUALITY_POLICY`.
   */
  readonly show?: string;
  readonly env?: Readonly<Record<string, string | undefined>>;
  /** Path of the config file holding `ux.minConfidence`. Default `~/.jevitate/config.json`. */
  readonly configPath?: string;
  readonly secrets?: readonly string[];
  /** Local file the `upload` op attaches (CLI `--fixture`); validated before any browser opens. */
  readonly fixture?: string;
  readonly judgmentBudget?: number;
  /** Where to write the report. Default `~/.jevitate/ux-reports`. */
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
}

export interface RunUxReviewResult {
  readonly report: UxReport;
  readonly reportPath: string;
  /** Judgment/generation call counts and tokens for this run (#100); present only when `opts.usage` was supplied. */
  readonly usage?: UsageCounts;
}

const NO_TRANSCRIPT_CAVEAT =
  "blocked/disabled-target evidence not available: this offline pass has no mission transcript, so a dead end like a button that never enables cannot be seen (pass --result <mission-result.json>, as written by `jevitate explore`, to include it — the same evidence a live usability run sees).";

/**
 * Offline UX review. FAIL-FAST: an analyzer `failed` outcome throws
 * `UxAnalysisFailedError` (the CLI maps it to a non-zero fail envelope) — never
 * a fabricated "clean" report.
 */
export async function runUxReview(opts: RunUxReviewOptions): Promise<RunUxReviewResult> {
  const minConfidence = resolveMinConfidence(
    opts.minConfidence,
    opts.env ?? process.env,
    loadUxMinConfidence(opts.configPath),
    loadUxMinConfidenceByAppClass(opts.configPath, opts.appContext.appClass),
  );
  const quality = resolveQualityPolicy(opts.show, opts.env ?? process.env, loadUxShow(opts.configPath));
  const analyzer = new UxAnalyzer({ judge: opts.judge, gen: opts.gen, a11yChecker: a11yChecks });
  const screens = recordingToEvidence(opts.recording, opts.appContext, opts.appContext.job, opts.missionTranscript);
  const outcome = await analyzer.analyze({
    screens,
    rubric: loadV1Rubric(),
    appContext: opts.appContext,
    secrets: opts.secrets,
    judgmentBudget: opts.judgmentBudget ?? DEFAULT_JUDGMENT_BUDGET,
  });
  if (outcome.kind === "failed") {
    throw new UxAnalysisFailedError(outcome.reason, outcome.screenId, outcome.rubricItemId);
  }
  const evidenceCaveats = opts.missionTranscript === undefined ? [opts.missionTranscriptUnavailable ?? NO_TRANSCRIPT_CAVEAT] : [];
  const calibrationCaveats = [calibrationCaveat(opts.appContext.appClass)];
  const report = buildReport(outcome, { minConfidence, quality, evidenceCaveats, calibrationCaveats });
  const outDir = opts.outDir ?? resolveDataDir(["ux-reports"]);
  await mkdir(outDir, { recursive: true });
  const iso = (opts.nowIso ?? (() => new Date().toISOString()))();
  const reportPath = join(outDir, `ux-${iso.replace(/[:.]/g, "-")}.json`);
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  return { report, reportPath, ...(opts.usage === undefined ? {} : { usage: opts.usage.snapshot() }) };
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
   * `JEVITATE_UX_SHOW` > config `ux.show` > `DEFAULT_QUALITY_POLICY`.
   */
  readonly show?: string;
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
  /**
   * Playwright storageState JSON to seed the session from (CLI `--storage-state`) — the
   * deterministic authenticated pre-step. Holds live session cookies: handed only to the
   * browser, never to a model or a finding.
   */
  readonly storageState?: string;
  readonly nowIso?: () => string;
  /** The target's settle/hang configuration (`~/.jevitate/targets.json` + flags). */
  readonly target?: TargetConfig;
  /** Test seam: extract a page's visible text. Default reads the live page. */
  readonly extractText?: (session: { page: { evaluate: (fn: () => string) => Promise<string> } }) => Promise<string>;
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
  /** Every per-step screenshot written, in order. */
  readonly screenshots: readonly string[];
  /**
   * The typed verdict. UX findings are advisory, so a completed review is `clean`; a run whose
   * loop broke is `crashed`/`inconclusive`, and so is one whose analysis could not be produced.
   */
  readonly missionOutcome: MissionOutcome;
  readonly exitCode: number;
  readonly failure?: MissionFailure;
  /** Why the analysis could not be produced (the run's evidence is still kept). */
  readonly analysisUnavailable?: string;
  /** Slowest pages/transitions and endpoints (p50/max), keyed by normalized route/endpoint. */
  readonly timing: TimingSummary;
  /** Which build produced this result (issue #83): `{version, commit, builtAt}`. */
  readonly engine: EngineInfo;
  /** Judgment/generation call counts and tokens for this run (#100); present only when `opts.usage` was supplied. */
  readonly usage?: UsageCounts;
  /** The persisted typed result (`usability-<stamp>.recording.result.json`), readable via MCP `get_mission_result`. */
  readonly resultPath?: string;
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
  // Validate the cutoff before a browser opens — a bad value fails fast, never mid-run.
  const minConfidence = resolveMinConfidence(
    opts.minConfidence,
    opts.env ?? process.env,
    loadUxMinConfidence(opts.configPath),
    loadUxMinConfidenceByAppClass(opts.configPath, opts.appContext.appClass),
  );
  const quality = resolveQualityPolicy(opts.show, opts.env ?? process.env, loadUxShow(opts.configPath));
  const fixture = opts.fixture === undefined ? undefined : await resolveMissionFixture(opts.fixture);
  const portFactory = opts.browserPortFactory ?? (() => new PlaywrightBrowserPort());
  const port = portFactory();
  const session = await port.open({
    headless: true,
    allowedOrigins: [...opts.allowlist],
    baseUrl: origin,
    ...opts.browser,
    ...(opts.storageState !== undefined ? { storageState: opts.storageState } : {}),
  });
  const collected: UxEvidence[] = [];
  const history: ScreenRef[] = [];
  const extract =
    opts.extractText ??
    (async (s: { page: { evaluate: (fn: () => string) => Promise<string> } }) =>
      s.page.evaluate(() => (typeof document !== "undefined" && document.body ? document.body.innerText : "")));
  const outDir = opts.outDir ?? resolveDataDir(["ux-reports"]);
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
  const disarmKillSwitch = armMissionKillSwitch({
    recordingPath: journal.recordingPath,
    transcriptPath: journal.transcriptPath,
    transcript: () => journal.transcript,
    ...(opts.usage === undefined ? {} : { usage: opts.usage }),
    partialReport: () => ({ screensObserved: collected.length, screenshotDir, screenshots: capture.screenshots() }),
  });
  try {
    const actor = CastActor.named("usability-mission").whoCan(new BrowseTheWeb(session, [...opts.allowlist]));
    const run = await explore({
      ...(opts.target?.timing === undefined ? {} : { timingConfig: opts.target.timing }),
      ...(opts.target?.settle === undefined ? {} : { settle: opts.target.settle }),
      ...(opts.target?.hangs === undefined ? {} : { hangs: opts.target.hangs }),
      onTranscriptEntry: (entry, all) => {
        capture.noteEntry(entry, all);
        journal.onTranscriptEntry(entry, capture.withScreenshots(all));
      },
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
      },
    });
    journal.writeRecording(run.recording);
    journal.writeTranscript(capture.withScreenshots(run.transcript));

    // #85 item 1: the live run's own typed values (from its emitted Recording's fill/select
    // steps — never a secret), so the vocabulary/jargon tier can tell the app's own copy apart
    // from user-authored content it merely echoed back (same mechanism as the offline pass).
    const typedValues = extractTypedValues(run.recording);
    const screens = typedValues.length > 0 ? collected.map((ev) => ({ ...ev, typedValues })) : collected;
    // #96: findings from the run's own measurements (hung request, duplicate write, internal id,
    // inert control) — independent code, no model — reported alongside the rubric's.
    const signalFindings = detectSignals(await capture.signalCapture(run.transcript, typedValues), opts.signals);
    const analyzer = new UxAnalyzer({ judge: opts.judge, gen: opts.gen, a11yChecker: a11yChecks });
    const outcome = await analyzer.analyze({
      screens,
      rubric: loadV1Rubric(),
      appContext: opts.appContext,
      secrets,
      judgmentBudget: opts.judgmentBudget ?? DEFAULT_JUDGMENT_BUDGET,
    });
    const runOutcome: MissionOutcome =
      run.stop === "crashed" ? "crashed" : run.stop === "inconclusive" ? "inconclusive" : "clean";
    const base = {
      timing: run.timing,
      stop: run.stop,
      outcome: run.outcome,
      ...(run.answer === undefined ? {} : { answer: run.answer }),
      screensObserved: collected.length,
      transcriptPath: journal.transcriptPath,
      recordingPath: journal.recordingPath,
      screenshotDir,
      screenshots: capture.screenshots(),
      engine: currentEngineInfo(),
      ...(run.failure === undefined ? {} : { failure: run.failure }),
      ...(opts.usage === undefined ? {} : { usage: opts.usage.snapshot() }),
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
      return { ...unavailable, resultPath: writeMissionResult(journal.recordingPath, missionOutcome, unavailable.exitCode, unavailable) };
    }
    const report = buildReport(withSignalFindings(outcome, signalFindings), {
      minConfidence,
      quality,
      calibrationCaveats: [calibrationCaveat(opts.appContext.appClass)],
    });
    await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
    const reviewed = { ...base, report, reportPath, missionOutcome: runOutcome, exitCode: missionExitCode(runOutcome) };
    return { ...reviewed, resultPath: writeMissionResult(journal.recordingPath, runOutcome, reviewed.exitCode, reviewed) };
  } finally {
    capture.detach();
    disarmKillSwitch();
    await closeQuietly(session);
  }
}
