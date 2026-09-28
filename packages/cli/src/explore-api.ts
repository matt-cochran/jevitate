import { sessionLostReason } from "./session-check.js";
import { writeFile } from "node:fs/promises";
import { logsDirFor } from "./project-dir.js";
import { join, resolve as resolvePath } from "node:path";
import type { JudgmentPort, GenerationPort, UsageTracker, UsageCounts } from "@jevitate/ai-core";
import { PlaywrightBrowserPort, resolveEmulation, type BrowserLaunchOptions, type BrowserPort, type EmulationSpec } from "@jevitate/playwright";
import { CastActor, BrowseTheWeb } from "@jevitate/screenplay";
import { type Assertion, type InvariantSpec, type Recording } from "@jevitate/recording";
import type { DefectRecord, HostHealthSampler, InvariantDefect, InvariantReport, SafetyConfig, SideEffect } from "@jevitate/explore";
import type { EnvironmentDegraded, HostHealthSummary } from "@jevitate/domain";
import {
  runGoalBasedMission,
  authorJourney,
  runInductionMission,
  runAdversarialMission,
  runFeatureMission,
  assertAuthorizedExploreTarget,
  resolveMissionFixture,
  type Bounds,
  type CoverageReport,
  type GoalBasedOutcome,
  type StopReason,
  type AuthorJourneyResult,
  type AdversarialOutcome,
  type AdversarialDefect,
  type MisuseStrategy,
  type CapabilityScope,
  type FeatureRunResult,
  type MissionRouteScope,
  resolveRouteScope,
  refusalNote,
  safetyRefusalsFromTranscript,
  startRouteGlobs,
  type TranscriptEntry,
  type RunAnswer,
  type RunOutcome,
  type CoverageThresholds,
  type SuccessCheck,
  type SuccessCheckResult,
  type SuccessWhen,
  type SecretField,
  type BudgetTrajectory,
  type CrashReport,
  type Http5xxDefect,
  Http5xxOracle,
  secretFieldSecrets,
} from "@jevitate/explore";
import { FsJourneyStore } from "@jevitate/journey";
import { conversationConfig, type ConversationOptions } from "./conversation-options.js";
import {
  combineOutcomes,
  foldGoalOutcome,
  gatingDefects,
  type FilingConfig,
  type IssueDraft,
  type IssueFilerPort,
  type MissionFailure,
  type MissionOutcome,
} from "@jevitate/domain";
import {
  draftForCrash,
  draftForDefect,
  draftForHang,
  hangOutcome,
  type HangFinding,
  type TimingSummary,
} from "@jevitate/explore";
import { processIssueDrafts, type FindingsIssues } from "./findings-filing.js";
import { currentEngineInfo, type EngineInfo } from "./engine.js";
import type { TargetConfig } from "./target-config.js";
import { MissionJournal, artifactStamp, closeQuietly, resultPathFor, writeMissionResult } from "./mission-journal.js";
import { MISSION_RESULT_SCHEMA_VERSION, unifiedDefects } from "./result-schema.js";
import { applyHttp5xxGoalOutcome, describeHttp5xx, http5xxGoalReason } from "./http-5xx-outcome.js";
import { goalExitCode, missionExitCode } from "./mission-exit.js";
import { launchArmed } from "./launch-armed.js";
import { finishHostHealth } from "./host-health-run.js";
import {
  applyServerLogOutcome,
  openServerLogRuntime,
  type ServerLogDefect,
  type ServerLogEvidence,
  type ServerLogRuntimeResult,
  type ServerLogsSummary,
  type TranscriptEntryWithLogs,
} from "./log-correlation.js";
import { fixtureReplayOpener, recordingFixture, type MissionFixtureResult, type MissionFixtures } from "./mission-fixtures.js";
import { observerSessions, persistedActors, type MissionActors } from "./mission-actors.js";
import {
  type ServerLogOptions,
  serverLogResult,
  type OverflowFlags,
  recordingEmulation,
  DRAFTS_ONLY,
  NO_FILER,
  draftContext,
  freshSessionOpener,
  currentUrlSafe,
  assertSaveStorageStateOutsideProject,
  persistStorageState,
  browserVersionOf,
  type MissionTarget,
  declaredResult,
} from "./explore-shared.js";

export { parseAssertionSpec, parseSuccessSpec, resolveExploreAllowlist } from "./explore-specs.js";

export {
  type ServerLogOptions,
  serverLogResult,
  type OverflowFlags,
  currentUrlSafe,
  assertSaveStorageStateOutsideProject,
  persistStorageState,
  type MissionTarget,
  type ExploreCliDeps,
} from "./explore-shared.js";

/**
 * The programmatic surface behind `jevitate explore` — wires a real Playwright
 * `Page` + gateways to `@jevitate/explore`'s goal-based mission, then persists
 * the emitted `Recording` under `.jevitate/logs/<date>`.
 *
 * The authorized-target guard runs FIRST (fail-closed), BEFORE any browser is
 * opened — an unauthorized origin never launches Chromium. Gateways are
 * injected (fakes in tests / live wiring in `program.ts`), so this file needs
 * no keys or network to be unit-tested.
 */

export interface RunExplorationOptions {
  /** Test seam (#203): the run's host-health sampler (a deterministic fake host). Default: this host's. */
  readonly hostHealth?: HostHealthSampler;
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
  /**
   * #202 (`--allow-vacuous-checks`): a check satisfied before the run's first action (held on the
   * seed page and never changed; a request matched only by page load/polling) is a warning instead
   * of a failure. Default: it fails — a run that proved nothing is never clean.
   */
  readonly allowVacuousChecks?: boolean;
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
  /** Where the Recording is written. Default `.jevitate/logs/<date>` (project, else `~/.jevitate`). */
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
   *
   * #159: written on EVERY exit path, not only a clean one — a crash (thrown mid-mission, still
   * reaches `persistStorageState` in this function's `finally`) and a kill signal (SIGTERM/SIGINT,
   * via the kill switch's own synchronous write of the mission's `StorageStateSnapshotter`, see
   * `storage-state-snapshot.ts`) both still get a write. Neither ever overwrites a good file with a
   * session that is already lost/logged-out (a page that looks login-like at the moment of capture):
   * the mission falls back to the last snapshot taken while the session still looked authenticated,
   * and writes nothing at all if it never captured one. There is currently no flag to force a write
   * over that guard — an operator who wants the raw end-state regardless can inspect the Recording's
   * `finalUrl` and re-run with a fresh `--storage-state` login.
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
   * Per-mission viewport/device emulation (#149, CLI `--viewport <W>x<H>` / `--device "<name>"`,
   * mutually exclusive). An unknown device name (or both given together) is refused BEFORE any
   * browser opens (`PlaywrightBrowserPort.open`'s `resolveEmulation`). Recorded on the Recording,
   * so replay/verify-fix reproduce under the SAME device by default.
   */
  readonly emulation?: EmulationSpec;
  /**
   * #147: the mission's actors (`--actor`). The primary's storageState seeds the mission session
   * (it must equal `storageState` when both are given); each observer gets its own fresh context,
   * opened only when a declared cross-actor check needs it, never driven by the model.
   */
  readonly actors?: MissionActors;
}

export interface RunExplorationResult {
  /** The result schema's version (#195): the common fields below are filled the same way by every strategy. */
  readonly schemaVersion: typeof MISSION_RESULT_SCHEMA_VERSION;
  readonly strategy: "goal";
  /**
   * #213: the `--storage-state` session was not honoured — the run's first page was a sign-in page, so
   * whatever it did (the model may sign in by itself), it did not start as that session. A warning.
   */
  readonly sessionLost?: { readonly reason: string };
  /**
   * The portable verdict — ALWAYS canonical (#217): `goalOutcome` folded by the domain's single
   * mapping (`GOAL_OUTCOME_FOLD`): succeeded → clean; failed/exhausted/blocked → defects-found.
   */
  readonly missionOutcome: MissionOutcome;
  /** The goal run's own ending (#217): succeeded/failed/exhausted/blocked, or a shared outcome. Equal to `outcome`. */
  readonly goalOutcome: GoalBasedOutcome;
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
  /** Warnings about the verdict (#174: a `--success-when held` check that already held on the start page). */
  readonly checkWarnings?: string[];
  readonly stop: StopReason;
  readonly finalUrl: string;
  readonly decisions: number;
  readonly actions: number;
  /** Every Recording the run wrote (#195: one list on every strategy) — a goal run writes one. */
  readonly recordingPaths: string[];
  /** @deprecated since 0.2.0 (#195) — use `recordingPaths[0]`; removed in the next minor. */
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
  /** #126: seed-load hangs that did not reproduce (the goal was retried) — evidence, whatever the outcome. */
  readonly intermittentHangs?: HangFinding[];
  /** For a `crashed` run: the evidence and its attribution (jevitate / system under test / uncertain). */
  readonly crash?: CrashReport;
  /** Declared mission spend budgets (#150/#180): the observed trajectory, whatever the outcome. */
  readonly budget?: BudgetTrajectory[];
  /** The run's Recording (also written to `recordingPath`). */
  readonly recording: Recording;
  /** Where the run happened — what `verify-fix` needs to replay a finding. */
  readonly target: MissionTarget;
  /** The persisted typed result (`<recording>.result.json`). */
  readonly resultPath: string;
  /** Which build produced this result (issue #83): `{version, commit, builtAt}`. */
  readonly engine: EngineInfo;
  /**
   * EVERY defect the run found (#195): HTTP 5xx hard-signal defects (#208), declared-invariant defects (#86, with `--invariants`) and
   * `server-log` defects (#142, with `--log-defect`) — `verify-fix` replays any of them by fingerprint.
   */
  readonly defects: Array<InvariantDefect | Http5xxDefect | ServerLogDefect>;
  /** Per declared invariant: applied / held / violated / unreadable counts. */
  readonly invariants?: InvariantReport[];
  /** The declared spec the run evaluated — persisted so `verify-fix` re-checks the SAME invariants. */
  readonly invariantSpec?: InvariantSpec;
  /** Judgment/generation call counts and tokens for this run (#100); present only when `opts.usage` was supplied. */
  readonly usage?: UsageCounts;
  /** Backend log correlation summary (#142) — present only when `--log-source` was given. */
  readonly serverLogs?: ServerLogsSummary;
  /** @deprecated since 0.2.0 (#195) — the `server-log` subset of `defects`; removed in the next minor. */
  readonly serverLogDefects?: ServerLogDefect[];
  /** The fixture the mission started from (#140/#144): identity, non-secret outputs, the setup/restore log. */
  readonly fixtures?: MissionFixtureResult;
  /** The host's health over the run (#203): peaks, the slowest render, starved steps. */
  readonly hostHealth: HostHealthSummary;
  /** Findings met while the host was starved (#203) — advisory, never a defect/hang, never failing the run. */
  readonly environmentDegraded: EnvironmentDegraded[];
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
  // #169: the summary already knows WHICH source(s) made the oracle unhealthy and why (failed to
  // open vs. declared but silent) — this default only covers the (should-be-unreachable) case of no
  // summary at all.
  return (
    run?.summary.oracleReason ??
    "the --log-defect oracle could not run: every declared --log-source failed to open or read a line — an absence of server-log defects proves nothing"
  );
}

/** Outcomes whose `reason` describes a UI-side blocker worth pairing with a correlated server cause. */
const BLOCKED_LIKE_OUTCOMES: ReadonlySet<GoalBasedOutcome> = new Set(["blocked", "exhausted", "failed", "inconclusive"]);
const SERVER_CAUSE_MAX_CHARS = 160;

/**
 * The most informative correlated server-log line attached to the LAST transcript step (#165's
 * "Also" — the step the run ended on is the one whose UI blocker `mission.reason` already
 * describes): an `error` line wins over a `warn` one; ties keep the first (arrival order). `undefined`
 * when `--log-source` was not given, or nothing warn/error-level attached to that step.
 */
function lastStepServerCause(transcript: readonly TranscriptEntryWithLogs[] | undefined): string | undefined {
  const logs = transcript?.[transcript.length - 1]?.serverLogs;
  if (logs === undefined || logs.length === 0) return undefined;
  let line: ServerLogEvidence | undefined;
  for (const l of logs) {
    if (l.level !== "error" && l.level !== "warn") continue;
    if (line === undefined || (line.level !== "error" && l.level === "error")) line = l;
  }
  if (line === undefined) return undefined;
  const body = line.message.length > SERVER_CAUSE_MAX_CHARS ? `${line.message.slice(0, SERVER_CAUSE_MAX_CHARS)}…` : line.message;
  return `${line.level}${line.target === undefined ? "" : ` ${line.target}`} ${quote(body)}`;
}

function quote(s: string): string {
  return `"${s}"`;
}

/**
 * Pairs an already-computed UI-side `reason` with the correlated server cause on the step the run
 * ended on (#165 "Also"): `"<UI reason>; server: <level> \"<message>\""`. A no-op when there is no
 * `reason` to pair with, the outcome isn't one of blocked/exhausted/inconclusive (a `defects-found`
 * or an oracle-unhealthy `inconclusive` already gets its own `serverLogOutcomeReason`), or no
 * server-log evidence attached to that step — including when `--log-source` was never given.
 */
export function withServerCause(reason: string | undefined, outcome: GoalBasedOutcome, transcript: readonly TranscriptEntryWithLogs[] | undefined): string | undefined {
  if (reason === undefined || !BLOCKED_LIKE_OUTCOMES.has(outcome)) return reason;
  const cause = lastStepServerCause(transcript);
  return cause === undefined ? reason : `${reason}; server: ${cause}`;
}

export async function runExploration(opts: RunExplorationOptions): Promise<RunExplorationResult> {
  // Guardrail #1 — authorize BEFORE opening a browser. Throws on refusal.
  const origin = assertAuthorizedExploreTarget(opts.url, opts.allowlist);
  assertSaveStorageStateOutsideProject(opts.saveStorageState);
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

  // #149: refused BEFORE any browser opens (an unknown --device, or --viewport + --device together).
  const resolvedEmulation = resolveEmulation(opts.emulation);
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
    ...opts.emulation,
    ...(primaryState !== undefined ? { storageState: primaryState } : {}),
  };
  const outDir = opts.outDir ?? logsDirFor();
  const iso = (opts.nowIso ?? (() => new Date().toISOString()))();
  // Crash-safe: the transcript and partial Recording are flushed after every step. `MissionJournal`
  // itself creates `outDir` synchronously (mkdirSync).
  const journal = new MissionJournal(join(outDir, `explore-${artifactStamp(iso)}.json`));
  // Crash-safe on SIGTERM/SIGINT too (#94): a partial `inconclusive` result is written from
  // whatever the journal has already flushed, and the process exits with the conventional code.
  // #163: this run's own share of a (possibly shared) tracker: its usage and sidecar.
  const runUsage = opts.usage?.scope();
  // #226: the kill switch is armed BEFORE the host sampler and the browser launch (see launch-armed.ts).
  const { disarmKillSwitch, health, session, snapshotter } = await launchArmed({
    hostHealth: opts.hostHealth,
    saveStorageState: opts.saveStorageState !== undefined,
    open: () => port.open(launch),
    mission: (hooks) => ({
      // #220: the killed run's partial result carries the unified schema's common fields too.
      strategy: "goal",
      target: { seedUrl: opts.url, allowlist: [...opts.allowlist], ...(primaryState !== undefined ? { storageStatePath: resolvePath(primaryState) } : {}) },
      recordingPath: journal.recordingPath,
      hostHealth: hooks.hostHealth,
      transcriptPath: journal.transcriptPath,
      transcript: () => journal.transcript,
      ...(runUsage === undefined ? {} : { usage: runUsage }),
      ...(opts.saveStorageState === undefined ? {} : { storageState: { path: opts.saveStorageState, snapshot: hooks.snapshot } }),
    }),
  });
  // #208: the shared HTTP 5xx hard signal, listening from before the first navigation.
  const http5xx = new Http5xxOracle(session.page, { allowlist: opts.allowlist });
  // #147: each observer in its OWN fresh context (only its own storageState), opened on first use.
  const observers =
    opts.actors === undefined || opts.actors.observers.length === 0
      ? undefined
      : observerSessions(portFactory, { headless: true, allowedOrigins: [...opts.allowlist], baseUrl: origin, ...opts.browser }, opts.actors.observers);
  // Backend log correlation (#142): opened BEFORE the mission runs so its window covers the seed
  // load too; a no-op (`undefined`) when `--log-source` was not given.
  const serverLog = openServerLogRuntime({
    sources: opts.serverLog?.sources ?? [],
    logDefect: opts.serverLog?.logDefect ?? [],
    quietOk: opts.serverLog?.quietOk ?? [],
    logIgnore: opts.serverLog?.logIgnore ?? [],
    ...(opts.serverLog?.drainMs === undefined ? {} : { drainMs: opts.serverLog.drainMs }),
    secrets: secrets ?? [],
    onTranscriptEntry: journal.onTranscriptEntry,
  });
  // #159: every settled step also refreshes the in-memory storageState snapshot (cheap no-op when
  // `--save-storage-state` was not given — `snapshotter.noteSettledStep` checks `enabled` itself).
  const onTranscriptEntry = (entry: TranscriptEntry, all: readonly TranscriptEntry[]): void => {
    health.noteStep(entry);
    http5xx.noteStep(entry);
    (serverLog?.onTranscriptEntry ?? journal.onTranscriptEntry)(entry, all);
    snapshotter.noteSettledStep(currentUrlSafe(session));
  };
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
      onTranscriptEntry,
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
      ...(opts.allowVacuousChecks === true ? { allowVacuousChecks: true } : {}),
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
      hostHealth: health,
    });
    await observers?.close();

    // The mission (and its hang replays) is done: restore now, so the persisted log includes it. The
    // caller restores again on every exit path (a no-op once restored).
    await fx?.restore();
    const recording: Recording = {
      ...mission.recording,
      ...(missionFixture === undefined ? {} : { fixture: recordingFixture(missionFixture.record) }),
      ...(resolvedEmulation === undefined ? {} : { emulation: recordingEmulation(resolvedEmulation) }),
    };
    // Never blocks the mission itself: the drain wait happens AFTER `runGoalBasedMission` returned.
    const serverLogRun = serverLog === undefined ? undefined : await serverLog.finish(mission.transcript);
    // #142 follow-up: a found server-log defect counts as `defects-found` (exit 1); an unreadable
    // `--log-defect` oracle turns an otherwise-`succeeded` run `inconclusive` (exit 2) — never clean.
    const loggedOutcome = applyServerLogGoalOutcome(mission.outcome, serverLogRun);
    // #208: an HTTP 5xx is a hard-signal defect — `defects-found` even when the goal's checks held.
    const httpDefects = http5xx.defects(mission.transcript);
    const hardOutcome = applyHttp5xxGoalOutcome(loggedOutcome, httpDefects);
    // #203: most steps on a starved host → `inconclusive` (degraded-environment), never a pass/fail.
    // #213: a starved `failed` goal keeps the check that did not hold in its degraded reason.
    const host = await finishHostHealth(health, hardOutcome, {
      ...(hardOutcome === mission.outcome && (mission.failure?.message ?? mission.reason) !== undefined
        ? { wouldHaveBeen: mission.failure?.message ?? mission.reason }
        : {}),
    });
    const goalOutcome: GoalBasedOutcome = host.outcome;
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
      schemaVersion: MISSION_RESULT_SCHEMA_VERSION,
      strategy: "goal",
      missionOutcome: foldGoalOutcome(goalOutcome),
      goalOutcome,
      issues,
      timing: mission.run.timing,
      outcome: goalOutcome,
      runOutcome: mission.run.outcome,
      ...(mission.run.answer === undefined ? {} : { answer: mission.run.answer }),
      assertionPassed: mission.assertionPassed,
      checks: mission.checks,
      ...(mission.warnings === undefined ? {} : { checkWarnings: mission.warnings }),
      ...((): { sessionLost?: { reason: string } } => {
        const lost = sessionLostReason({
          target: primaryState === undefined ? {} : { storageStatePath: resolvePath(primaryState) },
          transcript: serverLogRun?.transcript ?? mission.transcript,
        });
        return lost === undefined ? {} : { sessionLost: { reason: lost } };
      })(),
      stop: mission.run.stop,
      finalUrl: mission.finalUrl,
      decisions: mission.run.decisions,
      actions: mission.run.actions,
      recordingPaths: [journal.recordingPath],
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
      ...(mission.intermittentHangs === undefined ? {} : { intermittentHangs: mission.intermittentHangs }),
      ...(mission.run.crash === undefined ? {} : { crash: mission.run.crash }),
      // #180: the declared budgets' observed trajectory, whatever the outcome (a hang included).
      ...(mission.budget === undefined ? {} : { budget: mission.budget }),
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
      // #209: a goal-specific miss (`success-check-failed`, `vacuous-check`) is typed too — after an
      // engine failure or a starved host, which explain the run before the check does.
      ...((): { failure?: MissionFailure } => {
        const f = mission.run.failure ?? host.failure ?? mission.failure;
        return f === undefined ? {} : { failure: f };
      })(),
      ...(host.failure !== undefined
        ? { reason: host.failure.message }
        : goalOutcome === mission.outcome
        ? (() => {
            const reason = withServerCause(mission.reason, goalOutcome, serverLogRun?.transcript);
            // #208: a broken run keeps its outcome, but its reason still names the server error.
            const withHttp = httpDefects.length === 0 ? reason : `${reason ?? goalOutcome}; HTTP 5xx: ${describeHttp5xx(httpDefects)}`;
            return withHttp === undefined ? {} : { reason: withHttp };
          })()
        : loggedOutcome === mission.outcome
          ? { reason: http5xxGoalReason(httpDefects, mission.assertionPassed) }
          : { reason: serverLogOutcomeReason(goalOutcome, serverLogRun) }),
      ...declaredResult(opts.invariants, mission.invariantDefects, mission.invariants),
      ...(runUsage === undefined ? {} : { usage: runUsage.snapshot() }),
      ...serverLogResult(serverLogRun),
      defects: unifiedDefects<InvariantDefect | Http5xxDefect>(
        [...(opts.invariants === undefined ? [] : (mission.invariantDefects ?? [])), ...httpDefects],
        serverLogRun?.defects,
      ),
      ...host.fields,
    };
    // Persisted so `verify-fix` can replay a hang later (the typed result next to the Recording).
    writeMissionResult(journal.recordingPath, result.missionOutcome, result.exitCode, result, runUsage);
    return result;
  } finally {
    disarmKillSwitch();
    health.stop();
    // Safety net: if the mission threw before `serverLog.finish()` ran, close sources immediately
    // (no drain wait) rather than leaving them open until process exit.
    await serverLog?.abort();
    await observers?.close().catch(() => undefined);
    await persistStorageState(session, opts.saveStorageState, snapshotter);
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
    // #170: a Journey authored behind a login (--storage-state) declares it, so a run without a
    // storage state fails fast as a configuration error instead of a gating step-1 assertion.
    const journey =
      opts.storageState !== undefined && result.journey.metadata.requiresAuth !== true
        ? { ...result.journey, metadata: { ...result.journey.metadata, requiresAuth: true } }
        : result.journey;
    await new FsJourneyStore(opts.journeysDir).put(journey);
    return journey === result.journey ? result : { ...result, journey };
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
 * and persists each emitted repro `Recording` under `.jevitate/logs/<date>`.
 *
 * Same fail-closed discipline as `runExploration`: the authorized-target guard
 * runs FIRST, before any browser is opened.
 */
export interface RunCoverageMissionOptions {
  /** Test seam (#203): the run's host-health sampler (a deterministic fake host). Default: this host's. */
  readonly hostHealth?: HostHealthSampler;
  readonly url: string;
  readonly allowlist: readonly string[];
  readonly judge: JudgmentPort;
  readonly gen: GenerationPort;
  /** Usage accounting (#100): see `RunExplorationOptions.usage`. */
  readonly usage?: UsageTracker;
  readonly bounds?: Partial<Bounds>;
  /** Where the repro Recordings are written. Default `.jevitate/logs/<date>` (project, else `~/.jevitate`). */
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
   * written with mode 0600, and its contents are never logged. See
   * `RunExplorationOptions.saveStorageState`'s own doc for the full behaviour (#159: written on
   * every exit path including a crash/kill signal, never over a lost/logged-out session).
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
  /** Per-mission viewport/device emulation (#149); see `RunExplorationOptions.emulation`. */
  readonly emulation?: EmulationSpec;
  /** Horizontal-overflow hard signal (#149, CLI `--check-overflow` / `--ignore-overflow`). */
  readonly overflow?: OverflowFlags;
}

/**
 * How the frontier ended. `insufficient-coverage` (#209: the ONE name — it was `insufficient-exploration`
 * in #203): drained by timed-out actions, or emptied having exercised too little (e.g. only global
 * navigation) to call it `clean`. `exhausted` means fully explored AND enough to be clean.
 */
/** #209: a coverage frontier's own defect as listed in the unified `defects` (its Recording stays in `coverage.defects`). */
export type CoverageFrontierDefect = Omit<DefectRecord, "recording" | "reason"> & { readonly title: string };

type CoverageRunOutcome = "exhausted" | "insufficient-coverage" | "cap" | "crashed" | "hang" | "scope-unreachable" | "stalled" | "budget";

export interface RunCoverageMissionResult {
  /** The host's health over the run (#203): peaks, the slowest render, starved steps. */
  readonly hostHealth: HostHealthSummary;
  /** Findings met while the host was starved (#203) — advisory, never a defect/hang, never failing the run. */
  readonly environmentDegraded: EnvironmentDegraded[];

  /** The result schema's version (#195): the common fields are filled the same way by every strategy. */
  readonly schemaVersion: typeof MISSION_RESULT_SCHEMA_VERSION;
  /** Which frontier ran: `coverage` (breadth) or `exploratory` (novelty-first) — the file prefix names it (`coverage-`/`exploratory-`, #213). */
  readonly strategy: "coverage" | "exploratory";
  /** #213: the route scope the frontier was contained to, and where it came from (the #224 field). */
  readonly scope: MissionRouteScope;
  readonly coverage: CoverageReport;
  readonly outcome: CoverageRunOutcome;
  /** Hangs met while exploring (deduped), each with its reproduction and its own path Recording. */
  readonly hangs: HangFinding[];
  /** Declared mission spend budgets (#150/#180): the observed trajectory, whatever the outcome. */
  readonly budget?: BudgetTrajectory[];
  /** A coverage run has no single Recording: each finding carries the path that reached it. */
  readonly recording: null;
  /** Where the run happened — what `verify-fix` needs to replay a finding. */
  readonly target: MissionTarget;
  /**
   * The typed verdict: `crashed` for a broken run, else `defects-found` / `clean`. An advisory
   * (`judgment-flagged-state`, #214) defect alone never makes it `defects-found`.
   */
  readonly missionOutcome: MissionOutcome;
  readonly exitCode: number;
  readonly failure?: MissionFailure;
  /** Slowest pages/transitions and endpoints (p50/max), keyed by normalized route/endpoint. */
  readonly timing: TimingSummary;
  /** The persisted typed result (`<strategy>-<stamp>.result.json`: `coverage-` or `exploratory-`). */
  readonly resultPath: string;
  readonly recordingPaths: string[];
  /** The shared decision transcript (`<strategy>-<stamp>.transcript.json`). */
  readonly transcriptPath: string;
  /** The writes the frontier's actions fired (#116), marked when the control was paid / destructive. */
  readonly sideEffects: SideEffect[];
  readonly sideEffectsTruncated?: number;
  /** Which build produced this result (issue #83): `{version, commit, builtAt}`. */
  readonly engine: EngineInfo;
  /**
   * EVERY defect the run found (#195; #209): the frontier's own (`horizontal-overflow`, and a
   * `judgment-flagged-state` — also in `coverage.defects`, which keeps each one's repro Recording;
   * #214: marked `advisory: true`, it never sets `missionOutcome`/`exitCode` on its own),
   * declared-invariant defects (#86, each with its own path Recording) and `server-log` defects (#142).
   */
  readonly defects: Array<CoverageFrontierDefect | InvariantDefect | Http5xxDefect | ServerLogDefect>;
  readonly invariants?: InvariantReport[];
  readonly invariantSpec?: InvariantSpec;
  /** Judgment/generation call counts and tokens for this run (#100); present only when `opts.usage` was supplied. */
  readonly usage?: UsageCounts;
  /** Backend log correlation summary (#142) — present only when `--log-source` was given. */
  readonly serverLogs?: ServerLogsSummary;
  /** @deprecated since 0.2.0 (#195) — the `server-log` subset of `defects`; removed in the next minor. */
  readonly serverLogDefects?: ServerLogDefect[];
}

export async function runCoverageMission(opts: RunCoverageMissionOptions): Promise<RunCoverageMissionResult> {
  // Guardrail #1 — authorize BEFORE opening a browser. Throws on refusal.
  const origin = assertAuthorizedExploreTarget(opts.url, opts.allowlist);
  assertSaveStorageStateOutsideProject(opts.saveStorageState);
  // #224: the shared default scope (the start URL's route) must be derivable — refused up front.
  startRouteGlobs(opts.url);

  // #149: refused BEFORE any browser opens.
  const resolvedEmulation = resolveEmulation(opts.emulation);
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
  const outDir = opts.outDir ?? logsDirFor();
  const iso = (opts.nowIso ?? (() => new Date().toISOString()))();
  const stamp = artifactStamp(iso);
  // `MissionJournal` creates `outDir` synchronously (mkdirSync).
  // #213: an exploratory run's files are named for it (`exploratory-*`), not `coverage-*`; every
  // reader finds a result by its content (#211), never by this prefix.
  const filePrefix = opts.strategy ?? "coverage";
  const journal = new MissionJournal(join(outDir, `${filePrefix}-${stamp}.json`));
  // #163: this run's own share of a (possibly shared) tracker: its usage and sidecar.
  const runUsage = opts.usage?.scope();
  // #226: the kill switch is armed BEFORE the host sampler and the browser launch (see launch-armed.ts).
  const { disarmKillSwitch, health, session, snapshotter } = await launchArmed({
    hostHealth: opts.hostHealth,
    saveStorageState: opts.saveStorageState !== undefined,
    open: () => port.open(launch),
    mission: (hooks) => ({
      // #220: the killed run's partial result carries the unified schema's common fields too.
      strategy: opts.strategy ?? "coverage",
      target: { seedUrl: opts.url, allowlist: [...opts.allowlist], ...(opts.storageState !== undefined ? { storageStatePath: resolvePath(opts.storageState) } : {}) },
      recordingPath: journal.recordingPath,
      hostHealth: hooks.hostHealth,
      transcriptPath: journal.transcriptPath,
      transcript: () => journal.transcript,
      ...(runUsage === undefined ? {} : { usage: runUsage }),
      ...(opts.saveStorageState === undefined ? {} : { storageState: { path: opts.saveStorageState, snapshot: hooks.snapshot } }),
    }),
  });

  // #208: the shared HTTP 5xx hard signal, listening from before the first navigation.
  const http5xx = new Http5xxOracle(session.page, { allowlist: opts.allowlist });
  const serverLog = openServerLogRuntime({
    sources: opts.serverLog?.sources ?? [],
    logDefect: opts.serverLog?.logDefect ?? [],
    quietOk: opts.serverLog?.quietOk ?? [],
    logIgnore: opts.serverLog?.logIgnore ?? [],
    ...(opts.serverLog?.drainMs === undefined ? {} : { drainMs: opts.serverLog.drainMs }),
    secrets: [],
    onTranscriptEntry: journal.onTranscriptEntry,
  });
  const onTranscriptEntry = (entry: TranscriptEntry, all: readonly TranscriptEntry[]): void => {
    health.noteStep(entry);
    http5xx.noteStep(entry);
    (serverLog?.onTranscriptEntry ?? journal.onTranscriptEntry)(entry, all);
    snapshotter.noteSettledStep(currentUrlSafe(session));
  };
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
      onTranscriptEntry,
      ...(opts.routeGlobs === undefined ? {} : { routeGlobs: opts.routeGlobs }),
      ...(opts.invariants === undefined ? {} : { invariants: opts.invariants }),
      ...(opts.invariantAuthTokens === undefined ? {} : { invariantAuthTokens: opts.invariantAuthTokens }),
      ...(opts.strategy === undefined ? {} : { strategy: opts.strategy }),
      ...(opts.stallTimeoutMs === undefined ? {} : { stallTimeoutMs: opts.stallTimeoutMs }),
      ...(opts.target?.safety === undefined ? {} : { safety: opts.target.safety }),
      overflow: {
        ...(opts.overflow?.checkOverflow === undefined ? {} : { checkOverflow: opts.overflow.checkOverflow }),
        ...(opts.overflow?.toleranceCss === undefined ? {} : { toleranceCss: opts.overflow.toleranceCss }),
        ...(opts.overflow?.ignoreSelectors === undefined ? {} : { ignoreSelectors: opts.overflow.ignoreSelectors }),
        ...(opts.emulation?.device === undefined ? {} : { device: opts.emulation.device }),
      },
      hostHealth: health,
    });

    // #149: every repro Recording (per-state, and each defect's own) is stamped with the emulation
    // it was found under, so `verify-fix` replays it under the SAME device by default.
    const emu = recordingEmulation(resolvedEmulation);
    const withEmu = (r: Recording): Recording => (emu === undefined ? r : { ...r, emulation: emu });
    const stampedDefects = result.coverage.defects.map((d) => ({ ...d, recording: withEmu(d.recording) }));
    const stampedCoverage = { ...result.coverage, defects: stampedDefects };
    const serverLogRun = serverLog === undefined ? undefined : await serverLog.finish(result.transcript);
    const recordingPaths: string[] = [];
    for (let i = 0; i < result.recordings.length; i++) {
      const p = join(outDir, `${filePrefix}-${stamp}-state-${i}.json`);
      await writeFile(p, `${JSON.stringify(withEmu(result.recordings[i]!), null, 2)}\n`, "utf8");
      recordingPaths.push(p);
    }
    journal.writeTranscript(serverLogRun?.transcript ?? result.transcript);
    // A silent run that never proved anything (the seed redirected off-target, or the frontier
    // spent its budget on controls that failed rather than exercising the target) is `inconclusive`,
    // never `clean` — mirrors the adversarial mission's coverage-sufficiency check (#69, #75, #82).
    // A declared-invariant violation (#86) is a hard defect, whatever the coverage.
    // #208: the shared HTTP 5xx hard signal's defects count like the strategy's own.
    const httpDefects = http5xx.defects(result.transcript);
    // #214: a `judgment-flagged-state` is advisory (Jev's opinion alone, guardrail #4): listed in
    // `defects`/`coverage.defects` with its repro, but it never counts toward `defects-found` — only a
    // defect an independent code oracle decided (overflow, invariant, 5xx, server-log) gates the run.
    const hardFrontier = gatingDefects(stampedDefects).length;
    const found = hardFrontier + (result.invariantDefects?.length ?? 0) + httpDefects.length;
    // Could not return to the seed, or stalled (#114): the run stopped short of its target — inconclusive.
    // #150 — a crossed mission spend budget is a deliberate, clean stop (not the run breaking): it
    // maps to `inconclusive`, but a defect found before it still wins, reported with `stop: "budget"`.
    const bare =
      result.outcome === "crashed"
        ? "crashed"
        : result.outcome === "scope-unreachable" || result.outcome === "stalled"
          ? "inconclusive"
          : // #203: a frontier drained by timed-out actions, or ended on a page hung only on a starved
            // host (no hang finding left), explored too little to be clean — a found defect still wins.
            result.outcome === "budget" || result.outcome === "insufficient-coverage" || (result.outcome === "hang" && result.hangs.length === 0)
            ? found > 0
              ? "defects-found"
              : "inconclusive"
            : null;
    const thin = bare === null && found === 0 && !result.coverage.sufficiency.sufficient;
    const preLogOutcome: MissionOutcome = combineOutcomes([
      bare ?? (thin ? "inconclusive" : found > 0 ? "defects-found" : "clean"),
      ...result.hangs.map((h) => hangOutcome(h.reproduction.status)),
    ]);
    // #142 follow-up: a server-log defect counts as `defects-found`; an unreadable `--log-defect`
    // oracle turns an otherwise-`clean` run `inconclusive` — never a false clean.
    const host = await finishHostHealth(health, applyServerLogOutcome(preLogOutcome, serverLogRun));
    const missionOutcome: MissionOutcome = host.outcome;
    const coverageFailure: MissionFailure | undefined = thin
      ? { kind: "insufficient-coverage", message: `coverage below thresholds: ${result.coverage.sufficiency.shortfalls.join("; ")}` }
      : undefined;
    const failure = result.failure ?? host.failure ?? coverageFailure;

    const exitCode = missionExitCode(missionOutcome);
    const typed = {
      schemaVersion: MISSION_RESULT_SCHEMA_VERSION,
      hangs: result.hangs,
      recording: null,
      target: {
        seedUrl: opts.url,
        allowlist: [...opts.allowlist],
        ...(opts.storageState !== undefined ? { storageStatePath: resolvePath(opts.storageState) } : {}),
      },
      timing: result.timing,
      strategy: opts.strategy ?? "coverage",
      // #213: the SCOPE line (#224's field) — the start route plus any --route/--scope app globs.
      scope: {
        routeGlobs: [...stampedCoverage.scope.routeGlobs],
        source: (opts.routeGlobs ?? []).some((g) => g.trim() !== "") ? ("route" as const) : ("start-url" as const),
      },
      coverage: stampedCoverage,
      // #209: a frontier that emptied having exercised too little to be clean is not `exhausted`
      // (that reads as "fully covered") — it is `insufficient-coverage`, the same word as its
      // `failure.kind`, so one ending has one name.
      outcome: thin && result.outcome === "exhausted" ? ("insufficient-coverage" as const) : result.outcome,
      missionOutcome,
      exitCode,
      ...(failure === undefined ? {} : { failure }),
      recordingPaths,
      transcriptPath: journal.transcriptPath,
      sideEffects: result.sideEffects ?? [],
      ...(result.sideEffectsTruncated === undefined ? {} : { sideEffectsTruncated: result.sideEffectsTruncated }),
      ...(result.budget === undefined ? {} : { budget: result.budget }),
      engine: currentEngineInfo(),
      ...declaredResult(opts.invariants, result.invariantDefects, result.invariants),
      ...(runUsage === undefined ? {} : { usage: runUsage.snapshot() }),
      ...serverLogResult(serverLogRun),
      // #209: EVERY defect in `defects` (#195) — the frontier's own (a horizontal overflow, a flagged
      // state; also in `coverage.defects`), then declared-invariant, then HTTP 5xx (#208), then server-log ones.
      defects: unifiedDefects<CoverageFrontierDefect | InvariantDefect | Http5xxDefect>(
        [
          // Slim: the repro Recording stays in `coverage.defects` (not copied twice into the result).
          ...stampedDefects.map(({ recording: _repro, reason, ...d }) => ({ ...d, title: reason })),
          ...(opts.invariants === undefined ? [] : (result.invariantDefects ?? [])),
          ...httpDefects,
        ],
        serverLogRun?.defects,
      ),
      resultPath: resultPathFor(journal.recordingPath),
      ...host.fields,
    };
    return { ...typed, resultPath: writeMissionResult(journal.recordingPath, missionOutcome, exitCode, typed, runUsage) };
  } finally {
    disarmKillSwitch();
    health.stop();
    await serverLog?.abort();
    await persistStorageState(session, opts.saveStorageState, snapshotter);
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
  /** Test seam (#203): the run's host-health sampler (a deterministic fake host). Default: this host's. */
  readonly hostHealth?: HostHealthSampler;
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
   * written with mode 0600, and its contents are never logged. See
   * `RunExplorationOptions.saveStorageState`'s own doc for the full behaviour (#159: written on
   * every exit path including a crash/kill signal, never over a lost/logged-out session).
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
  /** Where the Recording and decision transcript are written. Default `.jevitate/logs/<date>` (project, else `~/.jevitate`). */
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
  /** Per-mission viewport/device emulation (#149); see `RunExplorationOptions.emulation`. */
  readonly emulation?: EmulationSpec;
  /** Horizontal-overflow hard signal (#149, CLI `--check-overflow` / `--ignore-overflow`). */
  readonly overflow?: OverflowFlags;
}

export type AdversarialCliMissionResult = Omit<AdversarialOutcome, "defects"> & {
  /** The result schema's version (#195): the common fields are filled the same way by every strategy. */
  readonly schemaVersion: typeof MISSION_RESULT_SCHEMA_VERSION;
  readonly strategy: "adversarial";
  /** The portable verdict (equal to `outcome`, which an adversarial run already states as a `MissionOutcome`). */
  readonly missionOutcome: MissionOutcome;
  /** EVERY defect the run found (#195): hard-signal and declared-invariant defects, then `server-log` defects (#142). */
  readonly defects: Array<AdversarialDefect | ServerLogDefect>;
  /** Every Recording the run wrote (#195: one list on every strategy) — an adversarial run writes one. */
  readonly recordingPaths: string[];
  readonly target: MissionTarget;
  /** One ready-to-file draft per defect (and per crash), written next to the Recording. */
  readonly issues: FindingsIssues;
  /** @deprecated since 0.2.0 (#195) — use `recordingPaths[0]`; removed in the next minor. */
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
  /** @deprecated since 0.2.0 (#195) — the `server-log` subset of `defects`; removed in the next minor. */
  readonly serverLogDefects?: ServerLogDefect[];
  /** The host's health over the run (#203): peaks, the slowest render, starved steps. */
  readonly hostHealth: HostHealthSummary;
  /** Findings met while the host was starved (#203) — advisory, never a defect/hang, never failing the run. */
  readonly environmentDegraded: EnvironmentDegraded[];
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
  assertSaveStorageStateOutsideProject(opts.saveStorageState);
  // #224: the shared default scope (the start URL's route) must be derivable — refused up front.
  startRouteGlobs(opts.seedUrl);
  // #149: refused BEFORE any browser opens.
  const resolvedEmulation = resolveEmulation(opts.emulation);
  const portFactory = opts.browserPortFactory ?? (() => new PlaywrightBrowserPort());
  const port = portFactory();
  const launch = {
    headless: opts.headless ?? true,
    allowedOrigins: [...opts.allowlist],
    baseUrl: origin,
    ...opts.browser,
    ...opts.emulation,
    ...(opts.storageState !== undefined ? { storageState: opts.storageState } : {}),
  };
  const outDir = opts.outDir ?? logsDirFor();
  const iso = (opts.nowIso ?? (() => new Date().toISOString()))();
  // Crash-safe: the transcript and partial Recording are flushed after every step.
  const journal = new MissionJournal(join(outDir, `adversarial-${artifactStamp(iso)}.json`));
  // #163: this run's own share of a (possibly shared) tracker: its usage and sidecar.
  const runUsage = opts.usage?.scope();
  // #226: the kill switch is armed BEFORE the host sampler and the browser launch (see launch-armed.ts).
  const { disarmKillSwitch, health, session, snapshotter } = await launchArmed({
    hostHealth: opts.hostHealth,
    saveStorageState: opts.saveStorageState !== undefined,
    open: () => port.open(launch),
    mission: (hooks) => ({
      // #220: the killed run's partial result carries the unified schema's common fields too.
      strategy: "adversarial",
      target: { seedUrl: opts.seedUrl, allowlist: [...opts.allowlist], ...(opts.storageState !== undefined ? { storageStatePath: resolvePath(opts.storageState) } : {}) },
      recordingPath: journal.recordingPath,
      hostHealth: hooks.hostHealth,
      transcriptPath: journal.transcriptPath,
      transcript: () => journal.transcript,
      ...(runUsage === undefined ? {} : { usage: runUsage }),
      ...(opts.saveStorageState === undefined ? {} : { storageState: { path: opts.saveStorageState, snapshot: hooks.snapshot } }),
    }),
  });
  const serverLog = openServerLogRuntime({
    sources: opts.serverLog?.sources ?? [],
    logDefect: opts.serverLog?.logDefect ?? [],
    quietOk: opts.serverLog?.quietOk ?? [],
    logIgnore: opts.serverLog?.logIgnore ?? [],
    ...(opts.serverLog?.drainMs === undefined ? {} : { drainMs: opts.serverLog.drainMs }),
    secrets: opts.secrets ?? [],
    onTranscriptEntry: journal.onTranscriptEntry,
  });
  const onTranscriptEntry = (entry: TranscriptEntry, all: readonly TranscriptEntry[]): void => {
    health.noteStep(entry);
    (serverLog?.onTranscriptEntry ?? journal.onTranscriptEntry)(entry, all);
    snapshotter.noteSettledStep(currentUrlSafe(session));
  };
  try {
    const actor = CastActor.named("adversarial-mission").whoCan(new BrowseTheWeb(session, [...opts.allowlist]));
    const outcome = await runAdversarialMission({
      hostHealth: health,
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
      onTranscriptEntry,
      onRecording: journal.onRecording,
      ...(opts.invariants === undefined ? {} : { invariants: opts.invariants }),
      ...(opts.invariantAuthTokens === undefined ? {} : { invariantAuthTokens: opts.invariantAuthTokens }),
      overflow: {
        ...(opts.overflow?.checkOverflow === undefined ? {} : { checkOverflow: opts.overflow.checkOverflow }),
        ...(opts.overflow?.toleranceCss === undefined ? {} : { toleranceCss: opts.overflow.toleranceCss }),
        ...(opts.overflow?.ignoreSelectors === undefined ? {} : { ignoreSelectors: opts.overflow.ignoreSelectors }),
        ...(opts.emulation?.device === undefined ? {} : { device: opts.emulation.device }),
      },
    });
    const serverLogRun = serverLog === undefined ? undefined : await serverLog.finish(outcome.transcript);
    // `AdversarialOutcome.transcript` is a mutable `TranscriptEntry[]`; the correlated array only
    // ADDS an optional `serverLogs` field per entry (`TranscriptEntryWithLogs extends TranscriptEntry`).
    const transcript = (serverLogRun?.transcript ?? outcome.transcript) as TranscriptEntry[];
    journal.writeRecording(outcome.recording);
    journal.writeTranscript(transcript);
    // #142 follow-up: a server-log defect counts as `defects-found`; an unreadable `--log-defect`
    // oracle turns an otherwise-`clean` run `inconclusive` — never a false clean.
    const host = await finishHostHealth(health, applyServerLogOutcome(outcome.outcome, serverLogRun));
    const missionOutcome: MissionOutcome = host.outcome;
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
      schemaVersion: MISSION_RESULT_SCHEMA_VERSION,
      strategy: "adversarial" as const,
      missionOutcome,
      recordingPaths: [journal.recordingPath],
      // #149: stamped with the emulation the mission ran under, so verify-fix replays under it by default.
      recording:
        resolvedEmulation === undefined ? outcome.recording : { ...outcome.recording, emulation: recordingEmulation(resolvedEmulation) },
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
      ...(runUsage === undefined ? {} : { usage: runUsage.snapshot() }),
      ...serverLogResult(serverLogRun),
      defects: unifiedDefects(outcome.defects, serverLogRun?.defects),
      resultPath,
      ...(host.failure === undefined || outcome.failure !== undefined ? {} : { failure: host.failure }),
      ...host.fields,
    };
    return { ...result, resultPath: writeMissionResult(journal.recordingPath, missionOutcome, exitCode, result, runUsage) };
  } finally {
    disarmKillSwitch();
    health.stop();
    await serverLog?.abort();
    await persistStorageState(session, opts.saveStorageState, snapshotter);
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
  /** Test seam (#203): the run's host-health sampler (a deterministic fake host). Default: this host's. */
  readonly hostHealth?: HostHealthSampler;
  readonly seedUrl: string;
  readonly allowlist: readonly string[];
  readonly capability: string;
  /**
   * The `--route` globs, used exactly as given. Empty/absent (#224): the start URL's route and
   * everything under it — the default every strategy shares (`resolveRouteScope`), stated in the
   * result's `scope`. A start URL no default can be derived from is refused up front
   * (`ScopeUnderivableError`, a usage error) before any browser opens.
   */
  readonly routeGlobs?: readonly string[];
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
  /** Where the recordings, transcript and typed result are written. Default `.jevitate/logs/<date>` (project, else `~/.jevitate`). */
  readonly outDir?: string;
  /** ISO clock for output filenames. Default `Date.now()`. */
  readonly nowIso?: () => string;
  /**
   * Writes the browser context's storageState (cookies + origin storage) here when the run ends
   * (CLI `--save-storage-state`) — so a rotating refresh token stays usable across runs instead of
   * invalidating `--storage-state`'s file on first use. The file holds live session credentials:
   * written with mode 0600, and its contents are never logged. See
   * `RunExplorationOptions.saveStorageState`'s own doc for the full behaviour (#159: written on
   * every exit path including a crash/kill signal, never over a lost/logged-out session).
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
  /** Per-mission viewport/device emulation (#149); see `RunExplorationOptions.emulation`. */
  readonly emulation?: EmulationSpec;
}

/** The feature mission's result plus its typed verdict, exit code, and where its artifacts landed. */
export type FeatureCliMissionResult = Omit<FeatureRunResult, "outcome"> & {
  /** The frontier's ending — `insufficient-coverage` (#209) when it emptied having proved nothing about the feature. */
  readonly outcome: FeatureRunResult["outcome"] | "insufficient-coverage";
  /** The result schema's version (#195): the common fields are filled the same way by every strategy. */
  readonly schemaVersion: typeof MISSION_RESULT_SCHEMA_VERSION;
  readonly strategy: "feature";
  /** The route scope the run used (#224): the `--route` globs, or the one derived from the start URL. */
  readonly scope: MissionRouteScope;
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
  /** EVERY defect the run found (#195): declared-invariant defects (#86, each with its own path Recording) and `server-log` defects (#142). */
  readonly defects: Array<InvariantDefect | Http5xxDefect | ServerLogDefect>;
  readonly invariantSpec?: InvariantSpec;
  /** Backend log correlation summary (#142) — present only when `--log-source` was given. */
  readonly serverLogs?: ServerLogsSummary;
  /** @deprecated since 0.2.0 (#195) — the `server-log` subset of `defects`; removed in the next minor. */
  readonly serverLogDefects?: ServerLogDefect[];
  /** Always zero (#188): a feature mission makes no model call — stated, never absent ("not tracked"). */
  readonly usage: UsageCounts;
  /** The host's health over the run (#203): peaks, the slowest render, starved steps. */
  readonly hostHealth: HostHealthSummary;
  /** Findings met while the host was starved (#203) — advisory, never a defect/hang, never failing the run. */
  readonly environmentDegraded: EnvironmentDegraded[];
};

/** A model-free mission's usage (#188): nothing called, nothing to price — a known $0. */
export const NO_MODEL_USAGE: UsageCounts = {
  judgments: 0,
  generations: 0,
  inputTokens: 0,
  outputTokens: 0,
  totalUsd: 0,
  priced: "full",
  priceSource: ["no model call"],
};

export async function runFeatureCliMission(opts: RunFeatureCliMissionOptions): Promise<FeatureCliMissionResult> {
  // Guardrail #1 — authorize BEFORE opening a browser. Throws on refusal.
  const origin = assertAuthorizedExploreTarget(opts.seedUrl, opts.allowlist);
  assertSaveStorageStateOutsideProject(opts.saveStorageState);
  // #224: no --route → the start URL's route (the shared default); refused up front when underivable.
  const routeScope = resolveRouteScope(opts.seedUrl, opts.routeGlobs);
  const scope: CapabilityScope = { name: opts.capability, originAllowlist: opts.allowlist, routeGlobs: routeScope.routeGlobs };

  // #149: refused BEFORE any browser opens.
  resolveEmulation(opts.emulation);
  const portFactory = opts.browserPortFactory ?? (() => new PlaywrightBrowserPort());
  const launch = {
    headless: opts.headless ?? true,
    allowedOrigins: [...opts.allowlist],
    baseUrl: origin,
    ...opts.browser,
    ...opts.emulation,
    ...(opts.storageState !== undefined ? { storageState: opts.storageState } : {}),
  };
  // Persist recordings + transcript + a typed result, like the goal and
  // coverage missions do (ticket #78 — previously nothing was written).
  const outDir = opts.outDir ?? logsDirFor();
  const iso = (opts.nowIso ?? (() => new Date().toISOString()))();
  const stamp = artifactStamp(iso);
  const journal = new MissionJournal(join(outDir, `feature-${stamp}.json`));
  // #226: the kill switch is armed BEFORE the host sampler and the browser launch (see launch-armed.ts).
  const { disarmKillSwitch, health, session, snapshotter } = await launchArmed({
    hostHealth: opts.hostHealth,
    saveStorageState: opts.saveStorageState !== undefined,
    open: () => portFactory().open(launch),
    mission: (hooks) => ({
      // #220: the killed run's partial result carries the unified schema's common fields too.
      strategy: "feature",
      target: { seedUrl: opts.seedUrl, allowlist: [...opts.allowlist], ...(opts.storageState !== undefined ? { storageStatePath: resolvePath(opts.storageState) } : {}) },
      recordingPath: journal.recordingPath,
      hostHealth: hooks.hostHealth,
      transcriptPath: journal.transcriptPath,
      transcript: () => journal.transcript,
      ...(opts.saveStorageState === undefined ? {} : { storageState: { path: opts.saveStorageState, snapshot: hooks.snapshot } }),
    }),
  });
  // #208: the shared HTTP 5xx hard signal, listening from before the first navigation.
  const http5xx = new Http5xxOracle(session.page, { allowlist: opts.allowlist });
  const serverLog = openServerLogRuntime({
    sources: opts.serverLog?.sources ?? [],
    logDefect: opts.serverLog?.logDefect ?? [],
    quietOk: opts.serverLog?.quietOk ?? [],
    logIgnore: opts.serverLog?.logIgnore ?? [],
    ...(opts.serverLog?.drainMs === undefined ? {} : { drainMs: opts.serverLog.drainMs }),
    secrets: [],
    onTranscriptEntry: journal.onTranscriptEntry,
  });
  const onTranscriptEntry = (entry: TranscriptEntry, all: readonly TranscriptEntry[]): void => {
    health.noteStep(entry);
    http5xx.noteStep(entry);
    (serverLog?.onTranscriptEntry ?? journal.onTranscriptEntry)(entry, all);
    snapshotter.noteSettledStep(currentUrlSafe(session));
  };
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
      onTranscriptEntry,
      ...(opts.invariants === undefined ? {} : { invariants: opts.invariants }),
      ...(opts.invariantAuthTokens === undefined ? {} : { invariantAuthTokens: opts.invariantAuthTokens }),
      ...(opts.stallTimeoutMs === undefined ? {} : { stallTimeoutMs: opts.stallTimeoutMs }),
      ...(opts.safety === undefined ? {} : { safety: opts.safety }),
      hostHealth: health,
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
    const chromeOnly = result.outcome !== "crashed" && result.coverage.inScopeActionsExercised === 0;
    // #209: in-scope, non-chrome controls were exercised — but none of them had anything to do with
    // the named capability (every one at relevance=0 against its words). That proves no more about
    // it than the chrome-only case: `inconclusive`, never `clean`.
    const words = result.coverage.featureWords;
    const irrelevant = !chromeOnly && result.outcome !== "crashed" && words.length > 0 && result.coverage.relevantActionsExercised === 0;
    const thin = chromeOnly || irrelevant;
    const coverageFailure: MissionFailure | undefined = chromeOnly
      ? {
          kind: "insufficient-coverage",
          message: `no in-scope, non-chrome control of "${opts.capability}" was exercised within route(s) [${routeScope.routeGlobs.join(", ")}]${
            routeScope.source === "start-url" ? " (derived from the start URL)" : ""
          } — ${result.coverage.boundaryEdges.length} boundary edge(s) hit instead${refusalNote(safetyRefusalsFromTranscript(result.transcript))}`,
        }
      : irrelevant
        ? {
            kind: "insufficient-coverage",
            message: `no control relevant to "${opts.capability}" was exercised: all ${result.coverage.inScopeActionsExercised} in-scope action(s) were on controls at relevance=0 (none named with ${words.map((w) => `"${w}"`).join(", ")}) — name the feature with the words its controls use, or point --url/--route at the page that has them`,
          }
        : undefined;
    // A declared-invariant violation (#86) is a hard defect even on a thin run: it was observed.
    // #208: the shared HTTP 5xx hard signal's defects count like declared-invariant ones.
    const httpDefects = http5xx.defects(result.transcript);
    const hardDefects = (result.invariantDefects?.length ?? 0) + httpDefects.length;
    // #150 — a crossed mission spend budget is a deliberate, clean stop (not the run breaking): it
    // maps to `inconclusive`, but a defect found before it still wins, reported with `stop: "budget"`.
    const preLogOutcome: MissionOutcome = combineOutcomes([
      result.outcome === "crashed"
        ? "crashed"
        : result.outcome === "scope-unreachable" || result.outcome === "stalled"
          ? "inconclusive"
          : result.outcome === "budget"
            ? hardDefects > 0
              ? "defects-found"
              : "inconclusive"
            : hardDefects > 0
              ? "defects-found"
              : thin
                ? "inconclusive"
                : "clean",
      ...result.hangs.map((h) => hangOutcome(h.reproduction.status)),
    ]);
    // #142 follow-up: a server-log defect counts as `defects-found`; an unreadable `--log-defect`
    // oracle turns an otherwise-`clean` run `inconclusive` — never a false clean.
    const host = await finishHostHealth(health, applyServerLogOutcome(preLogOutcome, serverLogRun));
    const missionOutcome: MissionOutcome = host.outcome;
    const exitCode = missionExitCode(missionOutcome);
    const typed = {
      ...result,
      // #209: one name — a frontier that emptied having proved nothing about the feature is not
      // `exhausted` ("fully covered"): it is `insufficient-coverage`, the same word as its failure.kind.
      outcome: thin && result.outcome === "exhausted" ? ("insufficient-coverage" as const) : result.outcome,
      schemaVersion: MISSION_RESULT_SCHEMA_VERSION,
      strategy: "feature" as const,
      scope: routeScope,
      transcript: (serverLogRun?.transcript ?? result.transcript) as TranscriptEntry[],
      failure: result.failure ?? host.failure ?? coverageFailure,
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
      defects: unifiedDefects<InvariantDefect | Http5xxDefect>(
        [...(opts.invariants === undefined ? [] : (result.invariantDefects ?? [])), ...httpDefects],
        serverLogRun?.defects,
      ),
      resultPath: resultPathFor(journal.recordingPath),
      usage: NO_MODEL_USAGE,
      ...host.fields,
    };
    return { ...typed, resultPath: writeMissionResult(journal.recordingPath, missionOutcome, exitCode, typed) };
  } finally {
    disarmKillSwitch();
    health.stop();
    await serverLog?.abort();
    await persistStorageState(session, opts.saveStorageState, snapshotter);
    await closeQuietly(session);
  }
}
