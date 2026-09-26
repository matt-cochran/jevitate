import { chmod, writeFile } from "node:fs/promises";
import { logsDirFor } from "./project-dir.js";
import { join, resolve as resolvePath } from "node:path";
import type { JudgmentPort, GenerationPort, CredentialKey, UsageTracker, UsageCounts } from "@jevitate/ai-core";
import { PlaywrightBrowserPort, resolveEmulation, type BrowserLaunchOptions, type BrowserPort, type EmulationSpec } from "@jevitate/playwright";
import { CastActor, BrowseTheWeb } from "@jevitate/screenplay";
import {
  AssertionSchema,
  STYLE_CHANNELS,
  STYLE_PROPERTIES,
  COMPARE_OPS,
  type Assertion,
  type CompareOp,
  type InvariantSpec,
  type Recording,
  type RecordingEmulation,
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
  type AdversarialDefect,
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
  type BudgetTrajectory,
  type CrashReport,
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
  isLoginLikeUrl,
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
import { MISSION_RESULT_SCHEMA_VERSION, unifiedDefects } from "./result-schema.js";
import { goalExitCode, missionExitCode } from "./mission-exit.js";
import { armMissionKillSwitch } from "./kill-signal.js";
import { StorageStateSnapshotter } from "./storage-state-snapshot.js";
import {
  applyServerLogOutcome,
  openServerLogRuntime,
  type ServerLogDefect,
  type ServerLogEvidence,
  type ServerLogRuntimeResult,
  type ServerLogsSummary,
  type TranscriptEntryWithLogs,
} from "./log-correlation.js";
import type { LogSourceSpec } from "./log-sources.js";
import type { LogDefectMatcher, LogIgnoreMatcher } from "./log-lines.js";
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
  /** Raw `--log-source` specs (`--log-quiet-ok`, #169) allowed to deliver zero lines without making
   *  `serverLogs.oracleOk` false — for a source the operator KNOWS is legitimately quiet. */
  readonly quietOk?: readonly string[];
  /** Already-parsed `--log-ignore` matchers (#169 item 3): known-noise lines excluded from
   *  correlation and the defect oracle. */
  readonly logIgnore?: readonly LogIgnoreMatcher[];
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
 * the emitted `Recording` under `.jevitate/logs/<date>`.
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

/**
 * Overflow/emulation CLI flags shared by every strategy (#149): `emulation` is validated and
 * resolved by `PlaywrightBrowserPort.open` itself (an unknown device or --viewport+--device
 * together refuses BEFORE any browser opens); `overflow` gates and configures the horizontal-
 * overflow hard signal (coverage only, for now).
 */
export interface OverflowFlags {
  readonly checkOverflow?: boolean;
  readonly toleranceCss?: number;
  readonly ignoreSelectors?: readonly string[];
}

/** The viewport/device emulation actually applied to a session — recorded on the Recording (#149). */
function recordingEmulation(
  resolved: { viewport: { width: number; height: number }; device?: string; deviceScaleFactor?: number; isMobile?: boolean; hasTouch?: boolean } | undefined,
): RecordingEmulation | undefined {
  if (resolved === undefined) return undefined;
  return {
    viewport: resolved.viewport,
    ...(resolved.device === undefined ? {} : { device: resolved.device }),
    ...(resolved.deviceScaleFactor === undefined ? {} : { deviceScaleFactor: resolved.deviceScaleFactor }),
    ...(resolved.isMobile === undefined ? {} : { isMobile: resolved.isMobile }),
    ...(resolved.hasTouch === undefined ? {} : { hasTouch: resolved.hasTouch }),
  };
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

/** `session.page.url()`, or `undefined` when reading it throws (a closed/crashed page/context). */
export function currentUrlSafe(session: { page: { url(): string } }): string | undefined {
  try {
    return session.page.url();
  } catch {
    return undefined;
  }
}

/**
 * Writes the browser context's storageState (cookies + origin storage) to `file` when the caller
 * asked for one (CLI `--save-storage-state`, #82) — so a rotating refresh token stays usable across
 * runs instead of the `--storage-state` file it started from going stale on first use. Called from
 * every mission's `finally`, so a thrown error still reaches it (#159) — the context is still open at
 * that point, whatever failed inside the mission itself. A no-op when `file` is undefined.
 *
 * #159 — never persists a lost/logged-out session over a good file: when the CURRENT page looks
 * login-like (`isLoginLikeUrl`, the #82 signal), a live capture is skipped in favor of `snapshotter`'s
 * last known-good in-memory snapshot (refreshed after each settled step — see
 * `storage-state-snapshot.ts` — and itself never updated from a login-like page, so it always holds
 * the most recent GOOD state). The same fallback covers a live capture that simply fails (a
 * crashed/closed context after the page url could still be read). If neither a safe live capture nor
 * a snapshot is available, nothing is written — any existing file at `file` is left untouched. There
 * is no flag today for an operator to force the write anyway; see `saveStorageState`'s own doc.
 *
 * The file holds live session credentials: written with mode 0600 (owner read/write only), and its
 * contents are never logged either way.
 */
export async function persistStorageState(
  session: { page: { url(): string }; saveStorageState(file: string): Promise<void> },
  file: string | undefined,
  snapshotter?: StorageStateSnapshotter,
): Promise<void> {
  if (file === undefined) return;
  const url = currentUrlSafe(session);
  if (url === undefined || !isLoginLikeUrl(url)) {
    try {
      await session.saveStorageState(file);
      await chmod(file, 0o600);
      return;
    } catch {
      // A crashed/closed context, or a mid-write failure — fall back to the last known-good snapshot.
    }
  }
  const fallback = snapshotter?.snapshot();
  if (fallback === undefined) return;
  await writeFile(file, fallback, { encoding: "utf8", mode: 0o600 });
}

function browserVersionOf(page: { context(): { browser(): { version(): string } | null } }): string | undefined {
  try {
    return page.context().browser()?.version();
  } catch {
    return undefined;
  }
}

export interface RunExplorationResult {
  /** The result schema's version (#195): the common fields below are filled the same way by every strategy. */
  readonly schemaVersion: typeof MISSION_RESULT_SCHEMA_VERSION;
  readonly strategy: "goal";
  /** The portable verdict (a goal run's own vocabulary; equal to `outcome`). */
  readonly missionOutcome: GoalBasedOutcome;
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
   * EVERY defect the run found (#195): declared-invariant defects (#86, with `--invariants`) and
   * `server-log` defects (#142, with `--log-defect`) — `verify-fix` replays any of them by fingerprint.
   */
  readonly defects: Array<InvariantDefect | ServerLogDefect>;
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
const BLOCKED_LIKE_OUTCOMES: ReadonlySet<GoalBasedOutcome> = new Set(["blocked", "exhausted", "inconclusive"]);
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
  const session = await port.open(launch);
  // #147: each observer in its OWN fresh context (only its own storageState), opened on first use.
  const observers =
    opts.actors === undefined || opts.actors.observers.length === 0
      ? undefined
      : observerSessions(portFactory, { headless: true, allowedOrigins: [...opts.allowlist], baseUrl: origin, ...opts.browser }, opts.actors.observers);

  const outDir = opts.outDir ?? logsDirFor();
  const iso = (opts.nowIso ?? (() => new Date().toISOString()))();
  // Crash-safe: the transcript and partial Recording are flushed after every step. `MissionJournal`
  // itself creates `outDir` synchronously (mkdirSync) — no `await` here, so there is no gap between
  // the browser opening and the kill switch arming below for a SIGTERM/SIGINT to land in unarmed.
  const journal = new MissionJournal(join(outDir, `explore-${artifactStamp(iso)}.json`));
  // Crash-safe on SIGTERM/SIGINT too (#94): a partial `inconclusive` result is written from
  // whatever the journal has already flushed, and the process exits with the conventional code.
  // #163: this run's own share of a (possibly shared) tracker: its usage and sidecar.
  const runUsage = opts.usage?.scope();
  // #159: refreshed after each settled step below; the kill switch writes whatever this holds
  // synchronously on SIGTERM/SIGINT (it cannot await a live capture — see kill-signal.ts).
  const snapshotter = new StorageStateSnapshotter(session, opts.saveStorageState !== undefined);
  const disarmKillSwitch = armMissionKillSwitch({
    recordingPath: journal.recordingPath,
    transcriptPath: journal.transcriptPath,
    transcript: () => journal.transcript,
    ...(runUsage === undefined ? {} : { usage: runUsage }),
    ...(opts.saveStorageState === undefined
      ? {}
      : { storageState: { path: opts.saveStorageState, snapshot: () => snapshotter.snapshot() } }),
  });
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
    const recording: Recording = {
      ...mission.recording,
      ...(missionFixture === undefined ? {} : { fixture: recordingFixture(missionFixture.record) }),
      ...(resolvedEmulation === undefined ? {} : { emulation: recordingEmulation(resolvedEmulation) }),
    };
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
      schemaVersion: MISSION_RESULT_SCHEMA_VERSION,
      strategy: "goal",
      missionOutcome: goalOutcome,
      issues,
      timing: mission.run.timing,
      outcome: goalOutcome,
      runOutcome: mission.run.outcome,
      ...(mission.run.answer === undefined ? {} : { answer: mission.run.answer }),
      assertionPassed: mission.assertionPassed,
      checks: mission.checks,
      ...(mission.warnings === undefined ? {} : { checkWarnings: mission.warnings }),
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
      ...(mission.run.failure === undefined ? {} : { failure: mission.run.failure }),
      ...(goalOutcome === mission.outcome
        ? (() => {
            const reason = withServerCause(mission.reason, goalOutcome, serverLogRun?.transcript);
            return reason === undefined ? {} : { reason };
          })()
        : { reason: serverLogOutcomeReason(goalOutcome, serverLogRun) }),
      ...declaredResult(opts.invariants, mission.invariantDefects, mission.invariants),
      ...(runUsage === undefined ? {} : { usage: runUsage.snapshot() }),
      ...serverLogResult(serverLogRun),
      defects: unifiedDefects(opts.invariants === undefined ? undefined : mission.invariantDefects, serverLogRun?.defects),
    };
    // Persisted so `verify-fix` can replay a hang later (the typed result next to the Recording).
    writeMissionResult(journal.recordingPath, goalOutcome, result.exitCode, result, runUsage);
    return result;
  } finally {
    disarmKillSwitch();
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

export interface RunCoverageMissionResult {
  /** The result schema's version (#195): the common fields are filled the same way by every strategy. */
  readonly schemaVersion: typeof MISSION_RESULT_SCHEMA_VERSION;
  /** Which frontier ran: `coverage` (breadth) or `exploratory` (novelty-first) — the file prefix is `coverage-` for both. */
  readonly strategy: "coverage" | "exploratory";
  readonly coverage: CoverageReport;
  readonly outcome: "exhausted" | "cap" | "crashed" | "hang" | "scope-unreachable" | "stalled" | "budget";
  /** Hangs met while exploring (deduped), each with its reproduction and its own path Recording. */
  readonly hangs: HangFinding[];
  /** Declared mission spend budgets (#150/#180): the observed trajectory, whatever the outcome. */
  readonly budget?: BudgetTrajectory[];
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
  /**
   * EVERY defect the run found (#195): declared-invariant defects (#86, each with its own path
   * Recording) and `server-log` defects (#142). Jev-flagged states stay advisory in `coverage.defects`.
   */
  readonly defects: Array<InvariantDefect | ServerLogDefect>;
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
  const session = await port.open(launch);

  const outDir = opts.outDir ?? logsDirFor();
  const iso = (opts.nowIso ?? (() => new Date().toISOString()))();
  const stamp = artifactStamp(iso);
  // `MissionJournal` creates `outDir` synchronously (mkdirSync) — no `await` between the browser
  // opening and the kill switch arming below, so there is no gap for a signal to land in unarmed.
  const journal = new MissionJournal(join(outDir, `coverage-${stamp}.json`));
  // #163: this run's own share of a (possibly shared) tracker: its usage and sidecar.
  const runUsage = opts.usage?.scope();
  // #159: see runExploration's own doc comment on the equivalent lines.
  const snapshotter = new StorageStateSnapshotter(session, opts.saveStorageState !== undefined);
  const disarmKillSwitch = armMissionKillSwitch({
    recordingPath: journal.recordingPath,
    transcriptPath: journal.transcriptPath,
    transcript: () => journal.transcript,
    ...(runUsage === undefined ? {} : { usage: runUsage }),
    ...(opts.saveStorageState === undefined
      ? {}
      : { storageState: { path: opts.saveStorageState, snapshot: () => snapshotter.snapshot() } }),
  });
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
      const p = join(outDir, `coverage-${stamp}-state-${i}.json`);
      await writeFile(p, `${JSON.stringify(withEmu(result.recordings[i]!), null, 2)}\n`, "utf8");
      recordingPaths.push(p);
    }
    journal.writeTranscript(serverLogRun?.transcript ?? result.transcript);
    // A silent run that never proved anything (the seed redirected off-target, or the frontier
    // spent its budget on controls that failed rather than exercising the target) is `inconclusive`,
    // never `clean` — mirrors the adversarial mission's coverage-sufficiency check (#69, #75, #82).
    // A declared-invariant violation (#86) is a hard defect, whatever the coverage.
    const found = stampedDefects.length + (result.invariantDefects?.length ?? 0);
    // Could not return to the seed, or stalled (#114): the run stopped short of its target — inconclusive.
    // #150 — a crossed mission spend budget is a deliberate, clean stop (not the run breaking): it
    // maps to `inconclusive`, but a defect found before it still wins, reported with `stop: "budget"`.
    const bare =
      result.outcome === "crashed"
        ? "crashed"
        : result.outcome === "scope-unreachable" || result.outcome === "stalled"
          ? "inconclusive"
          : result.outcome === "budget"
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
    const missionOutcome = applyServerLogOutcome(preLogOutcome, serverLogRun);
    const coverageFailure: MissionFailure | undefined = thin
      ? { kind: "insufficient-coverage", message: `coverage below thresholds: ${result.coverage.sufficiency.shortfalls.join("; ")}` }
      : undefined;
    const failure = result.failure ?? coverageFailure;

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
      coverage: stampedCoverage,
      outcome: result.outcome,
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
      defects: unifiedDefects(opts.invariants === undefined ? undefined : result.invariantDefects, serverLogRun?.defects),
      resultPath: resultPathFor(journal.recordingPath),
    };
    return { ...typed, resultPath: writeMissionResult(journal.recordingPath, missionOutcome, exitCode, typed, runUsage) };
  } finally {
    disarmKillSwitch();
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
  const session = await port.open(launch);
  const outDir = opts.outDir ?? logsDirFor();
  const iso = (opts.nowIso ?? (() => new Date().toISOString()))();
  // Crash-safe: the transcript and partial Recording are flushed after every step.
  const journal = new MissionJournal(join(outDir, `adversarial-${artifactStamp(iso)}.json`));
  // #163: this run's own share of a (possibly shared) tracker: its usage and sidecar.
  const runUsage = opts.usage?.scope();
  // #159: see runExploration's own doc comment on the equivalent lines.
  const snapshotter = new StorageStateSnapshotter(session, opts.saveStorageState !== undefined);
  const disarmKillSwitch = armMissionKillSwitch({
    recordingPath: journal.recordingPath,
    transcriptPath: journal.transcriptPath,
    transcript: () => journal.transcript,
    ...(runUsage === undefined ? {} : { usage: runUsage }),
    ...(opts.saveStorageState === undefined
      ? {}
      : { storageState: { path: opts.saveStorageState, snapshot: () => snapshotter.snapshot() } }),
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
    (serverLog?.onTranscriptEntry ?? journal.onTranscriptEntry)(entry, all);
    snapshotter.noteSettledStep(currentUrlSafe(session));
  };
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
    };
    return { ...result, resultPath: writeMissionResult(journal.recordingPath, missionOutcome, exitCode, result, runUsage) };
  } finally {
    disarmKillSwitch();
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
export type FeatureCliMissionResult = FeatureRunResult & {
  /** The result schema's version (#195): the common fields are filled the same way by every strategy. */
  readonly schemaVersion: typeof MISSION_RESULT_SCHEMA_VERSION;
  readonly strategy: "feature";
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
  readonly defects: Array<InvariantDefect | ServerLogDefect>;
  readonly invariantSpec?: InvariantSpec;
  /** Backend log correlation summary (#142) — present only when `--log-source` was given. */
  readonly serverLogs?: ServerLogsSummary;
  /** @deprecated since 0.2.0 (#195) — the `server-log` subset of `defects`; removed in the next minor. */
  readonly serverLogDefects?: ServerLogDefect[];
  /** Always zero (#188): a feature mission makes no model call — stated, never absent ("not tracked"). */
  readonly usage: UsageCounts;
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
  const scope: CapabilityScope = { name: opts.capability, originAllowlist: opts.allowlist, routeGlobs: opts.routeGlobs };

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
  const session = await portFactory().open(launch);

  // Persist recordings + transcript + a typed result, like the goal and
  // coverage missions do (ticket #78 — previously nothing was written).
  const outDir = opts.outDir ?? logsDirFor();
  const iso = (opts.nowIso ?? (() => new Date().toISOString()))();
  const stamp = artifactStamp(iso);
  const journal = new MissionJournal(join(outDir, `feature-${stamp}.json`));
  // #159: see runExploration's own doc comment on the equivalent lines.
  const snapshotter = new StorageStateSnapshotter(session, opts.saveStorageState !== undefined);
  const disarmKillSwitch = armMissionKillSwitch({
    recordingPath: journal.recordingPath,
    transcriptPath: journal.transcriptPath,
    transcript: () => journal.transcript,
    ...(opts.saveStorageState === undefined
      ? {}
      : { storageState: { path: opts.saveStorageState, snapshot: () => snapshotter.snapshot() } }),
  });
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
    // #150 — a crossed mission spend budget is a deliberate, clean stop (not the run breaking): it
    // maps to `inconclusive`, but a defect found before it still wins, reported with `stop: "budget"`.
    const preLogOutcome: MissionOutcome = combineOutcomes([
      result.outcome === "crashed"
        ? "crashed"
        : result.outcome === "scope-unreachable" || result.outcome === "stalled"
          ? "inconclusive"
          : result.outcome === "budget"
            ? invariantDefects > 0
              ? "defects-found"
              : "inconclusive"
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
      schemaVersion: MISSION_RESULT_SCHEMA_VERSION,
      strategy: "feature" as const,
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
      defects: unifiedDefects(opts.invariants === undefined ? undefined : result.invariantDefects, serverLogRun?.defects),
      resultPath: resultPathFor(journal.recordingPath),
      usage: NO_MODEL_USAGE,
    };
    return { ...typed, resultPath: writeMissionResult(journal.recordingPath, missionOutcome, exitCode, typed) };
  } finally {
    disarmKillSwitch();
    await serverLog?.abort();
    await persistStorageState(session, opts.saveStorageState, snapshotter);
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
  /** Injected usage tracker (tests): injected gateways that record into it report known costs (#163). */
  usage?: UsageTracker;
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
/** `<prop><op><value>` / `<channel>(<prop>)<op><value>` — ops from the shared `COMPARE_OPS` (longest first). */
const STYLE_CHECK_RE = new RegExp(
  String.raw`^\s*(?:([a-z]+)\(\s*([a-z-]+)\s*\)|([a-z-]+))\s*(${COMPARE_OPS.join("|")})\s*(.*)$`,
);

function parseVisualSpec(kind: string, rest: string): Assertion {
  let out: Assertion;
  switch (kind) {
    case "style":
    case "styleMatches": {
      // The descriptor ends at the LAST `|` (a style value never contains one).
      const bar = rest.lastIndexOf("|");
      if (bar === -1) throw new Error(`${kind} requires "<descriptor>|<prop><op><value>", e.g. ${kind}:[data-heat]|alpha(background-color)>0`);
      const target = parseDescriptorSpec(rest.slice(0, bar));
      const m = STYLE_CHECK_RE.exec(rest.slice(bar + 1));
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
