import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve as resolvePath } from "node:path";
import type { JudgmentPort, GenerationPort, CredentialKey } from "@jevitate/ai-core";
import { PlaywrightBrowserPort, type BrowserLaunchOptions, type BrowserPort } from "@jevitate/playwright";
import { CastActor, BrowseTheWeb } from "@jevitate/screenplay";
import type { Assertion, Recording, TargetDescriptor } from "@jevitate/recording";
import {
  runGoalBasedMission,
  authorJourney,
  runInductionMission,
  runAdversarialMission,
  runFeatureMission,
  assertAuthorizedExploreTarget,
  normalizeAllowlist,
  resolveMissionFixture,
  type Bounds,
  type CoverageReport,
  type GoalBasedOutcome,
  type StopReason,
  type AuthorJourneyResult,
  type AdversarialOutcome,
  type MisuseStrategy,
  type CapabilityScope,
  type FeatureRunResult,
  type TranscriptEntry,
  type RunOutcome,
  type CoverageThresholds,
  type StatusSpec,
  type SuccessCheck,
  type SuccessCheckResult,
} from "@jevitate/explore";
import { FsJourneyStore } from "@jevitate/journey";
import { conversationConfig, type ConversationOptions } from "./conversation-options.js";
import {
  combineOutcomes,
  type FilingConfig,
  type IssueDraft,
  type IssueFilerPort,
  type MissionFailure,
  type MissionOutcome,
} from "@jevitate/domain";
import {
  currentEnvironment,
  draftForCrash,
  draftForDefect,
  draftForHang,
  hangOutcome,
  summarizeTimings,
  type DraftContext,
  type HangFinding,
  type TimingSummary,
  type VerifySession,
} from "@jevitate/explore";
import { processIssueDrafts, type FindingsIssues } from "./findings-filing.js";
import { readCliVersion } from "./version.js";
import type { TargetConfig } from "./target-config.js";
import { resolveDataDir } from "./data-dir.js";
import { MissionJournal, artifactStamp, closeQuietly, resultPathFor, writeMissionResult } from "./mission-journal.js";
import { goalExitCode, missionExitCode } from "./mission-exit.js";

/**
 * The programmatic surface behind `jevitate explore` — wires a real Playwright
 * `Page` + gateways to `@jevitate/explore`'s goal-based mission, then persists
 * the emitted `Recording` under `~/.jevitate/recordings`.
 *
 * The authorized-target guard runs FIRST (fail-closed), BEFORE any browser is
 * opened — an unauthorized origin never launches Chromium. Gateways are
 * injected (fakes in tests / live wiring in `program.ts`), so this file needs
 * no keys or network to be unit-tested.
 */

export interface RunExplorationOptions {
  readonly url: string;
  readonly goal: string;
  /** A success assertion on the final page. With `successChecks`, every one must hold. */
  readonly successAssertion?: Assertion;
  /** More independent checks (`--success`, repeatable): page, reloadThen, requestMade, responseStatus. */
  readonly successChecks?: readonly SuccessCheck[];
  readonly allowlist: readonly string[];
  readonly judge: JudgmentPort;
  readonly gen: GenerationPort;
  readonly bounds?: Partial<Bounds>;
  readonly secrets?: readonly string[];
  /**
   * Local file the `upload` op attaches (CLI `--fixture`). Validated before any
   * browser opens: a missing file throws `FixtureNotFoundError`.
   */
  readonly fixture?: string;
  /** Where the Recording is written. Default `~/.jevitate/recordings`. */
  readonly outDir?: string;
  /** Testing seam — defaults to a real `PlaywrightBrowserPort`. */
  readonly browserPortFactory?: () => BrowserPort;
  /** How Chromium is launched (executable/channel/extra args). Default: pinned Chromium. */
  readonly browser?: BrowserLaunchOptions;
  /**
   * Playwright storageState JSON to seed the session from (CLI `--storage-state`) —
   * the deterministic authenticated pre-step. Contains live session cookies: it is
   * handed only to the browser, never to a model or a Recording.
   */
  readonly storageState?: string;
  /** ISO clock for the recording filename. Default `Date.now()`. */
  readonly nowIso?: () => string;
  /** The target's settle/hang configuration (`~/.jevitate/targets.json` + flags). */
  readonly target?: TargetConfig;
  /** Issue filing for a crash (off unless enabled + a repo is configured). Default: drafts only. */
  readonly filing?: FilingConfig;
  /** Creates the filer — called only when filing is enabled. */
  readonly issueFiler?: () => IssueFilerPort;
  /** Fresh-context replays that confirm a hang (default 2). */
  readonly hangReplays?: number;
  /** Conversational pages: the reply wait (ms) and the cap (chars) on each generated message. */
  readonly conversation?: ConversationOptions;
}

/** Filing is off by default: drafts only, never a tracker call. */
const DRAFTS_ONLY: FilingConfig = { enabled: false, jevitateRepo: "matt-cochran/jevitate" };
const NO_FILER = (): IssueFilerPort => {
  throw new Error("issue filing is enabled but no filer was configured");
};

function draftContext(
  origin: string,
  journal: MissionJournal,
  secrets: readonly string[],
  browserVersion: string | undefined,
): DraftContext {
  return {
    environment: currentEnvironment(origin, {
      jevitateVersion: readCliVersion(),
      ...(browserVersion === undefined ? {} : { browser: browserVersion }),
    }),
    recordingPath: journal.recordingPath,
    transcriptPath: journal.transcriptPath,
    secrets,
  };
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

function browserVersionOf(page: { context(): { browser(): { version(): string } | null } }): string | undefined {
  try {
    return page.context().browser()?.version();
  } catch {
    return undefined;
  }
}

export interface RunExplorationResult {
  readonly outcome: GoalBasedOutcome;
  /**
   * Did the loop complete its goal (`completed`, verified by the success assertion), or why not
   * (`incomplete` + reason)? `outcome` above is the mission verdict; this is the run's own account.
   */
  readonly runOutcome: RunOutcome;
  readonly assertionPassed: boolean;
  /** Each success check's verdict and what the oracle saw. */
  readonly checks: SuccessCheckResult[];
  readonly stop: StopReason;
  readonly finalUrl: string;
  readonly decisions: number;
  readonly actions: number;
  readonly recordingPath: string;
  /**
   * The per-decision trail (op, target, confidence, whether the action succeeded and why
   * not, URL, page signature) — so a stalled or failed run is explainable. Written next to
   * the Recording as `<recording>.transcript.json`. Built from already-redacted state.
   */
  readonly transcriptPath: string;
  readonly transcript: readonly TranscriptEntry[];
  /** Process exit code for this outcome (see `goalExitCode`). */
  readonly exitCode: number;
  /** Why the run ended `crashed`/`inconclusive`. */
  readonly failure?: MissionFailure;
  /** Why the mission did not succeed (every outcome but `succeeded`, `blocked`/`exhausted` included). */
  readonly reason?: string;
  /** Issue drafts (a crash) written next to the Recording, and what filing did with them. */
  readonly issues: FindingsIssues;
  /** Slowest pages/transitions and endpoints (p50/max), keyed by normalized route/endpoint. */
  readonly timing: TimingSummary;
  /** Hang findings (0 or 1: the loop stops at a hang), each with its fresh-context reproduction. */
  readonly hangs: HangFinding[];
  /** The run's Recording (also written to `recordingPath`). */
  readonly recording: Recording;
  /** Where the run happened — what `verify-fix` needs to replay a finding. */
  readonly target: MissionTarget;
  /** The persisted typed result (`<recording>.result.json`). */
  readonly resultPath: string;
}

export async function runExploration(opts: RunExplorationOptions): Promise<RunExplorationResult> {
  // Guardrail #1 — authorize BEFORE opening a browser. Throws on refusal.
  const origin = assertAuthorizedExploreTarget(opts.url, opts.allowlist);
  // Fail fast on a missing fixture BEFORE launching Chromium.
  const fixture = opts.fixture === undefined ? undefined : await resolveMissionFixture(opts.fixture);

  const portFactory = opts.browserPortFactory ?? (() => new PlaywrightBrowserPort());
  const port = portFactory();
  const launch = {
    headless: true,
    allowedOrigins: [...opts.allowlist],
    baseUrl: origin,
    ...opts.browser,
    ...(opts.storageState !== undefined ? { storageState: opts.storageState } : {}),
  };
  const session = await port.open(launch);

  const outDir = opts.outDir ?? resolveDataDir(["recordings"]);
  await mkdir(outDir, { recursive: true });
  const iso = (opts.nowIso ?? (() => new Date().toISOString()))();
  // Crash-safe: the transcript and partial Recording are flushed after every step.
  const journal = new MissionJournal(join(outDir, `explore-${artifactStamp(iso)}.json`));
  try {
    const actor = CastActor.named("explorer").whoCan(new BrowseTheWeb(session, [...opts.allowlist]));
    const mission = await runGoalBasedMission({
      ...(opts.target?.timing === undefined ? {} : { timingConfig: opts.target.timing }),
      ...(opts.target?.settle === undefined ? {} : { settle: opts.target.settle }),
      ...(opts.target?.hangs === undefined ? {} : { hangs: opts.target.hangs }),
      // A hang is reproduced by replaying its steps in fresh contexts (same auth).
      openFreshSession: freshSessionOpener(portFactory, launch, opts.allowlist),
      ...(opts.hangReplays === undefined ? {} : { hangReplays: opts.hangReplays }),
      onTranscriptEntry: journal.onTranscriptEntry,
      onRecording: journal.onRecording,
      actor,
      judge: opts.judge,
      gen: opts.gen,
      goal: opts.goal,
      allowlist: opts.allowlist,
      startUrl: opts.url,
      ...(opts.successAssertion === undefined ? {} : { successAssertion: opts.successAssertion }),
      ...(opts.successChecks === undefined ? {} : { successChecks: opts.successChecks }),
      bounds: opts.bounds,
      secrets: opts.secrets,
      site: origin,
      fixture,
      ...conversationConfig(opts.conversation),
    });

    journal.writeRecording(mission.recording);
    journal.writeTranscript(mission.transcript);
    const ctx = draftContext(origin, journal, opts.secrets ?? [], browserVersionOf(session.page));
    const resultPath = resultPathFor(journal.recordingPath);
    const drafts: IssueDraft[] = [];
    if (mission.run.crash !== undefined) drafts.push(draftForCrash(mission.run.crash, mission.transcript, ctx));
    if (mission.hang !== undefined) {
      drafts.push(
        draftForHang(mission.hang, {
          ...ctx,
          verifyCommand: `jevitate verify-fix --result ${resultPath} --fingerprint ${mission.hang.fingerprint}`,
        }),
      );
    }
    const issues = await processIssueDrafts(
      journal.recordingPath,
      drafts,
      opts.filing ?? DRAFTS_ONLY,
      opts.issueFiler ?? NO_FILER,
      iso,
    );

    const result: RunExplorationResult = {
      issues,
      timing: mission.run.timing,
      outcome: mission.outcome,
      runOutcome: mission.run.outcome,
      assertionPassed: mission.assertionPassed,
      checks: mission.checks,
      stop: mission.run.stop,
      finalUrl: mission.finalUrl,
      decisions: mission.run.decisions,
      actions: mission.run.actions,
      recordingPath: journal.recordingPath,
      transcriptPath: journal.transcriptPath,
      transcript: mission.transcript,
      exitCode: goalExitCode(mission.outcome),
      resultPath,
      target: {
        seedUrl: opts.url,
        allowlist: [...opts.allowlist],
        ...(opts.storageState !== undefined ? { storageStatePath: resolvePath(opts.storageState) } : {}),
      },
      recording: mission.recording,
      hangs: mission.hang === undefined ? [] : [mission.hang],
      ...(mission.run.failure === undefined ? {} : { failure: mission.run.failure }),
      ...(mission.reason === undefined ? {} : { reason: mission.reason }),
    };
    // Persisted so `verify-fix` can replay a hang later (the typed result next to the Recording).
    writeMissionResult(journal.recordingPath, mission.outcome, result.exitCode, result);
    return result;
  } finally {
    await closeQuietly(session);
  }
}

/**
 * Arguments handed to the authoring step of `runAuthorJourney`. Kept separate
 * from `RunAuthorJourneyOptions` so tests can inject `authorImpl` (a fake
 * authoring step) without opening a real browser.
 */
export interface AuthorViaBrowserArgs {
  readonly url: string;
  readonly origin: string;
  readonly goal: string;
  readonly successAssertion: Assertion;
  readonly allowlist: readonly string[];
  readonly judge?: JudgmentPort;
  readonly gen?: GenerationPort;
  readonly bounds?: Partial<Bounds>;
  readonly takes: number;
  readonly journeyId: string;
  readonly journeyName: string;
  readonly browserPortFactory?: () => BrowserPort;
  /** How Chromium is launched (executable/channel/extra args). Default: pinned Chromium. */
  readonly browser?: BrowserLaunchOptions;
  /**
   * Playwright storageState JSON to seed the session from (CLI `--storage-state`) —
   * the deterministic authenticated pre-step. Contains live session cookies: it is
   * handed only to the browser, never to a model or a Recording.
   */
  readonly storageState?: string;
}

export interface RunAuthorJourneyOptions {
  readonly url: string;
  readonly goal: string;
  readonly successAssertion: Assertion;
  readonly allowlist: readonly string[];
  /** Where the authored Journey is persisted (via `FsJourneyStore`). */
  readonly journeysDir: string;
  readonly journeyId: string;
  readonly journeyName: string;
  /** Total takes incl. discovery. Default 1 (single-take MVP). */
  readonly takes?: number;
  readonly judge?: JudgmentPort;
  readonly gen?: GenerationPort;
  readonly bounds?: Partial<Bounds>;
  readonly browserPortFactory?: () => BrowserPort;
  /** How Chromium is launched (executable/channel/extra args). Default: pinned Chromium. */
  readonly browser?: BrowserLaunchOptions;
  /**
   * Playwright storageState JSON to seed the session from (CLI `--storage-state`) —
   * the deterministic authenticated pre-step. Contains live session cookies: it is
   * handed only to the browser, never to a model or a Recording.
   */
  readonly storageState?: string;
  /**
   * Test seam: override the authoring step. Defaults to `authorViaBrowser`,
   * which drives a real Playwright-backed actor through `authorJourney`.
   */
  readonly authorImpl?: (args: AuthorViaBrowserArgs) => Promise<AuthorJourneyResult>;
}

/**
 * The programmatic surface behind `jevitate explore author-journey` — drives
 * the goal-based exploration mission and feeds its take(s) through RxD's
 * diff/postdoc pipeline (`@jevitate/explore`'s `authorJourney`) to author a
 * parameterized, replayable, UNPROMOTED Journey, then persists it under the
 * journeys store. Additive: the record-by-demonstration authoring path is
 * untouched.
 *
 * The authorized-target guard runs FIRST (fail-closed), before any browser is
 * opened. The authoring step is injectable (`authorImpl`) so it is unit-testable
 * without a browser.
 */
export async function runAuthorJourney(opts: RunAuthorJourneyOptions): Promise<AuthorJourneyResult> {
  // Guardrail #1 — authorize BEFORE opening a browser. Throws on refusal.
  const origin = assertAuthorizedExploreTarget(opts.url, opts.allowlist);

  const impl = opts.authorImpl ?? authorViaBrowser;
  const result = await impl({
    url: opts.url,
    origin,
    goal: opts.goal,
    successAssertion: opts.successAssertion,
    allowlist: opts.allowlist,
    judge: opts.judge,
    gen: opts.gen,
    bounds: opts.bounds,
    takes: opts.takes ?? 1,
    journeyId: opts.journeyId,
    journeyName: opts.journeyName,
    browserPortFactory: opts.browserPortFactory,
    browser: opts.browser,
      ...(opts.storageState !== undefined ? { storageState: opts.storageState } : {}),
  });

  if (result.outcome === "authored") {
    await new FsJourneyStore(opts.journeysDir).put(result.journey);
  }
  return result;
}

/** Default authoring step: opens a real browser, builds an actor, authors. */
async function authorViaBrowser(args: AuthorViaBrowserArgs): Promise<AuthorJourneyResult> {
  if (!args.judge || !args.gen) {
    throw new Error("runAuthorJourney: judge and gen gateways are required to drive the authoring mission");
  }
  const judge = args.judge;
  const gen = args.gen;

  const portFactory = args.browserPortFactory ?? (() => new PlaywrightBrowserPort());
  const port = portFactory();
  const session = await port.open({
    headless: true,
    allowedOrigins: [...args.allowlist],
    baseUrl: args.origin,
    ...args.browser,
    ...(args.storageState !== undefined ? { storageState: args.storageState } : {}),
  });

  try {
    const actor = CastActor.named("author").whoCan(new BrowseTheWeb(session, [...args.allowlist]));
    return await authorJourney({
      goal: args.goal,
      successAssertion: args.successAssertion,
      allowlist: args.allowlist,
      startUrl: args.url,
      bounds: args.bounds,
      actor,
      judgment: judge,
      generation: gen,
      takes: args.takes,
      journeyId: args.journeyId,
      journeyName: args.journeyName,
    });
  } finally {
    await session.close();
  }
}

/**
 * The programmatic surface behind `jevitate explore --strategy coverage`
 * (additive, alongside `runExploration`). Wires a real Playwright `Page` +
 * gateways to `@jevitate/explore`'s proof-by-induction (state-coverage) mission
 * and persists each emitted repro `Recording` under `~/.jevitate/recordings`.
 *
 * Same fail-closed discipline as `runExploration`: the authorized-target guard
 * runs FIRST, before any browser is opened.
 */
export interface RunCoverageMissionOptions {
  readonly url: string;
  readonly allowlist: readonly string[];
  readonly judge: JudgmentPort;
  readonly gen: GenerationPort;
  readonly bounds?: Partial<Bounds>;
  /** Where the repro Recordings are written. Default `~/.jevitate/recordings`. */
  readonly outDir?: string;
  readonly browserPortFactory?: () => BrowserPort;
  /** How Chromium is launched (executable/channel/extra args). Default: pinned Chromium. */
  readonly browser?: BrowserLaunchOptions;
  /**
   * Playwright storageState JSON to seed the session from (CLI `--storage-state`) —
   * the deterministic authenticated pre-step. Contains live session cookies: it is
   * handed only to the browser, never to a model or a Recording.
   */
  readonly storageState?: string;
  readonly nowIso?: () => string;
  /** The target's settle/hang configuration (`~/.jevitate/targets.json` + flags). */
  readonly target?: TargetConfig;
}

export interface RunCoverageMissionResult {
  readonly coverage: CoverageReport;
  readonly outcome: "exhausted" | "cap" | "crashed" | "hang";
  /** Hangs met while exploring (deduped), each with its reproduction and its own path Recording. */
  readonly hangs: HangFinding[];
  /** A coverage run has no single Recording: each finding carries the path that reached it. */
  readonly recording: null;
  /** Where the run happened — what `verify-fix` needs to replay a finding. */
  readonly target: MissionTarget;
  /** The typed verdict: `crashed` for a broken run, else `defects-found` / `clean`. */
  readonly missionOutcome: MissionOutcome;
  readonly exitCode: number;
  readonly failure?: MissionFailure;
  /** Slowest pages/transitions and endpoints (p50/max), keyed by normalized route/endpoint. */
  readonly timing: TimingSummary;
  /** The persisted typed result (`coverage-<stamp>.result.json`). */
  readonly resultPath: string;
  readonly recordingPaths: string[];
  /** The shared decision transcript (`coverage-<stamp>.transcript.json`). */
  readonly transcriptPath: string;
}

export async function runCoverageMission(opts: RunCoverageMissionOptions): Promise<RunCoverageMissionResult> {
  // Guardrail #1 — authorize BEFORE opening a browser. Throws on refusal.
  const origin = assertAuthorizedExploreTarget(opts.url, opts.allowlist);

  const portFactory = opts.browserPortFactory ?? (() => new PlaywrightBrowserPort());
  const port = portFactory();
  const launch = {
    headless: true,
    allowedOrigins: [...opts.allowlist],
    baseUrl: origin,
    ...opts.browser,
    ...(opts.storageState !== undefined ? { storageState: opts.storageState } : {}),
  };
  const session = await port.open(launch);

  const outDir = opts.outDir ?? resolveDataDir(["recordings"]);
  await mkdir(outDir, { recursive: true });
  const iso = (opts.nowIso ?? (() => new Date().toISOString()))();
  const stamp = artifactStamp(iso);
  const journal = new MissionJournal(join(outDir, `coverage-${stamp}.json`));
  try {
    const actor = CastActor.named("coverage-mission").whoCan(new BrowseTheWeb(session, [...opts.allowlist]));
    const result = await runInductionMission({
      ...(opts.target?.timing === undefined ? {} : { timingConfig: opts.target.timing }),
      // A hang is reproduced in fresh contexts, and the frontier keeps being explored after it.
      openFreshSession: freshSessionOpener(portFactory, launch, opts.allowlist),
      ...(opts.target?.settle === undefined ? {} : { settle: opts.target.settle }),
      page: session.page,
      actor,
      judgment: opts.judge,
      generation: opts.gen,
      seedUrl: opts.url,
      allowlist: opts.allowlist,
      bounds: opts.bounds,
      onTranscriptEntry: journal.onTranscriptEntry,
    });

    const recordingPaths: string[] = [];
    for (let i = 0; i < result.recordings.length; i++) {
      const p = join(outDir, `coverage-${stamp}-state-${i}.json`);
      await writeFile(p, `${JSON.stringify(result.recordings[i], null, 2)}\n`, "utf8");
      recordingPaths.push(p);
    }
    journal.writeTranscript(result.transcript);
    const missionOutcome: MissionOutcome = combineOutcomes([
      result.outcome === "crashed" ? "crashed" : result.coverage.defects.length > 0 ? "defects-found" : "clean",
      ...result.hangs.map((h) => hangOutcome(h.reproduction.status)),
    ]);

    const exitCode = missionExitCode(missionOutcome);
    const typed = {
      hangs: result.hangs,
      recording: null,
      target: {
        seedUrl: opts.url,
        allowlist: [...opts.allowlist],
        ...(opts.storageState !== undefined ? { storageStatePath: resolvePath(opts.storageState) } : {}),
      },
      timing: result.timing,
      coverage: result.coverage,
      outcome: result.outcome,
      missionOutcome,
      exitCode,
      ...(result.failure === undefined ? {} : { failure: result.failure }),
      recordingPaths,
      transcriptPath: journal.transcriptPath,
    };
    return { ...typed, resultPath: writeMissionResult(journal.recordingPath, missionOutcome, exitCode, typed) };
  } finally {
    await closeQuietly(session);
  }
}

/**
 * Options for the additive adversarial CLI mission. Mirrors `runExploration`'s
 * fail-closed discipline: the authorized-target guard runs FIRST, before any
 * browser is opened, so an unauthorized origin never launches Chromium.
 */
export interface RunAdversarialCliMissionOptions {
  readonly seedUrl: string;
  readonly allowlist: readonly string[];
  readonly strategies: readonly MisuseStrategy[];
  readonly judgment: JudgmentPort;
  readonly generation: GenerationPort;
  /** Step/action budget (CLI `--max-decisions` / `--max-actions`). */
  readonly bounds?: Partial<Bounds>;
  readonly headless?: boolean;
  /** Testing seam — defaults to a real `PlaywrightBrowserPort`. */
  readonly browserPortFactory?: () => BrowserPort;
  /** How Chromium is launched (executable/channel/extra args). Default: pinned Chromium. */
  readonly browser?: BrowserLaunchOptions;
  /**
   * Playwright storageState JSON to seed the session from (CLI `--storage-state`) —
   * the deterministic authenticated pre-step. Contains live session cookies: it is
   * handed only to the browser, never to a model or a Recording.
   */
  readonly storageState?: string;
  /** Registered secret values (`--secret`): kept out of the transcript, Recording and issue drafts. */
  readonly secrets?: readonly string[];
  /** Issue filing (off unless enabled + a repo is configured). Default: drafts only. */
  readonly filing?: FilingConfig;
  /** Creates the filer — called only when filing is enabled. */
  readonly issueFiler?: () => IssueFilerPort;
  /** Fresh-context replays that confirm a hang (default 2). */
  readonly hangReplays?: number;
  /** Where the Recording and decision transcript are written. Default `~/.jevitate/recordings`. */
  readonly outDir?: string;
  /** ISO clock for the transcript filename. Default `Date.now()`. */
  readonly nowIso?: () => string;
  /** The target's settle/hang configuration (`~/.jevitate/targets.json` + flags). */
  readonly target?: TargetConfig;
  /** Extra in-scope route globs (`--route`); the start URL's route is always in scope. */
  readonly routeGlobs?: readonly string[];
  /** Coverage a silent run needs to be `clean` (`--min-control-coverage`, `--no-require-form-submit`). */
  readonly coverageThresholds?: Partial<CoverageThresholds>;
}

/** The adversarial outcome plus where its Recording and decision transcript were written. */
/** Where a mission ran — enough for `verify-fix` to replay one of its defects in a fresh session. */
export interface MissionTarget {
  readonly seedUrl: string;
  readonly allowlist: string[];
  /** Absolute path of the storageState file the run started from (never its contents). */
  readonly storageStatePath?: string;
}

export type AdversarialCliMissionResult = AdversarialOutcome & {
  readonly target: MissionTarget;
  /** One ready-to-file draft per defect (and per crash), written next to the Recording. */
  readonly issues: FindingsIssues;
  readonly recordingPath: string;
  /** The persisted typed result (`<recording>.result.json`), readable via MCP `get_mission_result`. */
  readonly resultPath: string;
  readonly transcriptPath: string;
  /** Process exit code for `outcome` (see `missionExitCode`). */
  readonly exitCode: number;
};

/**
 * Runs `@jevitate/explore`'s adversarial "try to break it" mission behind the
 * CLI. Guardrail #1 is enforced BEFORE opening a browser (fail-closed); the
 * session is always torn down. The stop-on-defect decision is the mission's
 * own trusted hard-signal oracle — never Jev's `Noul` (guardrail #4).
 */
export async function runAdversarialCliMission(
  opts: RunAdversarialCliMissionOptions,
): Promise<AdversarialCliMissionResult> {
  // Guardrail #1 — authorize BEFORE opening a browser. Throws on refusal.
  const origin = assertAuthorizedExploreTarget(opts.seedUrl, opts.allowlist);
  const portFactory = opts.browserPortFactory ?? (() => new PlaywrightBrowserPort());
  const port = portFactory();
  const launch = {
    headless: opts.headless ?? true,
    allowedOrigins: [...opts.allowlist],
    baseUrl: origin,
    ...opts.browser,
    ...(opts.storageState !== undefined ? { storageState: opts.storageState } : {}),
  };
  const session = await port.open(launch);
  const outDir = opts.outDir ?? resolveDataDir(["recordings"]);
  const iso = (opts.nowIso ?? (() => new Date().toISOString()))();
  // Crash-safe: the transcript and partial Recording are flushed after every step.
  const journal = new MissionJournal(join(outDir, `adversarial-${artifactStamp(iso)}.json`));
  try {
    const actor = CastActor.named("adversarial-mission").whoCan(new BrowseTheWeb(session, [...opts.allowlist]));
    const outcome = await runAdversarialMission({
      ...(opts.target?.timing === undefined ? {} : { timingConfig: opts.target.timing }),
      ...(opts.target?.settle === undefined ? {} : { settle: opts.target.settle }),
      ...(opts.target?.hangs === undefined ? {} : { hangs: opts.target.hangs }),
      page: session.page,
      actor,
      judgment: opts.judgment,
      generation: opts.generation,
      seedUrl: opts.seedUrl,
      allowlist: opts.allowlist,
      strategies: opts.strategies,
      ...(opts.routeGlobs === undefined ? {} : { routeGlobs: opts.routeGlobs }),
      ...(opts.coverageThresholds === undefined ? {} : { coverageThresholds: opts.coverageThresholds }),
      site: origin,
      ...(opts.bounds === undefined ? {} : { bounds: opts.bounds }),
      ...(opts.secrets === undefined ? {} : { secrets: opts.secrets }),
      // A hang is reproduced by replaying its steps in fresh contexts (same auth).
      openFreshSession: freshSessionOpener(portFactory, launch, opts.allowlist),
      ...(opts.hangReplays === undefined ? {} : { hangReplays: opts.hangReplays }),
      onTranscriptEntry: journal.onTranscriptEntry,
      onRecording: journal.onRecording,
    });
    journal.writeRecording(outcome.recording);
    journal.writeTranscript(outcome.transcript);
    const exitCode = missionExitCode(outcome.outcome);
    const resultPath = resultPathFor(journal.recordingPath);
    const ctx = draftContext(origin, journal, opts.secrets ?? [], browserVersionOf(session.page));
    const drafts: IssueDraft[] = outcome.defects.map((d) =>
      draftForDefect(d, { ...ctx, verifyCommand: `jevitate verify-fix --result ${resultPath} --fingerprint ${d.fingerprint}` }),
    );
    for (const h of outcome.hangs) {
      drafts.push(draftForHang(h, { ...ctx, verifyCommand: `jevitate verify-fix --result ${resultPath} --fingerprint ${h.fingerprint}` }));
    }
    if (outcome.crash !== undefined) drafts.push(draftForCrash(outcome.crash, outcome.transcript, ctx));
    const issues = await processIssueDrafts(
      journal.recordingPath,
      drafts,
      opts.filing ?? DRAFTS_ONLY,
      opts.issueFiler ?? NO_FILER,
      iso,
    );
    const result = {
      ...outcome,
      recordingPath: journal.recordingPath,
      transcriptPath: journal.transcriptPath,
      exitCode,
      issues,
      // What `verify-fix` needs to replay a defect later: where, which origins, which session file
      // (the storageState PATH only — its cookies never enter an artifact).
      target: {
        seedUrl: opts.seedUrl,
        allowlist: [...opts.allowlist],
        ...(opts.storageState !== undefined ? { storageStatePath: resolvePath(opts.storageState) } : {}),
      },
    };
    return { ...result, resultPath: writeMissionResult(journal.recordingPath, outcome.outcome, exitCode, result) };
  } finally {
    await closeQuietly(session);
  }
}

/**
 * The programmatic surface behind `jevitate explore --feature <name>` — the
 * capability-scoped feature-testing mission (ticket #2, paired site ticket
 * #11). Model-free by design, so unlike `runExploration` it needs no gateways.
 *
 * The authorized-target guard runs FIRST (fail-closed), BEFORE any browser is
 * opened — an unauthorized origin never launches Chromium.
 */
export interface RunFeatureCliMissionOptions {
  readonly seedUrl: string;
  readonly allowlist: readonly string[];
  readonly capability: string;
  readonly routeGlobs: readonly string[];
  readonly headless?: boolean;
  /** Step/action budget (CLI `--max-actions` / `--max-decisions`). */
  readonly bounds?: Partial<Bounds>;
  /** Testing seam — defaults to a real `PlaywrightBrowserPort`. */
  readonly browserPortFactory?: () => BrowserPort;
  /** How Chromium is launched (executable/channel/extra args). Default: pinned Chromium. */
  readonly browser?: BrowserLaunchOptions;
  /**
   * Playwright storageState JSON to seed the session from (CLI `--storage-state`) —
   * the deterministic authenticated pre-step. Contains live session cookies: it is
   * handed only to the browser, never to a model or a Recording.
   */
  readonly storageState?: string;
  /** Where the recordings, transcript and typed result are written. Default `~/.jevitate/recordings`. */
  readonly outDir?: string;
  /** ISO clock for output filenames. Default `Date.now()`. */
  readonly nowIso?: () => string;
}

/** The feature mission's result plus its typed verdict, exit code, and where its artifacts landed. */
export type FeatureCliMissionResult = FeatureRunResult & {
  /**
   * `clean` only when the run actually exercised an in-scope, non-chrome
   * control of the named capability (`coverage.inScopeActionsExercised > 0`).
   * A run that touched nothing but global chrome and/or left `--route` scope
   * on every attempt is `inconclusive` — never a fabricated `clean` (ticket
   * #78's guardrail: a run that proved nothing is never `clean`).
   */
  readonly missionOutcome: MissionOutcome;
  readonly exitCode: number;
  /** One Recording per distinct discovered path (`feature-<stamp>-path-<n>.json`). */
  readonly recordingPaths: string[];
  /** The shared decision transcript (`feature-<stamp>.transcript.json`). */
  readonly transcriptPath: string;
  /** The persisted typed result (`feature-<stamp>.result.json`), readable via MCP `get_mission_result`. */
  readonly resultPath: string;
};

export async function runFeatureCliMission(opts: RunFeatureCliMissionOptions): Promise<FeatureCliMissionResult> {
  // Guardrail #1 — authorize BEFORE opening a browser. Throws on refusal.
  const origin = assertAuthorizedExploreTarget(opts.seedUrl, opts.allowlist);
  const scope: CapabilityScope = { name: opts.capability, originAllowlist: opts.allowlist, routeGlobs: opts.routeGlobs };

  const portFactory = opts.browserPortFactory ?? (() => new PlaywrightBrowserPort());
  const launch = {
    headless: opts.headless ?? true,
    allowedOrigins: [...opts.allowlist],
    baseUrl: origin,
    ...opts.browser,
    ...(opts.storageState !== undefined ? { storageState: opts.storageState } : {}),
  };
  const session = await portFactory().open(launch);

  // Persist recordings + transcript + a typed result, like the goal and
  // coverage missions do (ticket #78 — previously nothing was written).
  const outDir = opts.outDir ?? resolveDataDir(["recordings"]);
  const iso = (opts.nowIso ?? (() => new Date().toISOString()))();
  const stamp = artifactStamp(iso);
  const journal = new MissionJournal(join(outDir, `feature-${stamp}.json`));
  try {
    const actor = CastActor.named("feature-mission").whoCan(new BrowseTheWeb(session, [...opts.allowlist]));
    const result = await runFeatureMission({
      openFreshSession: freshSessionOpener(portFactory, launch, opts.allowlist),
      page: session.page,
      actor,
      seedUrl: opts.seedUrl,
      allowlist: opts.allowlist,
      scope,
      bounds: opts.bounds,
      onTranscriptEntry: journal.onTranscriptEntry,
    });

    const recordingPaths: string[] = [];
    for (let i = 0; i < result.recordings.length; i++) {
      const p = join(outDir, `feature-${stamp}-path-${i}.json`);
      await writeFile(p, `${JSON.stringify(result.recordings[i], null, 2)}\n`, "utf8");
      recordingPaths.push(p);
    }
    journal.writeTranscript(result.transcript);

    // Honest outcome (ticket #78): a run that exercised nothing in-scope and
    // non-chrome proved nothing about the named capability — `inconclusive`,
    // never `clean`, whatever the loop's own stop reason was. Mirrors the
    // adversarial mission's `insufficient-coverage` idiom.
    const thin = result.outcome !== "crashed" && result.coverage.inScopeActionsExercised === 0;
    const coverageFailure: MissionFailure | undefined = thin
      ? {
          kind: "insufficient-coverage",
          message: `no in-scope, non-chrome control of "${opts.capability}" was exercised within route(s) [${
            opts.routeGlobs.join(", ") || "(none)"
          }] — ${result.coverage.boundaryEdges.length} boundary edge(s) hit instead`,
        }
      : undefined;
    const missionOutcome: MissionOutcome = combineOutcomes([
      result.outcome === "crashed" ? "crashed" : thin ? "inconclusive" : "clean",
      ...result.hangs.map((h) => hangOutcome(h.reproduction.status)),
    ]);
    const exitCode = missionExitCode(missionOutcome);
    const typed = {
      ...result,
      failure: result.failure ?? coverageFailure,
      missionOutcome,
      exitCode,
      recordingPaths,
      transcriptPath: journal.transcriptPath,
    };
    return { ...typed, resultPath: writeMissionResult(journal.recordingPath, missionOutcome, exitCode, typed) };
  } finally {
    await closeQuietly(session);
  }
}

/** Injectable wiring for the `explore` CLI command (all optional). */
export interface ExploreCliDeps {
  /** Injected issue filer (tests use a fake — nothing real is ever filed from a test). */
  issueFiler?: () => IssueFilerPort;
  /** Injected filing config file path (tests). Default `~/.jevitate/filing.json`. */
  filingConfigPath?: string;
  /** Injected per-target config file path (tests). Default `~/.jevitate/targets.json`. */
  targetsConfigPath?: string;
  /** Injected judgment gateway (tests). */
  judge?: JudgmentPort;
  /** Injected generation gateway (tests). */
  gen?: GenerationPort;
  browserPortFactory?: () => BrowserPort;
  env?: Record<string, string | undefined>;
  localConfig?: Partial<Record<CredentialKey, string>>;
}

/**
 * Compact assertion spec parser (a recording `Assertion`, checked on a page). Supported forms:
 *   urlIncludes:<text>
 *   visible:<descriptor>
 *   textIncludes:<descriptor>|<text>
 *   count:<descriptor>|min=<n>,max=<n>
 *   valueEquals:<descriptor>|<value>   — a form control's VALUE (input, textarea, select), exactly
 * where <descriptor> is `k=v` pairs joined by `;` over testId/role/name/label/text/css, or a CSS
 * selector starting with `[`, `#` or `.` (`[data-testid=x]` is read as `testId=x`). In
 * `textIncludes` / `valueEquals` the LAST `|` separates the descriptor from the text.
 */
export function parseAssertionSpec(spec: string): Assertion {
  const ci = spec.indexOf(":");
  if (ci === -1) throw new Error(`invalid --success spec ${JSON.stringify(spec)}; expected "<kind>:<...>"`);
  const kind = spec.slice(0, ci);
  const rest = spec.slice(ci + 1);

  switch (kind) {
    case "urlIncludes": {
      if (rest === "") throw new Error("urlIncludes requires a text (urlIncludes:/path)");
      return { kind: "urlIncludes", text: rest };
    }
    case "visible":
      return { kind: "visible", target: parseDescriptorSpec(rest) };
    case "textIncludes": {
      const bar = rest.lastIndexOf("|");
      if (bar === -1) throw new Error('textIncludes requires "<descriptor>|<text>"');
      return { kind: "textIncludes", target: parseDescriptorSpec(rest.slice(0, bar)), text: rest.slice(bar + 1) };
    }
    case "valueEquals": {
      const bar = rest.lastIndexOf("|");
      if (bar === -1) throw new Error('valueEquals requires "<descriptor>|<value>"');
      return { kind: "valueEquals", target: parseDescriptorSpec(rest.slice(0, bar)), value: rest.slice(bar + 1) };
    }
    case "count": {
      const bar = rest.indexOf("|");
      const descPart = bar === -1 ? rest : rest.slice(0, bar);
      const bounds = bar === -1 ? "" : rest.slice(bar + 1);
      const target = parseDescriptorSpec(descPart);
      const out: Assertion = { kind: "count", target };
      for (const pair of bounds.split(",")) {
        const [k, v] = pair.split("=");
        if (k === "min" && v) (out as { min?: number }).min = Number(v);
        if (k === "max" && v) (out as { max?: number }).max = Number(v);
      }
      return out;
    }
    default:
      throw new Error(`unsupported assertion kind ${JSON.stringify(kind)}`);
  }
}

const HTTP_METHOD = /^(?:[A-Za-z]+|\*)$/;

/** `<METHOD> <path-glob>` — the request half of a network check. */
function parseRequestSpec(kind: string, text: string): { method: string; pathGlob: string } {
  const sp = text.indexOf(" ");
  const method = sp === -1 ? "" : text.slice(0, sp);
  const pathGlob = sp === -1 ? "" : text.slice(sp + 1).trim();
  if (!HTTP_METHOD.test(method) || !pathGlob.startsWith("/")) {
    throw new Error(`${kind} requires "<METHOD> <path-glob>", e.g. ${kind}:PUT /api/profile/*`);
  }
  return { method: method.toUpperCase(), pathGlob };
}

function parseStatusSpec(text: string): StatusSpec {
  if (/^[1-5]xx$/i.test(text)) return { class: Number(text[0]) as 1 | 2 | 3 | 4 | 5 };
  if (/^[1-5]\d\d$/.test(text)) return { code: Number(text) };
  throw new Error(`responseStatus expects 2xx, 4xx … or a status code, got ${JSON.stringify(text)}`);
}

/**
 * The goal mission's `--success` spec parser (repeatable: every check must hold). Besides every
 * page assertion `parseAssertionSpec` reads:
 *   reloadThen:<assertion>                     — reload the page, then check (persistence)
 *   requestMade:<METHOD> <path-glob>           — the run issued this request
 *   responseStatus:<METHOD> <path-glob>=<2xx|4xx|code> — and it got this status
 * `<path-glob>` uses the route-glob syntax (`*` within a segment, `**` across segments) against
 * the request's path; `*` as METHOD matches any method.
 */
export function parseSuccessSpec(spec: string): SuccessCheck {
  const ci = spec.indexOf(":");
  const kind = ci === -1 ? spec : spec.slice(0, ci);
  const rest = ci === -1 ? "" : spec.slice(ci + 1);
  switch (kind) {
    case "reloadThen":
      if (rest.startsWith("reloadThen:")) throw new Error("reloadThen cannot be nested");
      return { kind: "reloadThen", assertion: parseAssertionSpec(rest) };
    case "requestMade":
      return { kind: "requestMade", ...parseRequestSpec(kind, rest) };
    case "responseStatus": {
      const eq = rest.lastIndexOf("=");
      if (eq === -1) throw new Error('responseStatus requires "<METHOD> <path-glob>=<2xx|4xx|code>"');
      return { kind: "responseStatus", ...parseRequestSpec(kind, rest.slice(0, eq)), status: parseStatusSpec(rest.slice(eq + 1)) };
    }
    default:
      return { kind: "page", assertion: parseAssertionSpec(spec) };
  }
}

function parseDescriptorSpec(s: string): TargetDescriptor {
  const raw = s.trim();
  if (/^[[#.]/.test(raw)) {
    // A CSS selector. The common test-id attribute form becomes a test-id descriptor (the most
    // stable rung); anything else is used as CSS verbatim.
    const testId = /^\[data-testid=(?:"([^"]*)"|'([^']*)'|([^\]"']*))\]$/.exec(raw);
    const id = testId === null ? undefined : (testId[1] ?? testId[2] ?? testId[3]);
    if (id !== undefined && id !== "") return { testId: id };
    return { css: raw };
  }
  const d: TargetDescriptor = {};
  const keys = ["testId", "role", "name", "label", "text", "css"] as const;
  for (const pair of s.split(";")) {
    const eq = pair.indexOf("=");
    if (eq === -1) continue;
    const k = pair.slice(0, eq);
    const v = pair.slice(eq + 1);
    if ((keys as readonly string[]).includes(k) && v !== "") {
      (d as Record<string, string>)[k] = v;
    }
  }
  if (!(d.testId || d.role || d.label || d.text || d.css)) {
    throw new Error(`descriptor spec ${JSON.stringify(s)} has no usable selector`);
  }
  return d;
}

/**
 * The authorized-origins allowlist for a run: explicit `--allow` origins when
 * given, otherwise the target URL's own origin (you asked to explore it). An
 * unparseable URL yields an empty allowlist → the guard fails closed.
 */
export function resolveExploreAllowlist(url: string, allow: readonly string[]): string[] {
  if (allow.length > 0) return [...allow];
  return normalizeAllowlist([url]);
}
