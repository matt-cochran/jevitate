import { chmod, writeFile } from "node:fs/promises";
import { join, resolve as resolvePath } from "node:path";
import type { JudgmentPort, GenerationPort, CredentialKey, UsageTracker, UsageCounts } from "@jevitate/ai-core";
import { PlaywrightBrowserPort, type BrowserLaunchOptions, type BrowserPort } from "@jevitate/playwright";
import { CastActor, BrowseTheWeb } from "@jevitate/screenplay";
import {
  AssertionSchema,
  STYLE_CHANNELS,
  STYLE_PROPERTIES,
  type Assertion,
  type CompareOp,
  type InvariantSpec,
  type Recording,
  type StyleChannel,
  type StyleProperty,
  type TargetDescriptor,
} from "@jevitate/recording";
import type { InvariantDefect, InvariantReport, SafetyConfig, SideEffect } from "@jevitate/explore";
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
  type RunAnswer,
  type RunOutcome,
  type CoverageThresholds,
  type StatusSpec,
  type SuccessCheck,
  type SuccessCheckResult,
  type SuccessWhen,
  type SecretField,
  secretFieldSecrets,
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
import { currentEngineInfo, type EngineInfo } from "./engine.js";
import type { TargetConfig } from "./target-config.js";
import { resolveDataDir } from "./data-dir.js";
import { MissionJournal, artifactStamp, closeQuietly, resultPathFor, writeMissionResult } from "./mission-journal.js";
import { goalExitCode, missionExitCode } from "./mission-exit.js";
import { armMissionKillSwitch } from "./kill-signal.js";
import {
  applyServerLogOutcome,
  openServerLogRuntime,
  type ServerLogDefect,
  type ServerLogRuntimeResult,
  type ServerLogsSummary,
} from "./log-correlation.js";
import type { LogSourceSpec } from "./log-sources.js";
import type { LogDefectMatcher } from "./log-lines.js";
import { fixtureReplayOpener, recordingFixture, type MissionFixtureResult, type MissionFixtures } from "./mission-fixtures.js";
import { observerSessions, persistedActors, type MissionActors } from "./mission-actors.js";

/**
 * Backend log correlation (#142): already-validated `--log-source`/`--log-defect` specs, threaded
 * into every mission-type builder below the same way `invariants` is. `undefined`/empty ⇒ no
 * sources ⇒ `openServerLogRuntime` is a complete no-op (existing runs pay nothing).
 */
export interface ServerLogOptions {
  readonly sources: readonly LogSourceSpec[];
  readonly logDefect: readonly LogDefectMatcher[];
  readonly allowLogCmd?: boolean;
  readonly drainMs?: number;
}

export function serverLogResult(runtimeResult: { summary: ServerLogsSummary; defects: ServerLogDefect[] } | undefined): {
  serverLogs?: ServerLogsSummary;
  serverLogDefects?: ServerLogDefect[];
} {
  if (runtimeResult === undefined) return {};
  return { serverLogs: runtimeResult.summary, ...(runtimeResult.defects.length > 0 ? { serverLogDefects: runtimeResult.defects } : {}) };
}

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
  /**
   * When the page checks must hold (`--success-when`, #80): `final` (default) — on the final page;
   * `held` — on the final page or together at any settled step. `reloadThen` is final-only.
   */
  readonly successWhen?: SuccessWhen;
  readonly allowlist: readonly string[];
  readonly judge: JudgmentPort;
  readonly gen: GenerationPort;
  /**
   * Usage accounting (#100): when supplied, its snapshot (judgments/generations/tokens/`usd`) lands
   * in the result as `usage`. The CLI builds one per invocation and hands it to the gateways
   * `judge`/`gen` were constructed with, so the counts here are exactly what this run made.
   */
  readonly usage?: UsageTracker;
  readonly bounds?: Partial<Bounds>;
  readonly secrets?: readonly string[];
  /**
   * Secret field bindings (CLI `--secret-field` / `--totp`, resolved from the environment): typed
   * by code, never by the model; each value/seed is also a run secret (redacted everywhere).
   */
  readonly secretFields?: readonly SecretField[];
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
  /**
   * Writes the browser context's storageState (cookies + origin storage) here when the run ends
   * (CLI `--save-storage-state`) — so a rotating refresh token stays usable across runs instead of
   * invalidating `--storage-state`'s file on first use. The file holds live session credentials:
   * written with mode 0600, and its contents are never logged.
   */
  readonly saveStorageState?: string;
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
  /** App-declared invariants (`--invariants`, #86), already validated against the allowlist. */
  readonly invariants?: InvariantSpec;
  /** Backend log sources (`--log-source`/`--log-defect`, #142), already validated. */
  readonly serverLog?: ServerLogOptions;
  /** Resolved `authFrom.secret` refs (#135) a declared probe may use: `env:VAR` → its value. */
  readonly invariantAuthTokens?: ReadonlyMap<string, string>;
  /**
   * Mission fixtures (#140/#144), ALREADY set up by the caller: every hang replay re-runs
   * restore+setup first, the state is restored when the mission ends (the caller also restores on
   * every exit path — idempotent), and the result/Recording carry the identity.
   */
  readonly fixtures?: MissionFixtures;
  /**
   * #147: the mission's actors (`--actor`). The primary's storageState seeds the mission session
   * (it must equal `storageState` when both are given); each observer gets its own fresh context,
   * opened only when a declared cross-actor check needs it, never driven by the model.
   */
  readonly actors?: MissionActors;
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
  engine: EngineInfo,
): DraftContext {
  return {
    environment: currentEnvironment(origin, {
      jevitateVersion: readCliVersion(),
      commit: engine.commit,
      builtAt: engine.builtAt,
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

/**
 * Writes the browser context's live storageState (cookies + origin storage) to `file` when the
 * caller asked for one (CLI `--save-storage-state`, #82) — so a rotating refresh token stays usable
 * across runs instead of the `--storage-state` file it started from going stale on first use. The
 * file holds live session credentials: written with mode 0600 (owner read/write only), and its
 * contents are never logged. A no-op when `file` is undefined.
 */
async function persistStorageState(
  session: { saveStorageState(file: string): Promise<void> },
  file: string | undefined,
): Promise<void> {
  if (file === undefined) return;
  await session.saveStorageState(file);
  await chmod(file, 0o600);
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
  /** The writes the run's actions fired (#116), marked when the control was paid / destructive. */
  readonly sideEffects: SideEffect[];
  readonly sideEffectsTruncated?: number;
  /**
   * Did the loop complete its goal (`completed`, verified by the success assertion), or why not
   * (`incomplete` + reason)? `outcome` above is the mission verdict; this is the run's own account.
   */
  readonly runOutcome: RunOutcome;
  /** A find-out goal's answer (#101), present only when code grounded it on the observed pages. */
  readonly answer?: RunAnswer;
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
  /** Which build produced this result (issue #83): `{version, commit, builtAt}`. */
  readonly engine: EngineInfo;
  /** Declared-invariant defects (#86) — present when `--invariants` was given; `verify-fix` replays them. */
  readonly defects?: InvariantDefect[];
  /** Per declared invariant: applied / held / violated / unreadable counts. */
  readonly invariants?: InvariantReport[];
  /** The declared spec the run evaluated — persisted so `verify-fix` re-checks the SAME invariants. */
  readonly invariantSpec?: InvariantSpec;
  /** Judgment/generation call counts and tokens for this run (#100); present only when `opts.usage` was supplied. */
  readonly usage?: UsageCounts;
  /** Backend log correlation summary (#142) — present only when `--log-source` was given. */
  readonly serverLogs?: ServerLogsSummary;
  /** `server-log` defects (#142, `--log-defect`); `verify-fix` re-checks them by re-tailing the same sources. */
  readonly serverLogDefects?: ServerLogDefect[];
  /** The fixture the mission started from (#140/#144): identity, non-secret outputs, the setup/restore log. */
  readonly fixtures?: MissionFixtureResult;
}

/** Outcomes that already mean the run itself broke or hung — a server-log finding never downgrades
 *  (or, for the oracle-unreadable case, elevates) one of these; they already prove more, or the same. */
const BROKEN_GOAL_OUTCOMES: ReadonlySet<GoalBasedOutcome> = new Set(["inconclusive", "crashed", "hang", "intermittent"]);

/**
 * Folds a server-log correlation result into the goal mission's own `GoalBasedOutcome` (#142): a
 * found `server-log` defect makes an otherwise-not-broken run `defects-found`; an unreadable
 * `--log-defect` oracle turns an otherwise-`succeeded` run `inconclusive` — mirrors
 * `applyServerLogOutcome` (the `MissionOutcome` version the other three builders use), but
 * `GoalBasedOutcome` has its own extra values (`succeeded`/`exhausted`/`blocked`).
 */
function applyServerLogGoalOutcome(outcome: GoalBasedOutcome, run: ServerLogRuntimeResult | undefined): GoalBasedOutcome {
  if (run === undefined) return outcome;
  if (run.defects.length > 0 && !BROKEN_GOAL_OUTCOMES.has(outcome)) return "defects-found";
  if (!run.summary.oracleOk && outcome === "succeeded") return "inconclusive";
  return outcome;
}

/** One-line reason for a server-log-driven outcome change (`reason` is unset otherwise for `succeeded`). */
function serverLogOutcomeReason(newOutcome: GoalBasedOutcome | MissionOutcome, run: ServerLogRuntimeResult | undefined): string {
  if (newOutcome === "defects-found") {
    const n = run?.defects.length ?? 0;
    return `${n} server-log defect${n === 1 ? "" : "s"} found (--log-defect)`;
  }
  return "the --log-defect oracle could not run: every declared --log-source failed to open or read a line — an absence of server-log defects proves nothing";
}

export async function runExploration(opts: RunExplorationOptions): Promise<RunExplorationResult> {
  // Guardrail #1 — authorize BEFORE opening a browser. Throws on refusal.
  const origin = assertAuthorizedExploreTarget(opts.url, opts.allowlist);
  // Fail fast on a missing fixture BEFORE launching Chromium.
  const fixture = opts.fixture === undefined ? undefined : await resolveMissionFixture(opts.fixture);
  // A bound secret (or TOTP seed) is a run secret too: kept out of the issue drafts as well. So is a
  // declared probe's resolved auth token (#135) — redacted everywhere a run secret is, not only in
  // the invariant monitor's own evidence.
  const authTokenValues = [...(opts.invariantAuthTokens?.values() ?? [])];
  const bound = [...secretFieldSecrets(opts.secretFields), ...(opts.fixtures?.secrets() ?? []), ...authTokenValues];
  const secrets = opts.secrets === undefined && bound.length === 0 ? undefined : [...(opts.secrets ?? []), ...bound];
  // The state the mission starts from — replays restore THIS fixture and rebind its recorded outputs.
  const fx = opts.fixtures;
  const missionFixture = fx === undefined ? undefined : { record: fx.record(), persisted: fx.persisted() };

  if (opts.actors !== undefined && opts.storageState !== undefined && resolvePath(opts.storageState) !== opts.actors.primary.storageState) {
    throw new Error("runExploration: storageState must be the primary actor's own");
  }
  const primaryState = opts.actors?.primary.storageState ?? opts.storageState;
  const portFactory = opts.browserPortFactory ?? (() => new PlaywrightBrowserPort());
  const port = portFactory();
  const launch = {
    headless: true,
    allowedOrigins: [...opts.allowlist],
    baseUrl: origin,
    ...opts.browser,
    ...(primaryState !== undefined ? { storageState: primaryState } : {}),
  };
  const session = await port.open(launch);
  // #147: each observer in its OWN fresh context (only its own storageState), opened on first use.
  const observers =
    opts.actors === undefined || opts.actors.observers.length === 0
      ? undefined
      : observerSessions(portFactory, { headless: true, allowedOrigins: [...opts.allowlist], baseUrl: origin, ...opts.browser }, opts.actors.observers);

  const outDir = opts.outDir ?? resolveDataDir(["recordings"]);
  const iso = (opts.nowIso ?? (() => new Date().toISOString()))();
  // Crash-safe: the transcript and partial Recording are flushed after every step. `MissionJournal`
  // itself creates `outDir` synchronously (mkdirSync) — no `await` here, so there is no gap between
  // the browser opening and the kill switch arming below for a SIGTERM/SIGINT to land in unarmed.
  const journal = new MissionJournal(join(outDir, `explore-${artifactStamp(iso)}.json`));
  // Crash-safe on SIGTERM/SIGINT too (#94): a partial `inconclusive` result is written from
  // whatever the journal has already flushed, and the process exits with the conventional code.
  const disarmKillSwitch = armMissionKillSwitch({
    recordingPath: journal.recordingPath,
    transcriptPath: journal.transcriptPath,
    transcript: () => journal.transcript,
    ...(opts.usage === undefined ? {} : { usage: opts.usage }),
  });
  // Backend log correlation (#142): opened BEFORE the mission runs so its window covers the seed
  // load too; a no-op (`undefined`) when `--log-source` was not given.
  const serverLog = openServerLogRuntime({
    sources: opts.serverLog?.sources ?? [],
    logDefect: opts.serverLog?.logDefect ?? [],
    ...(opts.serverLog?.drainMs === undefined ? {} : { drainMs: opts.serverLog.drainMs }),
    secrets: secrets ?? [],
    onTranscriptEntry: journal.onTranscriptEntry,
  });
  try {
    const actor = CastActor.named("explorer").whoCan(new BrowseTheWeb(session, [...opts.allowlist]));
    const mission = await runGoalBasedMission({
      ...(opts.target?.timing === undefined ? {} : { timingConfig: opts.target.timing }),
      ...(opts.target?.settle === undefined ? {} : { settle: opts.target.settle }),
      ...(opts.target?.hangs === undefined ? {} : { hangs: opts.target.hangs }),
      ...(opts.target?.safety === undefined ? {} : { safety: opts.target.safety }),
      // A hang is reproduced by replaying its steps in fresh contexts (same auth, same fixture state).
      openFreshSession:
        fx === undefined || missionFixture === undefined
          ? freshSessionOpener(portFactory, launch, opts.allowlist)
          : fixtureReplayOpener(freshSessionOpener(portFactory, launch, opts.allowlist), fx, missionFixture.record.outputs),
      ...(opts.hangReplays === undefined ? {} : { hangReplays: opts.hangReplays }),
      onTranscriptEntry: serverLog?.onTranscriptEntry ?? journal.onTranscriptEntry,
      onRecording: journal.onRecording,
      actor,
      judge: opts.judge,
      gen: opts.gen,
      goal: opts.goal,
      allowlist: opts.allowlist,
      startUrl: opts.url,
      ...(opts.successAssertion === undefined ? {} : { successAssertion: opts.successAssertion }),
      ...(opts.successChecks === undefined ? {} : { successChecks: opts.successChecks }),
      ...(opts.successWhen === undefined ? {} : { successWhen: opts.successWhen }),
      bounds: opts.bounds,
      secrets,
      ...(opts.secretFields === undefined ? {} : { secretFields: opts.secretFields }),
      site: origin,
      fixture,
      ...conversationConfig(opts.conversation),
      ...(opts.invariants === undefined ? {} : { invariants: opts.invariants }),
      ...(opts.invariantAuthTokens === undefined ? {} : { invariantAuthTokens: opts.invariantAuthTokens }),
      ...(observers === undefined ? {} : { observers }),
      ...(opts.actors === undefined ? {} : { primaryActor: opts.actors.primary.name }),
    });
    await observers?.close();

    // The mission (and its hang replays) is done: restore now, so the persisted log includes it. The
    // caller restores again on every exit path (a no-op once restored).
    await fx?.restore();
    const recording: Recording =
      missionFixture === undefined ? mission.recording : { ...mission.recording, fixture: recordingFixture(missionFixture.record) };
    // Never blocks the mission itself: the drain wait happens AFTER `runGoalBasedMission` returned.
    const serverLogRun = serverLog === undefined ? undefined : await serverLog.finish(mission.transcript);
    // #142 follow-up: a found server-log defect counts as `defects-found` (exit 1); an unreadable
    // `--log-defect` oracle turns an otherwise-`succeeded` run `inconclusive` (exit 2) — never clean.
    const goalOutcome = applyServerLogGoalOutcome(mission.outcome, serverLogRun);
    journal.writeRecording(recording);
    journal.writeTranscript(serverLogRun?.transcript ?? mission.transcript);
    const engine = currentEngineInfo();
    const ctx = draftContext(origin, journal, secrets ?? [], browserVersionOf(session.page), engine);
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
      outcome: goalOutcome,
      runOutcome: mission.run.outcome,
      ...(mission.run.answer === undefined ? {} : { answer: mission.run.answer }),
      assertionPassed: mission.assertionPassed,
      checks: mission.checks,
      stop: mission.run.stop,
      finalUrl: mission.finalUrl,
      decisions: mission.run.decisions,
      actions: mission.run.actions,
      recordingPath: journal.recordingPath,
      transcriptPath: journal.transcriptPath,
      transcript: serverLogRun?.transcript ?? mission.transcript,
      exitCode: goalExitCode(goalOutcome),
      resultPath,
      target: {
        seedUrl: opts.url,
        allowlist: [...opts.allowlist],
        ...(primaryState !== undefined ? { storageStatePath: resolvePath(primaryState) } : {}),
        ...(opts.actors === undefined ? {} : { actors: persistedActors(opts.actors) }),
      },
      recording,
      hangs: mission.hang === undefined ? [] : [mission.hang],
      sideEffects: mission.run.sideEffects,
      ...(mission.run.sideEffectsTruncated === undefined ? {} : { sideEffectsTruncated: mission.run.sideEffectsTruncated }),
      engine,
      ...(fx === undefined || missionFixture === undefined
        ? {}
        : {
            fixtures: {
              ...missionFixture.record,
              cycles: fx.record().cycles,
              log: fx.record().log,
              ...(missionFixture.persisted.spec === undefined ? {} : { spec: missionFixture.persisted.spec }),
              ...(missionFixture.persisted.hooks === undefined ? {} : { hooks: missionFixture.persisted.hooks }),
            },
          }),
      ...(mission.run.failure === undefined ? {} : { failure: mission.run.failure }),
      ...(goalOutcome === mission.outcome
        ? mission.reason === undefined
          ? {}
          : { reason: mission.reason }
        : { reason: serverLogOutcomeReason(goalOutcome, serverLogRun) }),
      ...declaredResult(opts.invariants, mission.invariantDefects, mission.invariants),
      ...(opts.usage === undefined ? {} : { usage: opts.usage.snapshot() }),
      ...serverLogResult(serverLogRun),
    };
    // Persisted so `verify-fix` can replay a hang later (the typed result next to the Recording).
    writeMissionResult(journal.recordingPath, goalOutcome, result.exitCode, result);
    return result;
  } finally {
    disarmKillSwitch();
    // Safety net: if the mission threw before `serverLog.finish()` ran, close sources immediately
    // (no drain wait) rather than leaving them open until process exit.
    await serverLog?.abort();
    await observers?.close().catch(() => undefined);
    await persistStorageState(session, opts.saveStorageState);
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
  /** Usage accounting (#100): see `RunExplorationOptions.usage`. */
  readonly usage?: UsageTracker;
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
  /**
   * Writes the browser context's storageState (cookies + origin storage) here when the run ends
   * (CLI `--save-storage-state`) — so a rotating refresh token stays usable across runs instead of
   * invalidating `--storage-state`'s file on first use. The file holds live session credentials:
   * written with mode 0600, and its contents are never logged.
   */
  readonly saveStorageState?: string;
  readonly nowIso?: () => string;
  /** The target's settle/hang configuration (`~/.jevitate/targets.json` + flags). */
  readonly target?: TargetConfig;
  /**
   * Extra in-scope route globs (CLI `--route`, #89 — reuses #64's adversarial/feature scope model).
   * The seed URL's own route is always in scope; these add to it. Pass `["/**"]` (CLI `--scope app`)
   * to widen containment to the whole app.
   */
  readonly routeGlobs?: readonly string[];
  /** App-declared invariants (`--invariants`, #86), already validated against the allowlist. */
  readonly invariants?: InvariantSpec;
  /** Backend log sources (`--log-source`/`--log-defect`, #142), already validated. */
  readonly serverLog?: ServerLogOptions;
  /** Resolved `authFrom.secret` refs (#135) a declared probe may use: `env:VAR` → its value. */
  readonly invariantAuthTokens?: ReadonlyMap<string, string>;
  /**
   * `coverage` (default): the exhaustive breadth sweep. `exploratory`: novelty-seeking — the control
   * the last action revealed is tried first (#115).
   */
  readonly strategy?: "coverage" | "exploratory";
  /** No-progress watchdog (CLI `--stall-timeout`, #114): ends the run `stalled` (inconclusive). Default 120s. */
  readonly stallTimeoutMs?: number;
}

export interface RunCoverageMissionResult {
  readonly coverage: CoverageReport;
  readonly outcome: "exhausted" | "cap" | "crashed" | "hang" | "scope-unreachable" | "stalled";
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
  /** The writes the frontier's actions fired (#116), marked when the control was paid / destructive. */
  readonly sideEffects: SideEffect[];
  readonly sideEffectsTruncated?: number;
  /** Which build produced this result (issue #83): `{version, commit, builtAt}`. */
  readonly engine: EngineInfo;
  /** Declared-invariant defects (#86), each with its own path Recording — present with `--invariants`. */
  readonly defects?: InvariantDefect[];
  readonly invariants?: InvariantReport[];
  readonly invariantSpec?: InvariantSpec;
  /** Judgment/generation call counts and tokens for this run (#100); present only when `opts.usage` was supplied. */
  readonly usage?: UsageCounts;
  /** Backend log correlation summary (#142) — present only when `--log-source` was given. */
  readonly serverLogs?: ServerLogsSummary;
  /** `server-log` defects (#142, `--log-defect`); `verify-fix` re-checks them by re-tailing the same sources. */
  readonly serverLogDefects?: ServerLogDefect[];
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
  const iso = (opts.nowIso ?? (() => new Date().toISOString()))();
  const stamp = artifactStamp(iso);
  // `MissionJournal` creates `outDir` synchronously (mkdirSync) — no `await` between the browser
  // opening and the kill switch arming below, so there is no gap for a signal to land in unarmed.
  const journal = new MissionJournal(join(outDir, `coverage-${stamp}.json`));
  const disarmKillSwitch = armMissionKillSwitch({
    recordingPath: journal.recordingPath,
    transcriptPath: journal.transcriptPath,
    transcript: () => journal.transcript,
    ...(opts.usage === undefined ? {} : { usage: opts.usage }),
  });
  const serverLog = openServerLogRuntime({
    sources: opts.serverLog?.sources ?? [],
    logDefect: opts.serverLog?.logDefect ?? [],
    ...(opts.serverLog?.drainMs === undefined ? {} : { drainMs: opts.serverLog.drainMs }),
    secrets: [],
    onTranscriptEntry: journal.onTranscriptEntry,
  });
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
      onTranscriptEntry: serverLog?.onTranscriptEntry ?? journal.onTranscriptEntry,
      ...(opts.routeGlobs === undefined ? {} : { routeGlobs: opts.routeGlobs }),
      ...(opts.invariants === undefined ? {} : { invariants: opts.invariants }),
      ...(opts.invariantAuthTokens === undefined ? {} : { invariantAuthTokens: opts.invariantAuthTokens }),
      ...(opts.strategy === undefined ? {} : { strategy: opts.strategy }),
      ...(opts.stallTimeoutMs === undefined ? {} : { stallTimeoutMs: opts.stallTimeoutMs }),
      ...(opts.target?.safety === undefined ? {} : { safety: opts.target.safety }),
    });

    const serverLogRun = serverLog === undefined ? undefined : await serverLog.finish(result.transcript);
    const recordingPaths: string[] = [];
    for (let i = 0; i < result.recordings.length; i++) {
      const p = join(outDir, `coverage-${stamp}-state-${i}.json`);
      await writeFile(p, `${JSON.stringify(result.recordings[i], null, 2)}\n`, "utf8");
      recordingPaths.push(p);
    }
    journal.writeTranscript(serverLogRun?.transcript ?? result.transcript);
    // A silent run that never proved anything (the seed redirected off-target, or the frontier
    // spent its budget on controls that failed rather than exercising the target) is `inconclusive`,
    // never `clean` — mirrors the adversarial mission's coverage-sufficiency check (#69, #75, #82).
    // A declared-invariant violation (#86) is a hard defect, whatever the coverage.
    const found = result.coverage.defects.length + (result.invariantDefects?.length ?? 0);
    // Could not return to the seed, or stalled (#114): the run stopped short of its target — inconclusive.
    const bare =
      result.outcome === "crashed"
        ? "crashed"
        : result.outcome === "scope-unreachable" || result.outcome === "stalled"
          ? "inconclusive"
          : null;
    const thin = bare === null && found === 0 && !result.coverage.sufficiency.sufficient;
    const preLogOutcome: MissionOutcome = combineOutcomes([
      bare ?? (thin ? "inconclusive" : found > 0 ? "defects-found" : "clean"),
      ...result.hangs.map((h) => hangOutcome(h.reproduction.status)),
    ]);
    // #142 follow-up: a server-log defect counts as `defects-found`; an unreadable `--log-defect`
    // oracle turns an otherwise-`clean` run `inconclusive` — never a false clean.
    const missionOutcome = applyServerLogOutcome(preLogOutcome, serverLogRun);
    const coverageFailure: MissionFailure | undefined = thin
      ? { kind: "insufficient-coverage", message: `coverage below thresholds: ${result.coverage.sufficiency.shortfalls.join("; ")}` }
      : undefined;
    const failure = result.failure ?? coverageFailure;

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
      ...(failure === undefined ? {} : { failure }),
      recordingPaths,
      transcriptPath: journal.transcriptPath,
      sideEffects: result.sideEffects ?? [],
      ...(result.sideEffectsTruncated === undefined ? {} : { sideEffectsTruncated: result.sideEffectsTruncated }),
      engine: currentEngineInfo(),
      ...declaredResult(opts.invariants, result.invariantDefects, result.invariants),
      ...(opts.usage === undefined ? {} : { usage: opts.usage.snapshot() }),
      ...serverLogResult(serverLogRun),
    };
    return { ...typed, resultPath: writeMissionResult(journal.recordingPath, missionOutcome, exitCode, typed) };
  } finally {
    disarmKillSwitch();
    await serverLog?.abort();
    await persistStorageState(session, opts.saveStorageState);
    await closeQuietly(session);
  }
}

/**
 * The misuse strategies `explore --strategy adversarial` runs, in order — shared with the queue drain
 * (`jevitate mission run`, #117) so a queued adversarial mission hunts exactly like the CLI's.
 */
export const CLI_ADVERSARIAL_STRATEGIES: readonly MisuseStrategy[] = [
  // Form-aware misuse around submitting (#64): most app pages are forms.
  "double-submit",
  "boundary-submit",
  "edit-cancel-save",
  "navigate-away-unsaved",
  "act-while-pending",
  // Coverage: act on every target control once.
  "exercise-controls",
  "ordering-violation",
  "repeat-rapid",
  "boundary-input",
  "contradictory-actions",
  "nav-during-pending",
  // Keep hunting on other routes (within the target's scope) after and between defects.
  "visit-route",
];

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
  /** Usage accounting (#100): see `RunExplorationOptions.usage`. */
  readonly usage?: UsageTracker;
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
  /**
   * Writes the browser context's storageState (cookies + origin storage) here when the run ends
   * (CLI `--save-storage-state`) — so a rotating refresh token stays usable across runs instead of
   * invalidating `--storage-state`'s file on first use. The file holds live session credentials:
   * written with mode 0600, and its contents are never logged.
   */
  readonly saveStorageState?: string;
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
  /** App-declared invariants (`--invariants`, #86), already validated against the allowlist. */
  readonly invariants?: InvariantSpec;
  /** Backend log sources (`--log-source`/`--log-defect`, #142), already validated. */
  readonly serverLog?: ServerLogOptions;
  /** Resolved `authFrom.secret` refs (#135) a declared probe may use: `env:VAR` → its value. */
  readonly invariantAuthTokens?: ReadonlyMap<string, string>;
}

/** The adversarial outcome plus where its Recording and decision transcript were written. */
/** Where a mission ran — enough for `verify-fix` to replay one of its defects in a fresh session. */
export interface MissionTarget {
  readonly seedUrl: string;
  readonly allowlist: string[];
  /** Absolute path of the storageState file the run started from (never its contents). */
  readonly storageStatePath?: string;
  /** #147: every actor's name, role and storageState PATH (never its contents) — for verify-fix. */
  readonly actors?: ReadonlyArray<{ readonly name: string; readonly storageStatePath: string; readonly role: "primary" | "observer" }>;
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
  /** Which build produced this result (issue #83): `{version, commit, builtAt}`. */
  readonly engine: EngineInfo;
  /** The declared spec the run evaluated (#86) — persisted so `verify-fix` re-checks the same one. */
  readonly invariantSpec?: InvariantSpec;
  /** Judgment/generation call counts and tokens for this run (#100); present only when `opts.usage` was supplied. */
  readonly usage?: UsageCounts;
  /** Backend log correlation summary (#142) — present only when `--log-source` was given. */
  readonly serverLogs?: ServerLogsSummary;
  /** `server-log` defects (#142, `--log-defect`); `verify-fix` re-checks them by re-tailing the same sources. */
  readonly serverLogDefects?: ServerLogDefect[];
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
  const disarmKillSwitch = armMissionKillSwitch({
    recordingPath: journal.recordingPath,
    transcriptPath: journal.transcriptPath,
    transcript: () => journal.transcript,
    ...(opts.usage === undefined ? {} : { usage: opts.usage }),
  });
  const serverLog = openServerLogRuntime({
    sources: opts.serverLog?.sources ?? [],
    logDefect: opts.serverLog?.logDefect ?? [],
    ...(opts.serverLog?.drainMs === undefined ? {} : { drainMs: opts.serverLog.drainMs }),
    secrets: opts.secrets ?? [],
    onTranscriptEntry: journal.onTranscriptEntry,
  });
  try {
    const actor = CastActor.named("adversarial-mission").whoCan(new BrowseTheWeb(session, [...opts.allowlist]));
    const outcome = await runAdversarialMission({
      ...(opts.target?.timing === undefined ? {} : { timingConfig: opts.target.timing }),
      ...(opts.target?.settle === undefined ? {} : { settle: opts.target.settle }),
      ...(opts.target?.hangs === undefined ? {} : { hangs: opts.target.hangs }),
      ...(opts.target?.safety === undefined ? {} : { safety: opts.target.safety }),
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
      onTranscriptEntry: serverLog?.onTranscriptEntry ?? journal.onTranscriptEntry,
      onRecording: journal.onRecording,
      ...(opts.invariants === undefined ? {} : { invariants: opts.invariants }),
      ...(opts.invariantAuthTokens === undefined ? {} : { invariantAuthTokens: opts.invariantAuthTokens }),
    });
    const serverLogRun = serverLog === undefined ? undefined : await serverLog.finish(outcome.transcript);
    // `AdversarialOutcome.transcript` is a mutable `TranscriptEntry[]`; the correlated array only
    // ADDS an optional `serverLogs` field per entry (`TranscriptEntryWithLogs extends TranscriptEntry`).
    const transcript = (serverLogRun?.transcript ?? outcome.transcript) as TranscriptEntry[];
    journal.writeRecording(outcome.recording);
    journal.writeTranscript(transcript);
    // #142 follow-up: a server-log defect counts as `defects-found`; an unreadable `--log-defect`
    // oracle turns an otherwise-`clean` run `inconclusive` — never a false clean.
    const missionOutcome = applyServerLogOutcome(outcome.outcome, serverLogRun);
    const exitCode = missionExitCode(missionOutcome);
    const resultPath = resultPathFor(journal.recordingPath);
    const engine = currentEngineInfo();
    const ctx = draftContext(origin, journal, opts.secrets ?? [], browserVersionOf(session.page), engine);
    const drafts: IssueDraft[] = outcome.defects.map((d) =>
      draftForDefect(d, { ...ctx, verifyCommand: `jevitate verify-fix --result ${resultPath} --fingerprint ${d.fingerprint}` }),
    );
    for (const h of outcome.hangs) {
      drafts.push(draftForHang(h, { ...ctx, verifyCommand: `jevitate verify-fix --result ${resultPath} --fingerprint ${h.fingerprint}` }));
    }
    if (outcome.crash !== undefined) drafts.push(draftForCrash(outcome.crash, transcript, ctx));
    const issues = await processIssueDrafts(
      journal.recordingPath,
      drafts,
      opts.filing ?? DRAFTS_ONLY,
      opts.issueFiler ?? NO_FILER,
      iso,
    );
    const result = {
      ...outcome,
      outcome: missionOutcome,
      transcript,
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
      engine,
      ...(opts.invariants === undefined ? {} : { invariantSpec: opts.invariants }),
      ...(opts.usage === undefined ? {} : { usage: opts.usage.snapshot() }),
      ...serverLogResult(serverLogRun),
    };
    return { ...result, resultPath: writeMissionResult(journal.recordingPath, missionOutcome, exitCode, result) };
  } finally {
    disarmKillSwitch();
    await serverLog?.abort();
    await persistStorageState(session, opts.saveStorageState);
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
  /** No-progress watchdog (CLI `--stall-timeout`, #114): ends the run `stalled` (inconclusive). Default 120s. */
  readonly stallTimeoutMs?: number;
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
  /**
   * Writes the browser context's storageState (cookies + origin storage) here when the run ends
   * (CLI `--save-storage-state`) — so a rotating refresh token stays usable across runs instead of
   * invalidating `--storage-state`'s file on first use. The file holds live session credentials:
   * written with mode 0600, and its contents are never logged.
   */
  readonly saveStorageState?: string;
  /** App-declared invariants (`--invariants`, #86), already validated against the allowlist. */
  readonly invariants?: InvariantSpec;
  /** Backend log sources (`--log-source`/`--log-defect`, #142), already validated. */
  readonly serverLog?: ServerLogOptions;
  /** Resolved `authFrom.secret` refs (#135) a declared probe may use: `env:VAR` → its value. */
  readonly invariantAuthTokens?: ReadonlyMap<string, string>;
  /** The shared safety policy (#116: `--deny`, `--allow-destructive`, `--read-rpc`). */
  readonly safety?: SafetyConfig;
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
  /** Which build produced this result (issue #83): `{version, commit, builtAt}`. */
  readonly engine: EngineInfo;
  /** One Recording per distinct discovered path (`feature-<stamp>-path-<n>.json`). */
  readonly recordingPaths: string[];
  /** The shared decision transcript (`feature-<stamp>.transcript.json`). */
  readonly transcriptPath: string;
  /** The persisted typed result (`feature-<stamp>.result.json`), readable via MCP `get_mission_result`. */
  readonly resultPath: string;
  /** Where the run happened — what `verify-fix` needs to replay a declared-invariant defect. */
  readonly target: MissionTarget;
  /** Declared-invariant defects (#86), each with its own path Recording — present with `--invariants`. */
  readonly defects?: InvariantDefect[];
  readonly invariantSpec?: InvariantSpec;
  /** Backend log correlation summary (#142) — present only when `--log-source` was given. */
  readonly serverLogs?: ServerLogsSummary;
  /** `server-log` defects (#142, `--log-defect`); `verify-fix` re-checks them by re-tailing the same sources. */
  readonly serverLogDefects?: ServerLogDefect[];
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
  const disarmKillSwitch = armMissionKillSwitch({
    recordingPath: journal.recordingPath,
    transcriptPath: journal.transcriptPath,
    transcript: () => journal.transcript,
  });
  const serverLog = openServerLogRuntime({
    sources: opts.serverLog?.sources ?? [],
    logDefect: opts.serverLog?.logDefect ?? [],
    ...(opts.serverLog?.drainMs === undefined ? {} : { drainMs: opts.serverLog.drainMs }),
    secrets: [],
    onTranscriptEntry: journal.onTranscriptEntry,
  });
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
      onTranscriptEntry: serverLog?.onTranscriptEntry ?? journal.onTranscriptEntry,
      ...(opts.invariants === undefined ? {} : { invariants: opts.invariants }),
      ...(opts.invariantAuthTokens === undefined ? {} : { invariantAuthTokens: opts.invariantAuthTokens }),
      ...(opts.stallTimeoutMs === undefined ? {} : { stallTimeoutMs: opts.stallTimeoutMs }),
      ...(opts.safety === undefined ? {} : { safety: opts.safety }),
    });

    const serverLogRun = serverLog === undefined ? undefined : await serverLog.finish(result.transcript);
    const recordingPaths: string[] = [];
    for (let i = 0; i < result.recordings.length; i++) {
      const p = join(outDir, `feature-${stamp}-path-${i}.json`);
      await writeFile(p, `${JSON.stringify(result.recordings[i], null, 2)}\n`, "utf8");
      recordingPaths.push(p);
    }
    journal.writeTranscript(serverLogRun?.transcript ?? result.transcript);

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
    // A declared-invariant violation (#86) is a hard defect even on a thin run: it was observed.
    const invariantDefects = result.invariantDefects?.length ?? 0;
    const preLogOutcome: MissionOutcome = combineOutcomes([
      result.outcome === "crashed"
        ? "crashed"
        : result.outcome === "scope-unreachable" || result.outcome === "stalled"
          ? "inconclusive"
          : invariantDefects > 0
            ? "defects-found"
            : thin
              ? "inconclusive"
              : "clean",
      ...result.hangs.map((h) => hangOutcome(h.reproduction.status)),
    ]);
    // #142 follow-up: a server-log defect counts as `defects-found`; an unreadable `--log-defect`
    // oracle turns an otherwise-`clean` run `inconclusive` — never a false clean.
    const missionOutcome = applyServerLogOutcome(preLogOutcome, serverLogRun);
    const exitCode = missionExitCode(missionOutcome);
    const typed = {
      ...result,
      transcript: (serverLogRun?.transcript ?? result.transcript) as TranscriptEntry[],
      failure: result.failure ?? coverageFailure,
      missionOutcome,
      exitCode,
      recordingPaths,
      transcriptPath: journal.transcriptPath,
      engine: currentEngineInfo(),
      target: {
        seedUrl: opts.seedUrl,
        allowlist: [...opts.allowlist],
        ...(opts.storageState !== undefined ? { storageStatePath: resolvePath(opts.storageState) } : {}),
      },
      ...declaredResult(opts.invariants, result.invariantDefects, result.invariants),
      ...serverLogResult(serverLogRun),
    };
    return { ...typed, resultPath: writeMissionResult(journal.recordingPath, missionOutcome, exitCode, typed) };
  } finally {
    disarmKillSwitch();
    await serverLog?.abort();
    await persistStorageState(session, opts.saveStorageState);
    await closeQuietly(session);
  }
}

/**
 * The declared-invariant fields of a persisted result (#86): the defects (top-level `defects`, where
 * `verify-fix` looks), the per-invariant report, and the spec itself so a later `verify-fix`
 * re-checks exactly what the run checked. Nothing at all when the run had no `--invariants`.
 */
function declaredResult(
  spec: InvariantSpec | undefined,
  defects: readonly InvariantDefect[] | undefined,
  report: readonly InvariantReport[] | undefined,
): { defects?: InvariantDefect[]; invariants?: InvariantReport[]; invariantSpec?: InvariantSpec } {
  if (spec === undefined) return {};
  return { defects: [...(defects ?? [])], invariants: [...(report ?? [])], invariantSpec: spec };
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
 *   textIncludes:<descriptor>|<text>  — case-insensitive (#113): matches regardless of case, or of a
 *                                        CSS text-transform (a badge whose DOM text is "Approved" but
 *                                        renders `uppercase` still matches `|Approved`)
 *   count:<descriptor>|min=<n>,max=<n>
 *   valueEquals:<descriptor>|<value>   — a form control's VALUE (input, textarea, select), exactly
 * and the visual-state kinds (#148), decided by code from fixed page reads:
 *   style:<descriptor>|<prop><op><value>   — the COMPUTED style of EVERY match (at least one);
 *                                        <prop> is an allowlisted CSS property, optionally one
 *                                        channel of it: alpha(background-color)>0, px(outline-width)>=2;
 *                                        <op> is = != > >= < <= (= compares colors as colors).
 *                                        `styleMatches:` is an alias.
 *   inViewport:<descriptor>[|min=<ratio>] — each match's visible fraction (0..1, default 0.5)
 *   box:<descriptor>|minWidth=<n>,maxWidth=<n>,minHeight=<n>,maxHeight=<n> — each match's size (px)
 *   overlaps:<descriptor>|<descriptor2> / noOverlap:<descriptor>|<descriptor2> — the first matches' boxes
 *   attr:<descriptor>|<name>=<value> | attr:<descriptor>|<name> (present) | attr:<descriptor>|!<name> (absent)
 *   flashed:<descriptor>|class=<cls>|attr=<name>|animation [|withinMs=<n>] — a match GAINED the
 *                                        class / attribute / an animation after the last user input
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
    case "style":
    case "styleMatches":
    case "inViewport":
    case "box":
    case "overlaps":
    case "noOverlap":
    case "attr":
    case "flashed":
      return parseVisualSpec(kind, rest);
    default:
      throw new Error(`unsupported assertion kind ${JSON.stringify(kind)}`);
  }
}

/** A finite number from a spec, or a precise error. */
function specNumber(kind: string, key: string, v: string | undefined): number {
  const n = v === undefined || v.trim() === "" ? Number.NaN : Number(v);
  if (!Number.isFinite(n)) throw new Error(`${kind}: ${key} must be a number, got ${JSON.stringify(v ?? "")}`);
  return n;
}

/** `<descriptor>|<rest>` split at the FIRST `|`; `rest` required unless `optional`. */
function splitDescriptor(kind: string, spec: string, shape: string, optional = false): [TargetDescriptor, string] {
  const bar = spec.indexOf("|");
  if (bar === -1 && !optional) throw new Error(`${kind} requires "${shape}"`);
  return [parseDescriptorSpec(bar === -1 ? spec : spec.slice(0, bar)), bar === -1 ? "" : spec.slice(bar + 1)];
}

/**
 * The visual-state assertion specs (#148) — see `parseAssertionSpec`. Validated through the
 * recording `AssertionSchema` (the allowlisted properties, a closed set of ops/channels), so a typo
 * fails here, before any browser work.
 */
function parseVisualSpec(kind: string, rest: string): Assertion {
  let out: Assertion;
  switch (kind) {
    case "style":
    case "styleMatches": {
      // The descriptor ends at the LAST `|` (a style value never contains one).
      const bar = rest.lastIndexOf("|");
      if (bar === -1) throw new Error(`${kind} requires "<descriptor>|<prop><op><value>", e.g. ${kind}:[data-heat]|alpha(background-color)>0`);
      const target = parseDescriptorSpec(rest.slice(0, bar));
      const m = /^\s*(?:([a-z]+)\(\s*([a-z-]+)\s*\)|([a-z-]+))\s*(>=|<=|!=|=|>|<)\s*(.*)$/.exec(rest.slice(bar + 1));
      if (m === null) throw new Error(`${kind}: expected <prop><op><value> (op = != > >= < <=), got ${JSON.stringify(rest.slice(bar + 1))}`);
      const channel = m[1];
      const property = m[2] ?? m[3] ?? "";
      if (channel !== undefined && !(STYLE_CHANNELS as readonly string[]).includes(channel)) {
        throw new Error(`${kind}: unknown channel ${JSON.stringify(channel)} (one of ${STYLE_CHANNELS.join(", ")})`);
      }
      if (!(STYLE_PROPERTIES as readonly string[]).includes(property)) {
        throw new Error(`${kind}: property ${JSON.stringify(property)} is not allowlisted (one of ${STYLE_PROPERTIES.join(", ")})`);
      }
      out = {
        kind: "style",
        target,
        property: property as StyleProperty,
        ...(channel === undefined ? {} : { channel: channel as StyleChannel }),
        op: m[4] as CompareOp,
        value: (m[5] ?? "").trim(),
      };
      break;
    }
    case "inViewport": {
      const [target, opts] = splitDescriptor(kind, rest, "<descriptor>[|min=<ratio>]", true);
      out = { kind: "inViewport", target };
      for (const pair of opts.split(",").filter((p) => p !== "")) {
        const [k, v] = pair.split("=");
        if (k !== "min") throw new Error(`inViewport: unknown option ${JSON.stringify(k)} (only min=<ratio>)`);
        out = { ...out, min: specNumber(kind, "min", v) };
      }
      break;
    }
    case "box": {
      const [target, opts] = splitDescriptor(kind, rest, "<descriptor>|minWidth=<n>,maxWidth=<n>,minHeight=<n>,maxHeight=<n>");
      const bounds: Record<string, number> = {};
      for (const pair of opts.split(",").filter((p) => p !== "")) {
        const [k, v] = pair.split("=");
        if (k !== "minWidth" && k !== "maxWidth" && k !== "minHeight" && k !== "maxHeight") {
          throw new Error(`box: unknown bound ${JSON.stringify(k)} (minWidth, maxWidth, minHeight, maxHeight)`);
        }
        bounds[k] = specNumber(kind, k, v);
      }
      if (Object.keys(bounds).length === 0) throw new Error("box needs at least one bound");
      out = { kind: "box", target, ...bounds };
      break;
    }
    case "overlaps":
    case "noOverlap": {
      const [target, other] = splitDescriptor(kind, rest, "<descriptor>|<descriptor2>");
      out = { kind: "overlap", target, other: parseDescriptorSpec(other), overlapping: kind === "overlaps" };
      break;
    }
    case "attr": {
      const [target, spec] = splitDescriptor(kind, rest, "<descriptor>|<name>[=<value>] or <descriptor>|!<name>");
      if (spec.startsWith("!")) out = { kind: "attr", target, name: spec.slice(1), absent: true };
      else {
        const eq = spec.indexOf("=");
        out = eq === -1 ? { kind: "attr", target, name: spec } : { kind: "attr", target, name: spec.slice(0, eq), value: spec.slice(eq + 1) };
      }
      break;
    }
    case "flashed": {
      const [target, opts] = splitDescriptor(kind, rest, "<descriptor>|class=<cls> (or attr=<name>, animation)[|withinMs=<n>]");
      let f: Extract<Assertion, { kind: "flashed" }> = { kind: "flashed", target };
      for (const part of opts.split("|").filter((p) => p !== "")) {
        const eq = part.indexOf("=");
        const k = eq === -1 ? part : part.slice(0, eq);
        const v = eq === -1 ? "" : part.slice(eq + 1);
        if (k === "class") f = { ...f, className: v };
        else if (k === "attr") f = { ...f, attr: v };
        else if (k === "animation" && eq === -1) f = { ...f, animation: true };
        else if (k === "withinMs") f = { ...f, withinMs: specNumber(kind, "withinMs", v) };
        else throw new Error(`flashed: unknown option ${JSON.stringify(part)} (class=<cls>, attr=<name>, animation, withinMs=<n>)`);
      }
      out = f;
      break;
    }
    default:
      throw new Error(`unsupported assertion kind ${JSON.stringify(kind)}`);
  }
  const parsed = AssertionSchema.safeParse(out);
  if (!parsed.success) {
    throw new Error(`invalid ${kind} spec: ${parsed.error.issues.map((i) => i.message).join("; ")}`);
  }
  return parsed.data;
}

const HTTP_METHOD = /^(?:[A-Za-z]+|\*)$/;

/**
 * `<METHOD> <path-glob>` — the request half of a network check. Two distinct
 * failure modes get two distinct messages: a missing/malformed method (or no
 * space at all) doesn't match the shape at all, while a present-but-unrooted
 * path glob is the far more common mistake (issue #83) and deserves to say
 * exactly what's wrong instead of re-printing the whole shape as if nothing
 * was recognized.
 */
function parseRequestSpec(kind: string, text: string): { method: string; pathGlob: string } {
  const sp = text.indexOf(" ");
  const method = sp === -1 ? "" : text.slice(0, sp);
  const pathGlob = sp === -1 ? "" : text.slice(sp + 1).trim();
  if (!HTTP_METHOD.test(method) || pathGlob.length === 0) {
    throw new Error(`${kind} requires "<METHOD> <path-glob>", e.g. ${kind}:PUT /api/profile/*`);
  }
  if (!pathGlob.startsWith("/")) {
    throw new Error(`${kind}: path glob must start with "/" (got ${JSON.stringify(pathGlob)})`);
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
