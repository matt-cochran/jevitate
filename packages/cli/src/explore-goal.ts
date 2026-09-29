// explore-goal.ts — the goal-directed explore runner (`runExploration`) and its goal-only helpers (#231).
import { sessionLostReason } from "./session-check.js";
import { logsDirFor } from "./project-dir.js";
import { join, resolve as resolvePath } from "node:path";
import type { JudgmentPort, GenerationPort, UsageTracker, UsageCounts } from "@jevitate/ai-core";
import { PlaywrightBrowserPort, resolveEmulation, type BrowserPort, type EmulationSpec } from "@jevitate/playwright";
import { closeOnce, demoOverlayOf, finalizeVideos, runVideoDir, sessionLaunchOptions, type BrowserRunOptions } from "./browser-run-options.js";
import { runCaptureFor, type ScreenshotsSpec } from "./run-screenshots.js";
import { evidenceOf, withRunEvidence } from "./defect-evidence.js";
import { CastActor, BrowseTheWeb } from "@jevitate/screenplay";
import { type Assertion, type InvariantSpec, type Recording } from "@jevitate/recording";
import type { HostHealthSampler, InvariantDefect, InvariantReport, SideEffect } from "@jevitate/explore";
import type { EnvironmentDegraded, HostHealthSummary } from "@jevitate/domain";
import { runGoalBasedMission, assertAuthorizedExploreTarget, resolveMissionFixture, type Bounds, type GoalBasedOutcome, type StopReason, type TranscriptEntry, type RunAnswer, type RunOutcome, type SuccessCheck, type SuccessCheckResult, type SuccessWhen, type SecretField, type BudgetTrajectory, type CrashReport, type Http5xxDefect, Http5xxOracle, secretFieldSecrets } from "@jevitate/explore";
import { conversationConfig, type ConversationOptions } from "./conversation-options.js";
import { foldGoalOutcome, type FilingConfig, type IssueDraft, type IssueFilerPort, type MissionFailure, type MissionOutcome } from "@jevitate/domain";
import { draftForCrash, draftForHang, type HangFinding, type TimingSummary } from "@jevitate/explore";
import { processIssueDrafts, type FindingsIssues } from "./findings-filing.js";
import { currentEngineInfo, type EngineInfo } from "./engine.js";
import type { TargetConfig } from "./target-config.js";
import { MissionJournal, artifactStamp, closeQuietly, resultPathFor, writeMissionResult } from "./mission-journal.js";
import { MISSION_RESULT_SCHEMA_VERSION, unifiedDefects } from "./result-schema.js";
import { applyHttp5xxGoalOutcome, describeHttp5xx, http5xxGoalReason } from "./http-5xx-outcome.js";
import { goalExitCode } from "./mission-exit.js";
import { launchArmed } from "./launch-armed.js";
import { finishHostHealth } from "./host-health-run.js";
import { openServerLogRuntime, type ServerLogDefect, type ServerLogEvidence, type ServerLogRuntimeResult, type ServerLogsSummary, type TranscriptEntryWithLogs } from "./log-correlation.js";
import { fixtureReplayOpener, recordingFixture, type MissionFixtureResult, type MissionFixtures } from "./mission-fixtures.js";
import { observerSessions, persistedActors, type MissionActors } from "./mission-actors.js";
import { type ServerLogOptions, serverLogResult, recordingEmulation, DRAFTS_ONLY, NO_FILER, draftContext, freshSessionOpener, currentUrlSafe, assertSaveStorageStateOutsideProject, persistStorageState, browserVersionOf, type MissionTarget, declaredResult } from "./explore-shared.js";

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
  /** #245: `--record-video` files, finalized before this result was written (absent when not recording). */
  readonly videoPaths?: string[];
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
  // #250/#251: a recorded or screenshotted run's sessions carry the live pixel mask from their first
  // paint; `--screenshots` captures after each step (the Recording path names their folder).
  const capture = runCaptureFor({
    recordsVideo: opts.browser?.recordVideo !== undefined,
    screenshots: opts.screenshots,
    secrets: secrets ?? [],
    artifactPath: () => journal.recordingPath,
    title: `goal: ${opts.goal}`,
  });
  const portFactory = capture.wrap(opts.browserPortFactory ?? (() => new PlaywrightBrowserPort()));
  const port = portFactory();
  const outDir = opts.outDir ?? logsDirFor();
  const iso = (opts.nowIso ?? (() => new Date().toISOString()))();
  // Crash-safe: the transcript and partial Recording are flushed after every step. `MissionJournal`
  // itself creates `outDir` synchronously (mkdirSync).
  const journal = new MissionJournal(join(outDir, `explore-${artifactStamp(iso)}.json`));
  // #245: every session this run opens (mission, observers, hang replays) is shown/recorded alike.
  const videoDir = runVideoDir(opts.browser, journal.recordingPath);
  const shown = sessionLaunchOptions(opts.browser, videoDir);
  const launch = {
    ...shown,
    allowedOrigins: [...opts.allowlist],
    baseUrl: origin,
    ...opts.emulation,
    ...(primaryState !== undefined ? { storageState: primaryState } : {}),
  };
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
      ...(videoDir === undefined ? {} : { videoDir }),
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
      : observerSessions(portFactory, { ...shown, allowedOrigins: [...opts.allowlist], baseUrl: origin }, opts.actors.observers);
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
    capture.noteEntry(session.page, entry);
    health.noteStep(entry);
    http5xx.noteStep(entry);
    (serverLog?.onTranscriptEntry ?? journal.onTranscriptEntry)(entry, all);
    snapshotter.noteSettledStep(currentUrlSafe(session));
  };
  // #159/#245: persisted and closed once — early (before the result is written) when recording video.
  const closeSession = closeOnce(async () => {
    await persistStorageState(session, opts.saveStorageState, snapshotter);
    await closeQuietly(session);
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
      demoOverlay: demoOverlayOf(opts.browser),
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
    const httpDefects = http5xx.defects(mission.transcript, mission.recording.pages.flatMap((p) => p.steps)[0]?.step.kind === "navigate" ? 1 : 0);
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
    // #245: every context closed (videos finalized) before the result naming them is written.
    const shotFields = await capture.finish();
    const videos = await finalizeVideos(videoDir, closeSession);

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
      ...videos,
      ...shotFields,
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
    return await withRunEvidence(result, evidenceOf(opts, secrets ?? []));
  } finally {
    disarmKillSwitch();
    health.stop();
    // Safety net: if the mission threw before `serverLog.finish()` ran, close sources immediately
    // (no drain wait) rather than leaving them open until process exit.
    await serverLog?.abort();
    await observers?.close().catch(() => undefined);
    await closeSession();
  }
}
