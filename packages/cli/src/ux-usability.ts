// ux-usability.ts — the live usability mission runner (`explore --strategy usability`) (#231).
import { logsDirFor } from "./project-dir.js";
import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve as resolvePath } from "node:path";
import type { JudgmentPort, GenerationPort, UsageTracker, UsageCounts } from "@jevitate/ai-core";
import { PlaywrightBrowserPort, type BrowserPort, type EmulationSpec } from "@jevitate/playwright";
import { closeOnce, demoOverlayOf, finalizeVideos, runVideoDir, sessionLaunchOptions, type BrowserRunOptions } from "./browser-run-options.js";
import { runCaptureFor, type ScreenshotsSpec } from "./run-screenshots.js";
import { evidenceOf, withRunEvidence } from "./defect-evidence.js";
import { CastActor, BrowseTheWeb } from "@jevitate/screenplay";
import type { InvariantSpec } from "@jevitate/recording";
import { explore, runGoalBasedMission, type GoalBasedResult, type SuccessCheck, type SuccessCheckResult, type SuccessWhen, type ExploreConfig, assertAuthorizedExploreTarget, resolveMissionFixture, reproduceHang, hangFinding, hangOutcome, InvariantMonitor, BudgetMonitor, type Bounds, type TimingSummary, type RunAnswer, type RunOutcome, type SecretField, type SecretCommandRunner, type HangFinding, type VerifySession, type SideEffect, type TranscriptEntry, type BudgetTrajectory, secretFieldSecrets, clippingSummary, detectClipping, detectOverflow, shouldCheckOverflow, type CrashReport } from "@jevitate/explore";
import { a11yChecks, analyzeClaims, buildReport, calibrationCaveat, claimsCaveat, detectFriction, detectSignals, groundFindings, loadV1Rubric, persistableScreen, resolveMinConfidence, resolveMaxFindingsPerRoute, resolveQualityPolicy, withSignalFindings, makeSignalFinding, type AnalysisOutcome, type AppContext, type GuardProbe, type SignalOptions, type UxEvidenceFile, type ScreenRef, type UxEvidence, type UxFinding, type UxReport } from "@jevitate/ux";
import { captureFindingShots, planGuardProbes, runGuardProbes, skippedProbes, withProbePage } from "./ux-claim-probe.js";
import { NO_PRODUCT_FACTS_CAVEAT, loadProductFacts } from "./ux-product.js";
import { conversationConfig, type ConversationOptions } from "./conversation-options.js";
import { loadUxMaxFindingsPerPage, loadUxMinConfidence, loadUxMinConfidenceByAppClass, loadUxShow } from "./ux-config.js";
import { foldGoalOutcome, type GoalOutcome, type MissionFailure, type MissionOutcome, clock } from "@jevitate/domain";
import { MissionJournal, artifactStamp, closeQuietly, resultPathFor, writeMissionResult } from "./mission-journal.js";
import { MISSION_RESULT_SCHEMA_VERSION, advisoryDefects, type AdvisoryServerLogDefect } from "./result-schema.js";
import { missionExitCode } from "./mission-exit.js";
import { launchArmed } from "./launch-armed.js";
import { branchFields, startFromJourney, type JourneyPrefix } from "./journey-prefix.js";
import type { JourneyBranchPoint } from "@jevitate/journey";
import { finishHostHealth } from "./host-health-run.js";
import { Http5xxOracle, type ActionDeltaStats, type HostHealthSampler, type Http5xxDefect, type RunDepth } from "@jevitate/explore";
import type { EnvironmentDegraded, HostHealthSummary } from "@jevitate/domain";
import { currentEngineInfo, type EngineInfo } from "./engine.js";
import { openServerLogRuntime, type ServerLogsSummary } from "./log-correlation.js";
import { triageOf, serverLogRuntimeOptions } from "./explore-shared.js";
import { assertSaveStorageStateOutsideProject, currentUrlSafe, persistStorageState, serverLogResult, type MissionTarget, type ServerLogOptions } from "./explore-api.js";
import type { TargetConfig } from "./target-config.js";
import { transcriptPathFor } from "./transcript-file.js";
import { UsabilityCapture } from "./usability-capture.js";
import { DEFAULT_JUDGMENT_BUDGET, extractTypedValues, snapshotToEvidence } from "./ux-evidence.js";
import { UxAnalysisFailedError } from "./ux-review.js";

// ---------- Live: `explore --strategy usability` ----------

export interface RunUsabilityMissionOptions {
  /** Test seam (#203): the run's host-health sampler (a deterministic fake host). Default: this host's. */
  readonly hostHealth?: HostHealthSampler;
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
  /** #324: runs a `cmd:` secret field's command at type time (CLI `--allow-secret-cmd`). */
  readonly secretCommand?: SecretCommandRunner;
  /** #359: `--secret-cmd-attempts`: runs of one `cmd:` binding's command per run (default 3). */
  readonly secretCommandAttempts?: number;
  /** Tuning of the run-signal oracles (#96), e.g. the hung-request floor. Defaults suit real apps. */
  readonly signals?: SignalOptions;
  /** Local file the `upload` op attaches (CLI `--fixture`); validated before any browser opens. */
  readonly fixture?: string;
  readonly judgmentBudget?: number;
  /** Conversational pages: the reply wait (ms) and the cap (chars) on each generated message. */
  readonly conversation?: ConversationOptions;
  readonly outDir?: string;
  readonly browserPortFactory?: () => BrowserPort;
  /** How Chromium is launched (executable/channel/extra args) and shown (#245 demo mode). Default: pinned Chromium, headless. */
  readonly browser?: BrowserRunOptions;
  /** #251 `--screenshots`: masked screenshots (one per distinct screen, or per step) + `index.md`. */
  readonly screenshots?: ScreenshotsSpec;
  /**
   * #250 `--evidence-video`: after the result is written, each defect's minimal repro is replayed
   * with captions (the failing step marked) into a masked clip + before/at screenshots, attached as
   * `defects[].evidence` (and to its issue draft).
   */
  readonly evidenceVideo?: boolean;
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
  /**
   * #225: independent completion checks on the job (CLI `--success`, a suite mission's `success`) —
   * the SAME semantics as a goal run's: every one must hold (grounding the model's `done` mid-run and
   * judged again on the final page), a vacuous one (#202) fails unless `allowVacuousChecks`, and the
   * verdict folds exactly like a goal run's (`goalOutcome` → `missionOutcome`). Never ignored: with
   * checks, the job's completion is theirs to decide, not the advisory goal judgment's.
   */
  readonly successChecks?: readonly SuccessCheck[];
  /** When the page checks must hold (`--success-when`): `final` (default) | `held`. */
  readonly successWhen?: SuccessWhen;
  /** #202 `--allow-vacuous-checks`: a check satisfied before the first action warns instead of failing. */
  readonly allowVacuousChecks?: boolean;
  /**
   * #198 `--product <file>`: the product facts (plans/prices, key journeys, each page's intended next
   * step). Default: `.jevitate/product.json` in the project, when present. Validated before a browser
   * opens (`ProductFactsError`, E_UX_PRODUCT_INPUT).
   */
  readonly product?: string;
  /** #198 `--polish`: polish each verified finding's recommendation with one generation call (opt-in). */
  readonly polish?: boolean;
  /**
   * #198 `--probe-guards` (opt-in): click each destructive control once, fail-safe (every write and
   * destructive-looking request aborted; refused on a page with an open WebSocket/EventSource or a
   * controlling service worker), to verify whether a confirmation guards it. Off: nothing is clicked,
   * and those guard claims are reported unverifiable.
   */
  readonly probeGuards?: boolean;
  /**
   * #293 `--from-journey`/`--at-step`: replayed into the session before the review, which then starts
   * on the live page it left — never a fresh navigation. `url` is only the expected landing.
   */
  readonly journeyPrefix?: JourneyPrefix;
  /**
   * #303 `--action-deltas` (opt-in, off by default): record what each action changed on the page
   * (code's verdict per action) — attached to every transcript and Recording step, summarised in the
   * result (`actionDeltas`), told to the model and used by the no-progress check. Off: no capture.
   */
  readonly actionDeltas?: boolean;
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
  /** The host's health over the run (#203): peaks, the slowest render, starved steps. */
  readonly hostHealth: HostHealthSummary;
  /** Findings met while the host was starved (#203) — advisory, never a defect/hang, never failing the run. */
  readonly environmentDegraded: EnvironmentDegraded[];
  /** #293: the Journey step a journey-anchored review branched from (absent on a bare-URL run). */
  readonly branch?: JourneyBranchPoint;
  /** The result schema's version (#195): the common fields are filled the same way by every strategy. */
  readonly schemaVersion: typeof MISSION_RESULT_SCHEMA_VERSION;
  readonly strategy: "usability";
  /** Where the review ran (#195: every strategy states its scope the same way) — a session PATH at most. */
  readonly target: MissionTarget;
  /**
   * EVERY defect the review found (#195) — HTTP 5xx hard-signal defects (#208) and `server-log`
   * defects (#142), each marked `advisory: true`: reported like every other strategy's, never gating
   * a UX review's outcome.
   */
  readonly defects: Array<AdvisoryServerLogDefect | (Http5xxDefect & { readonly advisory: true })>;
  /** Hang findings (0 or 1: the review stops at a hang), as every strategy lists them (#195). */
  readonly hangs: HangFinding[];
  /** Every Recording the review wrote (#195: one list on every strategy) — a review writes one. */
  readonly recordingPaths: string[];
  /** #245: `--record-video` files, finalized before this result was written (absent when not recording). */
  readonly videoPaths?: string[];
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
  /** #303: the run's action deltas (verdict counts, per-action overhead) — only with `--action-deltas`. */
  readonly actionDeltas?: ActionDeltaStats;
  /**
   * The typed verdict. UX findings are advisory, so a completed review is `clean`; a run whose
   * loop broke is `crashed`/`inconclusive`, and so is one whose analysis could not be produced — or
   * (#209) one whose job was never completed (`failure.kind: "job-incomplete"`).
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
  /** The hang finding (with its reproduction k/N), present when the run stopped on a hang (#126); also in `hangs`. */
  readonly hang?: HangFinding;
  /** The persisted typed result (`usability-<stamp>.recording.result.json`), readable via MCP `get_mission_result`. */
  readonly resultPath: string;
  /** Backend log correlation summary (#142) — present only when `--log-source` was given. */
  readonly serverLogs?: ServerLogsSummary;
  /** Declared mission spend budgets (#150): the observed trajectory, present when any were declared. */
  readonly budget?: BudgetTrajectory[];
  /**
   * #225 — present only when `successChecks` were given: the job's own ending as a goal run names it
   * (`succeeded` / `failed` / `exhausted` / `blocked` / …), folded onto `missionOutcome` the same way.
   */
  readonly goalOutcome?: GoalOutcome;
  /** #225: each success check's result, when `successChecks` were given. */
  readonly checks?: readonly SuccessCheckResult[];
  /** #225/#202: the success checks' warnings (a vacuous check, `held` notes), when there were any. */
  readonly checkWarnings?: readonly string[];
  /** #424: how deep the run went — distinct states and pages, actions, decisions, forms submitted. */
  readonly depth: RunDepth;
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
  // #198: the product facts are validated before a browser opens (a bad file is a usage error).
  const product = await loadProductFacts(opts.product);
  // #250/#251: a recorded or screenshotted run's sessions carry the live pixel mask from their first
  // paint; `--screenshots` captures after each step (the Recording path names their folder).
  const runCapture = runCaptureFor({
    recordsVideo: opts.browser?.recordVideo !== undefined,
    screenshots: opts.screenshots,
    secrets: [...(opts.secrets ?? []), ...secretFieldSecrets(opts.secretFields)],
    artifactPath: () => journal.recordingPath,
    title: `usability: ${opts.job}`,
  });
  const portFactory = runCapture.wrap(opts.browserPortFactory ?? (() => new PlaywrightBrowserPort()));
  const port = portFactory();
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
  const iso = (opts.nowIso ?? (() => clock.nowIso()))();
  const stamp = artifactStamp(iso);
  const reportPath = join(outDir, `usability-${stamp}.json`);
  // #98 — the same artifact shape as goal/adversarial missions, next to the report: the decision
  // transcript (each step's redacted typed value and screenshot), the Recording and the per-step
  // screenshots. Crash-safe: the transcript and partial Recording are flushed after every step.
  const journal = new MissionJournal(join(outDir, `usability-${stamp}.recording.json`), transcriptPathFor(reportPath));
  const screenshotDir = join(outDir, `usability-${stamp}.screens`);
  // #245: shown/recorded like every other strategy's session (videos in `usability-<stamp>.videos/`).
  const videoDir = runVideoDir(opts.browser, reportPath);
  const launch = {
    ...sessionLaunchOptions(opts.browser, videoDir),
    allowedOrigins: [...opts.allowlist],
    baseUrl: origin,
    ...opts.emulation,
    ...(opts.storageState !== undefined ? { storageState: opts.storageState } : {}),
  };
  // A bound secret (or TOTP seed) is a run secret too: masked on screen, redacted everywhere.
  const secrets = [...(opts.secrets ?? []), ...secretFieldSecrets(opts.secretFields)];
  // #163: this run's own share of a (possibly shared) tracker: its usage and sidecar.
  const runUsage = opts.usage?.scope();
  // The screenshot capture needs the open page; until then a killed run has taken none.
  let armedCapture: UsabilityCapture | undefined;
  // Crash-safe on SIGTERM/SIGINT too (#94): a partial `inconclusive` result is written from
  // whatever the journal has already flushed, and the process exits with the conventional code.
  // #120: the transcript lives next to the REPORT (`usability-<stamp>.transcript.json`), not the
  // Recording — so the killed run's result names the real file, and reports the live step list,
  // the tokens spent so far and the screens already observed.
  // #226: the kill switch is armed BEFORE the host sampler and the browser launch (see launch-armed.ts).
  const { disarmKillSwitch, health, session, snapshotter } = await launchArmed({
    hostHealth: opts.hostHealth,
    saveStorageState: opts.saveStorageState !== undefined,
    open: () => port.open(launch),
    mission: (hooks) => ({
      // #220: the killed run's partial result carries the unified schema's common fields too.
      strategy: "usability",
      target: { seedUrl: opts.url, allowlist: [...opts.allowlist], ...(opts.storageState !== undefined ? { storageStatePath: resolvePath(opts.storageState) } : {}) },
      recordingPath: journal.recordingPath,
      hostHealth: hooks.hostHealth,
      ...(videoDir === undefined ? {} : { videoDir }),
      transcriptPath: journal.transcriptPath,
      transcript: () => journal.transcript,
      ...(runUsage === undefined ? {} : { usage: runUsage }),
      partialReport: () => ({ screensObserved: collected.length, screenshotDir, screenshots: armedCapture === undefined ? [] : armedCapture.screenshots() }),
      ...(opts.saveStorageState === undefined ? {} : { storageState: { path: opts.saveStorageState, snapshot: hooks.snapshot } }),
    }),
  });
  // #324: the engine runs a cmd: binding's command at type time. A value read mid-run joins this
  // run's secrets at once (screenshots' scan, result, evidence, report) and — #360 — the run's pixel
  // mask, before the value is typed. (It was once handed to UsabilityCapture, which has no such
  // option, so a usability run could not type a cmd: field at all.)
  const uxSecretCommand: SecretCommandRunner | undefined =
    opts.secretCommand === undefined
      ? undefined
      : async (command: string) => {
          const out = await opts.secretCommand!(command);
          const value = out.trim();
          if (value !== "" && !secrets.includes(value)) secrets.push(value);
          if (value !== "") await runCapture.mask.addSecret(value);
          return out;
        };
  // #208: the shared HTTP 5xx hard signal, listening from before the first navigation.
  const http5xx = new Http5xxOracle(session.page, { allowlist: opts.allowlist });
  const capture = new UsabilityCapture({
    page: session.page,
    screenshotDir,
    secrets,
    ...(opts.secretFields === undefined ? {} : { secretFields: opts.secretFields }),
  });
  armedCapture = capture;
  // The usability capture (screenshots) and the journal (crash-safe flush) are the EXISTING listener
  // chain; a server-log runtime (#142) is inserted in FRONT of it (never replacing it) so every step
  // still gets its screenshot/flush exactly as before, whether or not --log-source was given. #159:
  // every settled step also refreshes the in-memory storageState snapshot (a cheap no-op when
  // `--save-storage-state` was not given).
  const journalListener = (entry: TranscriptEntry, all: readonly TranscriptEntry[]): void => {
    runCapture.noteEntry(session.page, entry);
    health.noteStep(entry);
    http5xx.noteStep(entry);
    capture.noteEntry(entry, all);
    journal.onTranscriptEntry(entry, capture.withScreenshots(all));
    snapshotter.noteSettledStep(currentUrlSafe(session));
  };
  const serverLog = openServerLogRuntime({
    ...serverLogRuntimeOptions(opts.serverLog),
    secrets,
    onTranscriptEntry: journalListener,
  });
  // #204: every request's correlation ids, from before the first navigation.
  serverLog?.observe(session.page);
  // #159/#245: persisted and closed once — early (before the result is written) when recording video.
  const closeSession = closeOnce(async () => {
    await persistStorageState(session, opts.saveStorageState, snapshotter);
    await closeQuietly(session);
  });
  try {
    // #293: a journey-anchored review first replays its Journey's prefix into this very session.
    const start = await startFromJourney(opts.journeyPrefix, session, opts.url, opts.allowlist, opts.browser);
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
    const exploreCfg: Omit<ExploreConfig, "missionContext"> = {
      ...(opts.target?.timing === undefined ? {} : { timingConfig: opts.target.timing }),
      ...(opts.target?.settle === undefined ? {} : { settle: opts.target.settle }),
      ...(opts.target?.hangs === undefined ? {} : { hangs: opts.target.hangs }),
      ...(opts.target?.safety === undefined ? {} : { safety: opts.target.safety }),
      onTranscriptEntry: serverLog?.onTranscriptEntry ?? journalListener,
      onRecording: journal.onRecording,
      // #303 (opt-in): action deltas, with Jev's advisory relevance labels.
      ...(opts.actionDeltas === true ? { actionDeltas: { jev: true } } : {}),
      hostHealth: health,
      demoOverlay: demoOverlayOf(opts.browser),
      ...(opts.secretFields === undefined ? {} : { secretFields: opts.secretFields }),
      ...(uxSecretCommand === undefined ? {} : { secretCommand: uxSecretCommand }),
      ...(opts.secretCommandAttempts === undefined ? {} : { secretCommandAttempts: opts.secretCommandAttempts }),
      actor,
      judge: opts.judge,
      gen: opts.gen,
      goal: opts.job,
      allowlist: opts.allowlist,
      startUrl: start.url,
      ...(start.branch === undefined ? {} : { startInPlace: true }),
      ...(start.restart === undefined ? {} : { restartAtStart: start.restart.restartAtStart }),
      bounds: opts.bounds,
      secrets: opts.secrets,
      site: origin,
      fixture,
      ...conversationConfig(opts.conversation),
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
            // #302: text cut off vertically (a fixed-height box, or above the page top) — one finding per element.
            const clipped = await detectClipping(session.page, {
              viewport: vp ?? { width: 1280, height: 720 },
              ...(opts.emulation?.device === undefined ? {} : { device: opts.emulation.device }),
              ...(opts.overflow?.ignoreSelectors === undefined ? {} : { ignoreSelectors: opts.overflow.ignoreSelectors }),
              secrets,
            });
            for (const c of clipped) {
              if (seenOverflow.has(c.fingerprint)) continue;
              seenOverflow.add(c.fingerprint);
              overflowFindings.push(
                makeSignalFinding({
                  kind: "vertical-clipping",
                  confidence: 0.9,
                  url: ev.url,
                  screenId: ev.screenId,
                  observation:
                    c.cause === "overflow-hidden"
                      ? `${c.element.descriptor} cuts off its text by ${c.clippedPx}px on ${c.route}: the content is taller than the box and overflow is hidden.`
                      : `${c.element.descriptor} is cut off ${c.clippedPx}px above the top of the page on ${c.route}.`,
                  userImpact: "Part of the text is cut off and no scroll position shows it: a user on this device cannot read it.",
                  recommendation:
                    c.cause === "overflow-hidden"
                      ? `Let ${c.element.descriptor} grow with its content (min-height instead of height), make it scrollable, or truncate on purpose with line-clamp at ${c.viewport.width}px.`
                      : `Give the container of ${c.element.descriptor} room for its wrapped content (no fixed height, or no wrapping) at ${c.viewport.width}px.`,
                  controls: [c.element.descriptor],
                  evidence: { kind: "vertical-clipping", steps: [history.length], requests: [], detail: clippingSummary(c) },
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
    };
    const brief = "usability review: pursue the stated job as a plausible first-time user, using only what is on screen";
    // #225: `--success` is never ignored — with checks the loop runs through the goal mission's
    // independent adjudication (the same oracle, `held`/vacuous rules and verdict as a goal run).
    const checks = opts.successChecks ?? [];
    const adjudication: GoalBasedResult | undefined =
      checks.length === 0
        ? undefined
        : await runGoalBasedMission({
            ...exploreCfg,
            missionBrief: brief,
            successChecks: checks,
            // #225: a `done` whose check failed on a job judged done ends the run — never the whole budget.
            stopWhenJudgedDone: true,
            ...(opts.successWhen === undefined ? {} : { successWhen: opts.successWhen }),
            ...(opts.allowVacuousChecks === true ? { allowVacuousChecks: true } : {}),
          });
    const run = adjudication?.run ?? (await explore({ ...exploreCfg, missionContext: brief }));
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
    // #198: every destructive control on an analyzed screen is clicked once with its writes blocked
    // (ux-claim-probe.ts) — the code evidence `destructive-unguarded` claims are verified against.
    // On a dedicated page in the run's context, after the loop: the run's oracles never see it.
    // A screen that cannot be redacted means no probes at all (destructive claims: unverifiable).
    let probes: GuardProbe[] | undefined;
    try {
      const plan = planGuardProbes(screens, secrets, opts.target?.safety);
      probes = [...plan.refused];
      // Clicking is opt-in (--probe-guards): without it every destructive control is `skipped`, and
      // its guard claim is reported unverifiable — never asserted, never silently dropped.
      if (opts.probeGuards !== true) probes.push(...skippedProbes(plan.targets));
      else if (plan.targets.length > 0) {
        try {
          probes.push(...(await runGuardProbes(session.page, plan.targets, { allowlist: opts.allowlist, secrets })));
        } catch (err) {
          const why = `the guard probe could not open a page: ${err instanceof Error ? err.message.split("\n")[0] : String(err)}`;
          probes.push(...plan.targets.map((t): GuardProbe => ({ screenId: t.screen.screenId, route: t.route, control: t.label, controlKey: t.key, status: "failed", detail: why })));
        }
      }
    } catch {
      probes = undefined;
    }
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
        ...(probes === undefined ? {} : { probes }),
      };
      await mkdir(outDir, { recursive: true });
      await writeFile(evidencePath, `${JSON.stringify(file, null, 2)}\n`, "utf8");
      evidenceWritten = evidencePath;
    } catch {
      evidenceWritten = null;
    }
    // #198: findings are claims verified by code (claims.ts) — guard probes, product facts and the
    // friction the run walked into — categorized and graded by Jev, written from templates.
    const claimed = await analyzeClaims(
      {
        screens,
        rubric: loadV1Rubric(),
        appContext: opts.appContext,
        secrets,
        judgmentBudget: opts.judgmentBudget ?? DEFAULT_JUDGMENT_BUDGET,
        friction,
        steps: signalCapture.steps,
        signalFindings,
        ...(probes === undefined ? {} : { probes }),
        ...(product.facts === undefined ? {} : { facts: product.facts }),
      },
      { judge: opts.judge, gen: opts.gen, a11yChecker: a11yChecks, ...(opts.polish === true ? { polish: true } : {}) },
    );
    // #198: a cropped, masked screenshot with the cited control boxed, per verified claim finding.
    let outcome: AnalysisOutcome = claimed;
    if (claimed.kind === "analyzed" && claimed.findings.some((f) => f.claim !== undefined)) {
      const byScreen = new Map(screens.map((ev) => [ev.screenId, ev]));
      const dir = join(outDir, `usability-${stamp}.findings`);
      try {
        const findings = await withProbePage(session.page, (p) => captureFindingShots(p, claimed.findings, byScreen, { dir, allowlist: opts.allowlist, secrets }));
        outcome = { ...claimed, findings };
      } catch {
        outcome = claimed; // presentation only: findings without screenshots are still the findings
      }
    }
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
      ...(jobFailure === undefined ? {} : { wouldHaveBeen: jobFailure.message }),
    });
    const runOutcome: MissionOutcome = host.outcome;
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
      ...(run.actionDeltas === undefined ? {} : { actionDeltas: run.actionDeltas }),
      engine: currentEngineInfo(),
      ...((): { failure?: MissionFailure } => {
        const f = run.failure ?? host.failure ?? jobFailure;
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
      defects: [
        ...http5xx.defects(run.transcript, run.recording.pages.flatMap((p) => p.steps)[0]?.step.kind === "navigate" ? 1 : 0).map((d) => ({ ...d, advisory: true as const })),
        ...advisoryDefects(serverLogRun?.defects),
      ],
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
  } finally {
    capture.detach();
    disarmKillSwitch();
    health.stop();
    // Safety net: if the mission threw before `serverLog.finish()` ran, close sources immediately
    // (no drain wait) rather than leaving them open until process exit.
    await serverLog?.abort();
    // #159: reaches this even when the mission above threw — the context is still open here.
    await closeSession();
  }
}
