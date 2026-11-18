// explore-goal-run-phases.ts — `runGoalExploration`'s phases (#231): options/scope resolution,
// resource/session opening, the goal loop, outcome classification and result assembly. Extracted
// move-only from explore-goal-run.ts, which orchestrates these.
import { openModelSecretScope } from "@jevitate/ai-core";
import { sessionLostReason } from "./session-check.js";
import { assertHttpChecksAllowed, createHttpProbe, httpCheckRefs } from "./http-probe.js";
import { logsDirFor } from "./project-dir.js";
import { join, resolve as resolvePath } from "node:path";
import type { JudgmentPort, GenerationPort, UsageTracker, UsageCounts } from "@jevitate/ai-core";
import { PlaywrightBrowserPort, resolveEmulation, type BrowserPort, type EmulationSpec } from "@jevitate/playwright";
import { closeOnce, demoOverlayOf, extensionsStamp, finalizeVideos, runVideoDir, sessionLaunchOptions, type BrowserRunOptions } from "./browser-run-options.js";
import { runCaptureFor, type ScreenshotsSpec } from "./run-screenshots.js";
import { evidenceOf, withRunEvidence } from "./defect-evidence.js";
import { CastActor, BrowseTheWeb } from "@jevitate/screenplay";
import { type Assertion, type InvariantSpec, type Recording } from "@jevitate/recording";
import type { ActionDeltaStats, ActionableControlOutcome, HostHealthSampler, InvariantDefect, InvariantReport, MinEffortRequest, PartialReport, RunDepth, SafetyOverride, SideEffect } from "@jevitate/explore";
import type { DefectOutcome, DoneCheckPolicy, EnvironmentDegraded, GoalReason, JobBasis, JobUnknownReason, JobVerdict, HostHealthSummary, StartupAttempt } from "@jevitate/domain";
import { goalJobDecision, goalJobFold } from "./explore-job-done-check.js";
import { currentRunMetadata } from "./run-metadata.js";
import type { TargetTrust } from "./run-mode.js";
import { runGoalBasedMission, assertAuthorizedExploreTarget, type BoundaryEvidence, type Bounds, type GoalBasedOutcome, type StopReason, type TranscriptEntry, type RunAnswer, type RunOutcome, type SuccessCheck, type SuccessCheckResult, type SuccessWhen, type SecretField, type SecretCommandRunner, type TypeFixture, type UploadFixture, type BudgetTrajectory, type CrashReport, type Http5xxDefect, Http5xxOracle, secretFieldSecrets } from "@jevitate/explore";
import { conversationConfig, type ConversationOptions } from "./conversation-options.js";
import { renderWaitMsFromFlags } from "./goal-run-flags.js";
import { GOAL_ONLY_OUTCOMES, defectOutcomeOf, goalMissionOutcome, goalReasonOf, startedOutcome, type FilingConfig, type IssueDraft, type IssueFilerPort, type MissionFailure, type MissionOutcome, clock } from "@jevitate/domain";
import { draftForCrash, draftForHang, type HangFinding, type TimingSummary } from "@jevitate/explore";
import { processIssueDrafts, type FindingsIssues } from "./findings-filing.js";
import { currentEngineInfo, type EngineInfo } from "./engine.js";
import type { TargetConfig } from "./target-config.js";
import { MissionJournal, artifactStamp, closeQuietly, resultPathFor, writeMissionResult } from "./mission-journal.js";
import { MISSION_RESULT_SCHEMA_VERSION, unifiedDefects } from "./result-schema.js";
import { describeHttp5xx, http5xxGoalReason } from "./http-5xx-outcome.js";
import { missionExitCode } from "./mission-exit.js";
import { launchArmed } from "./launch-armed.js";
import { branchFields, startFromJourney, type JourneyPrefix } from "./journey-prefix.js";
import { journeyFixtureBaseDir, resolveProjectMissionFixture, redactSecretValues } from "./journey-api.js";
import type { JourneyBranchPoint } from "@jevitate/journey";
import { failureWithHostStarved, finishHostHealth, type HostHealthVerdict } from "./host-health-run.js";
import type { StorageStateSnapshotter } from "./storage-state-snapshot.js";
import { openServerLogRuntime, type ServerLogDefect, type ServerLogsSummary } from "./log-correlation.js";
import { fixtureReplayOpener, recordingFixture, type MissionFixtureResult, type MissionFixtures } from "./mission-fixtures.js";
import { observerSessions, persistedActors, type MissionActors } from "./mission-actors.js";
import type { LogClassCause } from "./log-classes.js";
import { triageOf, type ServerLogOptions, serverLogResult, serverLogRuntimeOptions, recordingEmulation, DRAFTS_ONLY, NO_FILER, draftContext, freshSessionOpener, currentUrlSafe, assertSaveStorageStateOutsideProject, persistStorageState, browserVersionOf, type MissionTarget, declaredResult } from "./explore-shared.js";
import { serverLogOutcomeReason, withServerCause } from "./explore-goal-server-cause.js";

export interface RunExplorationOptions {
  /** #837: finite page-perception settle bound; absent retains the core's normal default. */
  readonly renderWaitMs?: number;
  /** Test seam (#203): the run's host-health sampler (a deterministic fake host). Default: this host's. */
  readonly hostHealth?: HostHealthSampler;
  readonly url: string;
  readonly goal: string;
  /** #873 (`--job-context`): the approved job's brief, told to the model with the goal; never a success check. */
  readonly missionBrief?: string;
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
  /**
   * #303 `--action-deltas` (opt-in, off by default): record what each action changed on the page
   * (code's verdict per action) — attached to every transcript and Recording step, summarised in the
   * result (`actionDeltas`), told to the model and used by the no-progress check. Off: no capture.
   */
  /**
   * #521 `--block-off-allowlist-navigation` (opt-in, off by default): arm the navigation guard on this
   * run's mission session (and its fresh/hang-replay sessions) — an off-allowlist page navigation is
   * stopped in place and the mission treats it as a departure. Never on login, Journey or demo sessions.
   */
  readonly blockOffAllowlistNavigation?: boolean;
  readonly actionDeltas?: boolean;
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
  /**
   * #424 (`--min-actions` / `--min-distinct-states`): the minimum exploration effort before the model
   * may conclude. Each value wins over its default; without one, an open-ended find-out gets the
   * default (`resolveMinEffort`). Capped by the budget, with a warning in `checkWarnings`.
   */
  readonly minEffort?: MinEffortRequest;
  readonly secrets?: readonly string[];
  /**
   * Secret field bindings (CLI `--secret-field` / `--totp`, resolved from the environment): typed
   * by code, never by the model; each value/seed is also a run secret (redacted everywhere).
   */
  readonly secretFields?: readonly SecretField[];
  /** #324: runs a `cmd:` secret field's command at type time (CLI `--allow-secret-cmd`). */
  readonly secretCommand?: SecretCommandRunner;
  /** #359: `--secret-cmd-attempts`: runs of one `cmd:` binding's command per run (default 3). */
  readonly secretCommandAttempts?: number;
  /** #281: fields typed with a file's exact text (CLI `--type-fixture`, read by the CLI). */
  readonly typeFixtures?: readonly TypeFixture[];
  /** #720: selected upload controls receive their declared fixture by descriptor. */
  readonly uploadFixtures?: readonly UploadFixture[];
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
  /**
   * #293 `--from-journey`/`--at-step`: replayed into the session (after fixture setup) before the
   * goal loop, which then starts on the live page it left — never a fresh navigation. `url` is only
   * the expected landing.
   */
  readonly journeyPrefix?: JourneyPrefix;
  /** 0.30.0 (#800): the job's done check, read in a FRESH context after the model's `done` (`explore --job`); its reading decides attainment. */
  readonly doneCheck?: DoneCheckReader;
  /** Why no reading decides the job when `doneCheck` is absent (`already-true`, `reading-unknown`); default `no-check`. */
  readonly doneCheckBasis?: JobBasis;
  /** rc-030: why the done check's last reading (or, with no reader, its before reading) could not be taken. */
  readonly doneCheckUnknownReason?: () => JobUnknownReason | undefined;
  /**
   * The done-check policy for an unverified pass (owner decision 3): `require` makes it `inconclusive` (exit 2), `advisory`
   * keeps exit 0. Absent: the result is reported but its exit is not folded (callers that are not `explore --goal`).
   */
  readonly doneCheckPolicy?: DoneCheckPolicy;
  /** `--require-done-check`: a pass an independent `--success` check alone verified is unverified too. */
  readonly requireDoneCheck?: boolean;
  /** #802: the target's trust; default the run mode the surface decided (`run.target.trust`). A harness pass reads unverified/harness, exit 0. */
  readonly targetTrust?: TargetTrust;
}

/** The fresh-context done-check reader (`cfg.doneCheck`): true = holds, false = does not, null = unreadable. */
export type DoneCheckReader = () => Promise<boolean | null>;

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
   * The portable verdict — ALWAYS canonical (#217), derived (#423) from `goalOutcome` and
   * `defectOutcome` by the domain's ONE table (`goalMissionOutcome`): succeeded → clean, or
   * defects-found with defects; failed/exhausted/blocked → defects-found; a hang/broken run keeps its own.
   */
  readonly missionOutcome: MissionOutcome;
  /**
   * The goal run's own ending (#217): succeeded/failed/exhausted/blocked, or a shared outcome. Equal
   * to `outcome`. #423: a defect never replaces it — a goal reached on an app that 500'd is `succeeded`
   * here and `defects` in `defectOutcome`.
   */
  readonly goalOutcome: GoalBasedOutcome;
  /** 0.30.0 (#800): did the job get done? `unverified` when no fresh-session done check decided it. */
  readonly job?: JobVerdict;
  /** #423: why the goal was not achieved (absent when `succeeded`). */
  readonly goalReason?: GoalReason;
  /** 0.30.0 (#807): the boundary the run stopped at (kind, signal, step, and the origin an off-allowlist or new-tab stop names), when goalOutcome is `boundary`. */
  readonly boundary?: BoundaryEvidence;
  readonly outcome: GoalBasedOutcome;
  /** The writes the run's actions fired (#116), marked when the control was paid / destructive. */
  readonly sideEffects: SideEffect[];
  readonly sideEffectsTruncated?: number;
  /** #428: every --allow-control exemption the run used. */
  readonly safetyOverrides?: readonly SafetyOverride[];
  /** #303: the run's action deltas (verdict counts, per-action overhead) — only with `--action-deltas`. */
  readonly actionDeltas?: ActionDeltaStats;
  /**
   * Did the loop complete its goal (`completed`, verified by the success assertion), or why not
   * (`incomplete` + reason)? `outcome` above is the mission verdict; this is the run's own account.
   */
  readonly runOutcome: RunOutcome;
  /** #688: a blocked goal's safe, manager-resumable control, with the observed proof. */
  readonly actionableControl?: ActionableControlOutcome;
  /**
   * rc-030b (#807): why a goal run that stopped blocked, without progress or out of budget did not end
   * `no-route-found` (the no-route floor's first shortfall, or the other cause that kept its ending).
   */
  readonly noRouteShortfall?: string;
  /** A find-out goal's answer (#101), present only when code grounded it on the observed pages. */
  readonly answer?: RunAnswer;
  /**
   * #424: a run whose answer is its verdict that ended WITHOUT a grounded answer — per page visited,
   * what it showed (its own text, grounded), its controls, and what was tried there. Absent otherwise.
   */
  readonly partialReport?: PartialReport;
  /** #424: how deep the run went — distinct states and pages, actions, decisions, forms submitted, the minimum. */
  readonly depth: RunDepth;
  readonly assertionPassed: boolean;
  /** Each success check's verdict and what the oracle saw. */
  readonly checks: SuccessCheckResult[];
  /** Warnings about the verdict (#174: a `--success-when held` check that already held on the start page). */
  readonly checkWarnings?: string[];
  /** #742: the bounded first-navigation startup attempts (one per try, its error class and clock timings); absent when no startup navigation ran. */
  readonly attempts?: StartupAttempt[];
  readonly stop: StopReason;
  readonly finalUrl: string;
  readonly decisions: number;
  readonly actions: number;
  /** Every Recording the run wrote (#195: one list on every strategy) — a goal run writes one. */
  readonly recordingPaths: string[];
  /** #245: `--record-video` files, finalized before this result was written (absent when not recording). */
  readonly videoPaths?: string[];
  /**
   * The per-decision trail (op, target, confidence, whether the action succeeded and why
   * not, URL, page signature) — so a stalled or failed run is explainable. Written next to
   * the Recording as `<recording>.transcript.json`. Built from already-redacted state.
   */
  readonly transcriptPath: string;
  readonly transcript: readonly TranscriptEntry[];
  /** Process exit code of `missionOutcome` (#423: derived from `goalOutcome` + `defectOutcome`). */
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
  /** #421/#423: the gating defects counted per kind — orthogonal to `goalOutcome`. */
  readonly defectOutcome: DefectOutcome;
  /** Per declared invariant: applied / held / violated / unreadable counts. */
  readonly invariants?: InvariantReport[];
  /** The declared spec the run evaluated — persisted so `verify-fix` re-checks the SAME invariants. */
  readonly invariantSpec?: InvariantSpec;
  /** Judgment/generation call counts and tokens for this run (#100); present only when `opts.usage` was supplied. */
  readonly usage?: UsageCounts;
  /** Backend log correlation summary (#142) — present only when `--log-source` was given. */
  readonly serverLogs?: ServerLogsSummary;
  /** #422: `--log-defect` lines classed `environment` by `.jevitate/log-classes.json`/the defaults (absent when none). */
  readonly environmentFaults?: { readonly causes: readonly LogClassCause[] };
  /** #422: `--log-defect` lines classed `expected-validation` (absent when none). */
  readonly expectedValidation?: readonly LogClassCause[];
  /** The fixture the mission started from (#140/#144): identity, non-secret outputs, the setup/restore log. */
  readonly fixtures?: MissionFixtureResult;
  /** The host's health over the run (#203): peaks, the slowest render, starved steps. */
  readonly hostHealth: HostHealthSummary;
  /** Findings met while the host was starved (#203) — advisory, never a defect/hang, never failing the run. */
  readonly environmentDegraded: EnvironmentDegraded[];
  /** #293: the Journey step a journey-anchored run branched from (absent on a bare-URL run). */
  readonly branch?: JourneyBranchPoint;
}

/** #423: a goal's own endings a violated invariant may override (`GoalBasedResult.goalEnding`) — restored as `goalOutcome`. */
const GOAL_ONLY: ReadonlySet<GoalBasedOutcome> = new Set(GOAL_ONLY_OUTCOMES);

/** The mission fixture state a run starts from: the in-memory record plus what is persisted. */
export interface ResolvedMissionFixture {
  readonly record: ReturnType<MissionFixtures["record"]>;
  readonly persisted: ReturnType<MissionFixtures["persisted"]>;
}

type ServerLogRuntime = NonNullable<ReturnType<typeof openServerLogRuntime>>;
type ServerLogRun = Awaited<ReturnType<ServerLogRuntime["finish"]>>;
type MissionResult = Awaited<ReturnType<typeof runGoalBasedMission>>;

/** Options/scope resolution: authorization, the run's secret scope, fixture and emulation identity. */
export interface GoalRunSetup {
  readonly modelSecrets: ReturnType<typeof openModelSecretScope>;
  readonly origin: string;
  readonly renderWaitMs: number | undefined;
  readonly fixture: string | undefined;
  readonly fx: MissionFixtures | undefined;
  readonly missionFixture: ResolvedMissionFixture | undefined;
  readonly atRest: <T>(value: T) => T;
  readonly resolvedEmulation: ReturnType<typeof resolveEmulation>;
  readonly primaryState: string | undefined;
  readonly secrets: string[];
  readonly bound: string[];
}

/**
 * Guardrail #1 — authorize BEFORE opening a browser (throws on refusal), then validate every other
 * pre-browser input, register the run's secrets and resolve the emulation/fixture identity.
 */
export async function resolveGoalRunSetup(
  opts: RunExplorationOptions,
  modelSecrets: ReturnType<typeof openModelSecretScope>,
): Promise<GoalRunSetup> {
  const origin = assertAuthorizedExploreTarget(opts.url, opts.allowlist);
  const renderWaitMs = renderWaitMsFromFlags(opts);
  // #543: every http success check's origin, too (the probe re-checks each request after substitution).
  assertHttpChecksAllowed(opts.successChecks ?? [], opts.allowlist);
  assertSaveStorageStateOutsideProject(opts.saveStorageState);
  // Fail fast on a missing fixture BEFORE launching Chromium.
  const fixture = opts.fixture === undefined ? undefined : await resolveProjectMissionFixture(opts.fixture);
  // A bound secret (or TOTP seed) is a run secret too: kept out of the issue drafts as well. So is a
  // declared probe's resolved auth token (#135) — redacted everywhere a run secret is, not only in
  // the invariant monitor's own evidence.
  const authTokenValues = [...(opts.invariantAuthTokens?.values() ?? [])];
  const bound = [...secretFieldSecrets(opts.secretFields), ...(opts.fixtures?.secrets() ?? []), ...authTokenValues];
  modelSecrets.add([...bound, ...(opts.secrets ?? [])]);
  // Always one shared list: a value the run learns mid-run (a cmd: binding's output, a goal-stated
  // credential typed into a password field) joins it, and every artifact below reads it at write time.
  const secrets: string[] = [...(opts.secrets ?? []), ...bound];
  // The state the mission starts from — replays restore THIS fixture and rebind its recorded outputs.
  const fx = opts.fixtures;
  const missionFixture = fx === undefined ? undefined : { record: fx.record(), persisted: fx.persisted() };
  // #399: what is persisted of the fixture never holds a run secret — e.g. a fixture output the
  // Journey prefix took as a secret param (`--param inviteToken=${setup.inviteToken}`). The raw
  // record stays in memory only, for the replays that rebind it.
  const atRest = <T,>(v: T): T => redactSecretValues(v, secrets);

  // #149: refused BEFORE any browser opens (an unknown --device, or --viewport + --device together).
  const resolvedEmulation = resolveEmulation(opts.emulation);
  if (opts.actors !== undefined && opts.storageState !== undefined && resolvePath(opts.storageState) !== opts.actors.primary.storageState) {
    throw new Error("runExploration: storageState must be the primary actor's own");
  }
  const primaryState = opts.actors?.primary.storageState ?? opts.storageState;
  return { modelSecrets, origin, renderWaitMs, fixture, fx, missionFixture, atRest, resolvedEmulation, primaryState, secrets, bound };
}

/** The run's per-invocation resources built before any browser opens. */
export interface GoalRunResources {
  readonly secretCommand: SecretCommandRunner | undefined;
  readonly capture: ReturnType<typeof runCaptureFor>;
  readonly portFactory: () => BrowserPort;
  readonly port: BrowserPort;
  readonly outDir: string;
  readonly iso: string;
  readonly journal: MissionJournal;
  readonly videoDir: ReturnType<typeof runVideoDir>;
  readonly shown: ReturnType<typeof sessionLaunchOptions>;
  readonly launch: Parameters<BrowserPort["open"]>[0];
  readonly runUsage: ReturnType<UsageTracker["scope"]> | undefined;
}

/**
 * Open the run's output/recording resources: the pixel mask, the port factory, the MissionJournal,
 * the launch options and this invocation's usage scope — none of them opens a browser yet.
 */
export function openGoalRunResources(opts: RunExplorationOptions, setup: GoalRunSetup): GoalRunResources {
  // #250/#251: a recorded or screenshotted run's sessions carry the live pixel mask from their first
  // paint; `--screenshots` captures after each step (the Recording path names their folder).
  const capture = runCaptureFor({
    recordsVideo: opts.browser?.recordVideo !== undefined,
    screenshots: opts.screenshots,
    secrets: setup.secrets,
    artifactPath: () => journal.recordingPath,
    title: `goal: ${opts.goal}`,
  });
  const portFactory = capture.wrap(opts.browserPortFactory ?? (() => new PlaywrightBrowserPort()));
  const port = portFactory();
  const outDir = opts.outDir ?? logsDirFor();
  const iso = (opts.nowIso ?? (() => clock.nowIso()))();
  // Crash-safe: the transcript and partial Recording are flushed after every step. `MissionJournal`
  // itself creates `outDir` synchronously (mkdirSync).
  const journal = new MissionJournal(join(outDir, `explore-${artifactStamp(iso)}.json`));
  // #245: every session this run opens (mission, observers, hang replays) is shown/recorded alike.
  const videoDir = runVideoDir(opts.browser, journal.recordingPath);
  const shown = sessionLaunchOptions(opts.browser, videoDir);
  const launch = {
    ...shown,
    allowedOrigins: [...opts.allowlist],
    ...(opts.blockOffAllowlistNavigation === true ? { blockOffAllowlistNavigation: true } : {}),
    baseUrl: setup.origin,
    ...opts.emulation,
    ...(setup.primaryState !== undefined ? { storageState: setup.primaryState } : {}),
  };
  // Crash-safe on SIGTERM/SIGINT too (#94): a partial `inconclusive` result is written from
  // whatever the journal has already flushed, and the process exits with the conventional code.
  // #163: this run's own share of a (possibly shared) tracker: its usage and sidecar.
  const runUsage = opts.usage?.scope();
  // #324: a value a cmd: binding reads mid-run joins this run's secrets at once, so everything this
  // command writes (result, evidence, issue drafts) is scrubbed of it too, not only the loop's own.
  const runSecretCommand = opts.secretCommand;
  const secretCommand: SecretCommandRunner | undefined =
    runSecretCommand === undefined
      ? undefined
      : async (command) => {
          const out = await runSecretCommand(command);
          const value = out.trim();
          if (value !== "" && !setup.secrets.includes(value)) setup.secrets.push(value);
          // #360: masked in every screenshot and video frame from now on — before the value is typed.
          if (value !== "") await capture.mask.addSecret(value);
          return out;
        };
  return { secretCommand, capture, portFactory, port, outDir, iso, journal, videoDir, shown, launch, runUsage };
}

/** The launched browser session and every observer/log/capture hook bound to it. */
export interface GoalRunSession {
  readonly disarmKillSwitch: () => void;
  readonly health: HostHealthSampler;
  readonly browser: Awaited<ReturnType<BrowserPort["open"]>>;
  readonly snapshotter: StorageStateSnapshotter;
  readonly http5xx: Http5xxOracle;
  readonly observers: ReturnType<typeof observerSessions> | undefined;
  readonly serverLog: ServerLogRuntime | undefined;
  readonly onTranscriptEntry: (entry: TranscriptEntry, all: readonly TranscriptEntry[]) => void;
  readonly closeSession: () => Promise<void>;
}

/**
 * Open the browser/session and model-facing hooks: arm the kill switch, open the mission context
 * (and observers), attach the HTTP 5xx oracle and backend log correlation, and wire step capture.
 */
export async function openGoalRunSession(
  opts: RunExplorationOptions,
  setup: GoalRunSetup,
  resources: GoalRunResources,
): Promise<GoalRunSession> {
  // #226: the kill switch is armed BEFORE the host sampler and the browser launch (see launch-armed.ts).
  const { disarmKillSwitch, health, session: browser, snapshotter } = await launchArmed({
    hostHealth: opts.hostHealth,
    saveStorageState: opts.saveStorageState !== undefined,
    open: () => resources.port.open(resources.launch),
    mission: (hooks) => ({
      // #220: the killed run's partial result carries the unified schema's common fields too.
      strategy: "goal",
      target: { seedUrl: opts.url, allowlist: [...opts.allowlist], ...(setup.primaryState !== undefined ? { storageStatePath: resolvePath(setup.primaryState) } : {}) },
      recordingPath: resources.journal.recordingPath,
      hostHealth: hooks.hostHealth,
      transcriptPath: resources.journal.transcriptPath,
      transcript: () => resources.journal.transcript,
      ...(resources.videoDir === undefined ? {} : { videoDir: resources.videoDir }),
      ...(resources.runUsage === undefined ? {} : { usage: resources.runUsage }),
      ...(opts.saveStorageState === undefined ? {} : { storageState: { path: opts.saveStorageState, snapshot: hooks.snapshot } }),
    }),
  });
  // #208: the shared HTTP 5xx hard signal, listening from before the first navigation.
  const http5xx = new Http5xxOracle(browser.page, { allowlist: opts.allowlist });
  // #147: each observer in its OWN fresh context (only its own storageState), opened on first use.
  const observers =
    opts.actors === undefined || opts.actors.observers.length === 0
      ? undefined
      : observerSessions(resources.portFactory, { ...resources.shown, allowedOrigins: [...opts.allowlist], baseUrl: setup.origin }, opts.actors.observers);
  // Backend log correlation (#142): opened BEFORE the mission runs so its window covers the seed
  // load too; a no-op (`undefined`) when `--log-source` was not given.
  const serverLog = openServerLogRuntime({
    ...serverLogRuntimeOptions(opts.serverLog),
    secrets: setup.secrets,
    onTranscriptEntry: resources.journal.onTranscriptEntry,
  });
  // #204: every request's correlation ids, from before the first navigation.
  serverLog?.observe(browser.page);
  // #159: every settled step also refreshes the in-memory storageState snapshot (cheap no-op when
  // `--save-storage-state` was not given — `snapshotter.noteSettledStep` checks `enabled` itself).
  const onTranscriptEntry = (entry: TranscriptEntry, all: readonly TranscriptEntry[]): void => {
    resources.capture.noteEntry(browser.page, entry);
    health.noteStep(entry);
    http5xx.noteStep(entry);
    (serverLog?.onTranscriptEntry ?? resources.journal.onTranscriptEntry)(entry, all);
    snapshotter.noteSettledStep(currentUrlSafe(browser));
  };
  // #159/#245: persisted and closed once — early (before the result is written) when recording video.
  const closeSession = closeOnce(async () => {
    await persistStorageState(browser, opts.saveStorageState, snapshotter);
    await closeQuietly(browser);
  });
  return { disarmKillSwitch, health, browser, snapshotter, http5xx, observers, serverLog, onTranscriptEntry, closeSession };
}

/** The goal loop's start anchor, its mission result, and the done-check reader's last reading. */
export interface GoalRunMissionPhase {
  readonly start: Awaited<ReturnType<typeof startFromJourney>>;
  readonly mission: MissionResult;
  readonly hasDoneCheck: boolean;
  readonly readLastReading: () => boolean | null | undefined;
  readonly readNow: () => Promise<void>;
}

function goalFreshSessionOpener(setup: GoalRunSetup, resources: GoalRunResources, opts: RunExplorationOptions): ReturnType<typeof freshSessionOpener> {
  // A hang is reproduced by replaying its steps in fresh contexts (same auth, same fixture state).
  return setup.fx === undefined || setup.missionFixture === undefined
    ? freshSessionOpener(resources.portFactory, resources.launch, opts.allowlist)
    : fixtureReplayOpener(freshSessionOpener(resources.portFactory, resources.launch, opts.allowlist), setup.fx, setup.missionFixture.record.outputs);
}

/** The loop config: timing/settle/safety, the start anchor, the checks and the done-check reader. */
function goalMissionCoreInputs(
  opts: RunExplorationOptions,
  setup: GoalRunSetup,
  resources: GoalRunResources,
  session: GoalRunSession,
  start: GoalRunMissionPhase["start"],
  doneCheck: DoneCheckReader | undefined,
) {
  return {
    ...(setup.renderWaitMs === undefined ? {} : { renderWaitMs: setup.renderWaitMs }),
    ...(opts.target?.timing === undefined ? {} : { timingConfig: opts.target.timing }),
    ...(opts.target?.settle === undefined ? {} : { settle: opts.target.settle }),
    ...(opts.target?.hangs === undefined ? {} : { hangs: opts.target.hangs }),
    ...(opts.target?.safety === undefined ? {} : { safety: opts.target.safety }),
    openFreshSession: goalFreshSessionOpener(setup, resources, opts),
    ...(opts.hangReplays === undefined ? {} : { hangReplays: opts.hangReplays }),
    onTranscriptEntry: session.onTranscriptEntry,
    onRecording: resources.journal.onRecording,
    judge: opts.judge,
    gen: opts.gen,
    goal: opts.goal,
    allowlist: opts.allowlist,
    startUrl: start.url,
    ...(start.branch === undefined ? {} : { startInPlace: true }),
    // #293: a retried run re-replays the Journey prefix instead of loading the anchor URL.
    ...(start.restart === undefined ? {} : { restartAtStart: start.restart.restartAtStart }),
    ...(opts.successAssertion === undefined ? {} : { successAssertion: opts.successAssertion }),
    ...(opts.successChecks === undefined ? {} : { successChecks: opts.successChecks }),
    ...(opts.successWhen === undefined ? {} : { successWhen: opts.successWhen }),
    ...(opts.allowVacuousChecks === true ? { allowVacuousChecks: true } : {}),
    ...(doneCheck === undefined ? {} : { doneCheck }),
  };
}

/** The loop's target/secret/fixture/invariant inputs — everything but the core loop config. */
function goalMissionTargetInputs(
  opts: RunExplorationOptions,
  setup: GoalRunSetup,
  resources: GoalRunResources,
  session: GoalRunSession,
) {
  return {
    ...(opts.missionBrief === undefined ? {} : { missionBrief: opts.missionBrief }),
    // #543: http checks request through the allowlist-bound probe; `${setup.x}` from the fixtures.
    ...((opts.successChecks ?? []).some((c) => c.kind === "http")
      ? { httpProbe: createHttpProbe({ allowlist: opts.allowlist }), httpRefs: httpCheckRefs(setup.fx === undefined ? {} : { bindings: setup.fx.bindings() }) }
      : {}),
    bounds: opts.bounds,
    ...(opts.minEffort === undefined ? {} : { minEffort: opts.minEffort }),
    secrets: setup.secrets,
    ...(opts.secretFields === undefined ? {} : { secretFields: opts.secretFields }),
    ...(resources.secretCommand === undefined ? {} : { secretCommand: resources.secretCommand }),
    // A credential the run typed that no --secret registered (a goal-stated password): a run secret
    // from then on — scrubbed from the result, evidence, issue drafts, screenshots and model calls.
    onRunSecret: (value: string) => {
      if (!setup.secrets.includes(value)) setup.secrets.push(value);
      setup.modelSecrets.add([value]);
      void resources.capture.mask.addSecret(value).catch(() => undefined);
    },
    ...(opts.secretCommandAttempts === undefined ? {} : { secretCommandAttempts: opts.secretCommandAttempts }),
    ...(opts.typeFixtures === undefined ? {} : { typeFixtures: opts.typeFixtures }),
    ...(opts.uploadFixtures === undefined ? {} : { uploadFixtures: opts.uploadFixtures }),
    site: setup.origin,
    fixture: setup.fixture,
    fixtureRoot: journeyFixtureBaseDir(),
    ...conversationConfig(opts.conversation),
    ...(opts.invariants === undefined ? {} : { invariants: opts.invariants }),
    ...(opts.invariantAuthTokens === undefined ? {} : { invariantAuthTokens: opts.invariantAuthTokens }),
    ...(session.observers === undefined ? {} : { observers: session.observers }),
    ...(opts.actors === undefined ? {} : { primaryActor: opts.actors.primary.name }),
    hostHealth: session.health,
    demoOverlay: demoOverlayOf(opts.browser),
    // #303 (opt-in): action deltas, with Jev's advisory relevance labels for changes code cannot tie.
    ...(opts.actionDeltas === true ? { actionDeltas: { jev: true } } : {}),
  };
}

/** Build the goal loop's inputs and run it, keeping the done-check reader's last reading observable. */
export async function runGoalMission(
  opts: RunExplorationOptions,
  setup: GoalRunSetup,
  resources: GoalRunResources,
  session: GoalRunSession,
): Promise<GoalRunMissionPhase> {
  // #293: a journey-anchored run first replays its Journey's prefix into this very session.
  const start = await startFromJourney(opts.journeyPrefix, session.browser, opts.url, opts.allowlist, opts.browser);
  const actor = CastActor.named("explorer").whoCan(new BrowseTheWeb(session.browser, [...opts.allowlist]));
  // 0.30.0 (#800): remember what the fresh-context reader last said, for a run that ends on a rejected `done`.
  let lastReading: boolean | null | undefined;
  const doneCheck: DoneCheckReader | undefined =
    opts.doneCheck === undefined
      ? undefined
      : async () => {
          lastReading = await opts.doneCheck!();
          return lastReading;
        };
  const mission = await runGoalBasedMission({
    ...goalMissionCoreInputs(opts, setup, resources, session, start, doneCheck),
    actor,
    ...goalMissionTargetInputs(opts, setup, resources, session),
  });
  return {
    start,
    mission,
    hasDoneCheck: doneCheck !== undefined,
    readLastReading: () => lastReading,
    // rc-030: a reading taken after the loop that fails leaves the reading unknown (`null`).
    readNow: async () => {
      await doneCheck!().catch(() => {
        lastReading = null;
      });
    },
  };
}

/** The goal's own ending, the unified defects, and the host-health verdict. */
export interface GoalDefectState {
  readonly ownGoal: GoalBasedOutcome;
  readonly oracleBroken: boolean;
  readonly goalSoFar: GoalBasedOutcome;
  readonly httpDefects: Http5xxDefect[];
  readonly defects: Array<InvariantDefect | Http5xxDefect | ServerLogDefect>;
  readonly defectOutcome: DefectOutcome;
  readonly preHost: GoalBasedOutcome;
  readonly host: HostHealthVerdict<GoalBasedOutcome>;
  readonly failureNow: MissionFailure | undefined;
}

/** Fold the mission's defects and the host's health into the goal's own ending. */
export async function resolveGoalDefectsAndHost(
  opts: RunExplorationOptions,
  mission: MissionResult,
  session: GoalRunSession,
  serverLogRun: ServerLogRun | undefined,
): Promise<GoalDefectState> {
  // #423: the goal's own ending. A violated invariant's `defects-found` (#86) no longer replaces a
  // goal-only ending (`goalEnding`): defects are their own, orthogonal verdict (`defectOutcome`).
  const ownGoal: GoalBasedOutcome =
    mission.outcome === "defects-found" && mission.goalEnding !== undefined && GOAL_ONLY.has(mission.goalEnding) ? mission.goalEnding : mission.outcome;
  // #142 follow-up: an unreadable `--log-defect` oracle (and no server-log defect to show) turns an
  // otherwise-`succeeded` run `inconclusive` (exit 2) — its silence proves nothing, never clean.
  const oracleBroken = serverLogRun !== undefined && serverLogRun.defects.length === 0 && !serverLogRun.summary.oracleOk && ownGoal === "succeeded";
  const goalSoFar: GoalBasedOutcome = oracleBroken ? "inconclusive" : ownGoal;
  // #208: an HTTP 5xx is a hard-signal defect — `defects-found` even when the goal's checks held.
  const httpDefects = session.http5xx.defects(mission.transcript, mission.recording.pages.flatMap((p) => p.steps)[0]?.step.kind === "navigate" ? 1 : 0);
  // #195/#421: every defect in ONE list — server-log defects as structured entries, never only prose.
  const defects = unifiedDefects<InvariantDefect | Http5xxDefect>(
    [...(opts.invariants === undefined ? [] : (mission.invariantDefects ?? [])), ...httpDefects],
    serverLogRun?.defects,
  );
  const defectOutcome = defectOutcomeOf(defects);
  // #203: most steps on a starved host → `inconclusive` (degraded-environment), never a pass/fail —
  // judged on what the run would report (`goalMissionOutcome`, never `clean` with defects): a found
  // defect is never overridden, a goal-only miss is. #213: a starved `failed` goal keeps the check
  // that did not hold in its degraded reason.
  const preHost: GoalBasedOutcome =
    defectOutcome.status === "defects" ? (goalMissionOutcome(goalSoFar, "defects") as Exclude<MissionOutcome, "clean" | "pending-review">) : goalSoFar;
  const host = await finishHostHealth(session.health, preHost, {
    ...((mission.run.failure ?? mission.failure) === undefined ? {} : { failure: (mission.run.failure ?? mission.failure)! }),
    ...(preHost === mission.outcome && (mission.failure?.message ?? mission.reason) !== undefined
      ? { wouldHaveBeen: mission.failure?.message ?? mission.reason }
      : {}),
  });
  // #448: ZERO executed actions → `not-started` (never an exercised ending); passive defects stay listed.
  const failureNow = failureWithHostStarved(host, mission.run.failure ?? host.failure ?? mission.failure);
  return { ownGoal, oracleBroken, goalSoFar, httpDefects, defects, defectOutcome, preHost, host, failureNow };
}

/** The folded goal/job verdict the result and its exit code are built from. */
export interface GoalJobVerdictState {
  readonly modelGoalOutcome: GoalBasedOutcome;
  readonly foldedOutcome: MissionOutcome;
  readonly job: JobVerdict | undefined;
  readonly unverifiedPass: boolean;
  readonly jobFold: ReturnType<typeof goalJobFold>;
  readonly missionOutcome: MissionOutcome;
  readonly goalOutcome: GoalBasedOutcome;
  readonly goalReason: ReturnType<typeof goalReasonOf>;
}

/** Fold the host verdict and the done-check reader into THE outcome table and the goal reason. */
export async function resolveGoalJobVerdict(
  opts: RunExplorationOptions,
  mission: MissionResult,
  defects: GoalDefectState,
  reader: GoalRunMissionPhase,
): Promise<GoalJobVerdictState> {
  const { host, preHost, goalSoFar, defectOutcome, failureNow } = defects;
  // `--allow-vacuous-checks` is the operator's explicit acceptance of a goal that held before any action: that
  // `succeeded` stays (the flag's whole meaning), every other zero-action ending is `not-started`.
  const endedAs = host.outcome === preHost ? goalSoFar : host.outcome;
  const modelGoalOutcome = (opts.allowVacuousChecks === true && endedAs === "succeeded" ? endedAs : startedOutcome(endedAs, mission.run.actions, failureNow?.kind)) as GoalBasedOutcome;
  // #423: THE table (domain `goalMissionOutcome`) — the exit code is unchanged for every combination.
  const foldedOutcome = goalMissionOutcome(modelGoalOutcome, defectOutcome.status);
  // 0.30.0 (#800): the job verdict and decision 3's fold (goalJobDecision: harness #802, find-out exempt).
  const verifiedBy = mission.run.outcome.status === "completed" ? mission.run.outcome.verifiedBy : undefined;
  // rc-030: the loop reads the done check only on a `done` code accepted. A run that ends without that verdict
  // (the judgment rejected every `done`, the run blocked, or it ended on an answer) takes its after reading
  // now, in a fresh context, so the job is decided by the app's state, not left `reading-unknown` unread.
  const loopJob = mission.run.outcome.status === "completed" ? mission.run.outcome.job : undefined;
  if (reader.hasDoneCheck && loopJob === undefined) await reader.readNow();
  const { job, unverifiedPass } = goalJobDecision({
    completed: mission.run.outcome.status === "completed",
    loopJob,
    verifiedBy,
    hasReader: opts.doneCheck !== undefined,
    lastReading: reader.readLastReading(),
    basis: opts.doneCheckBasis,
    unknownReason: opts.doneCheckUnknownReason?.(),
    goalOutcome: modelGoalOutcome,
    foldedOutcome,
    policy: opts.doneCheckPolicy,
    requireDoneCheck: opts.requireDoneCheck,
    trust: opts.targetTrust ?? currentRunMetadata()?.runMode?.().target.trust,
  });
  // Decision 2: a pass whose done check read false is `defects-found` (exit 1), `done-check-failed`.
  // rc-030b: the goal's own fields agree with the job's fold (a done check read false over a pass is
  // `failed`, never `succeeded`; read true over a model-only give-up is `succeeded`: job gates, proof advisory).
  const jobFold = goalJobFold({ foldedOutcome, job, unverifiedPass, goalOutcome: modelGoalOutcome, defects: defectOutcome.status, runFailed: failureNow !== undefined });
  const missionOutcome: MissionOutcome = jobFold.missionOutcome;
  const goalOutcome: GoalBasedOutcome = jobFold.goalOutcome ?? modelGoalOutcome;
  const goalReason = goalReasonOf({
    goalOutcome,
    ...(mission.goalEnding === undefined ? {} : { overridden: mission.goalEnding }),
    stop: mission.run.stop,
    ...((jobFold.failure ?? failureNow) === undefined ? {} : { failureKind: (jobFold.failure ?? failureNow)!.kind }),
    ...(mission.run.missCause === undefined ? {} : { missCause: mission.run.missCause }),
  });
  return { modelGoalOutcome, foldedOutcome, job, unverifiedPass, jobFold, missionOutcome, goalOutcome, goalReason };
}

/** The mission Recording, augmented with its fixture identity, emulation and extension stamp. */
export function buildGoalRecording(opts: RunExplorationOptions, setup: GoalRunSetup, mission: MissionResult): Recording {
  return {
    ...mission.recording,
    ...(setup.missionFixture === undefined ? {} : { fixture: setup.atRest(recordingFixture(setup.missionFixture.record)) }),
    ...(setup.resolvedEmulation === undefined ? {} : { emulation: recordingEmulation(setup.resolvedEmulation) }),
    ...extensionsStamp(opts.browser), // #256
  };
}

/** The artifacts written next to the Recording before the result is assembled. */
export interface GoalArtifacts {
  readonly issues: FindingsIssues;
  readonly engine: EngineInfo;
  readonly resultPath: string;
  readonly shotFields: Awaited<ReturnType<ReturnType<typeof runCaptureFor>["finish"]>>;
  readonly videos: Awaited<ReturnType<typeof finalizeVideos>>;
}

/** Write the Recording/transcript, file the issue drafts and finish screenshots/videos. */
export async function writeGoalArtifacts(
  opts: RunExplorationOptions,
  setup: GoalRunSetup,
  resources: GoalRunResources,
  session: GoalRunSession,
  mission: MissionResult,
  recording: Recording,
  serverLogRun: ServerLogRun | undefined,
): Promise<GoalArtifacts> {
  resources.journal.writeRecording(recording);
  resources.journal.writeTranscript(serverLogRun?.transcript ?? mission.transcript);
  const engine = currentEngineInfo();
  const ctx = draftContext(setup.origin, resources.journal, setup.secrets, browserVersionOf(session.browser.page), engine);
  const resultPath = resultPathFor(resources.journal.recordingPath);
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
    resources.journal.recordingPath,
    drafts,
    opts.filing ?? DRAFTS_ONLY,
    opts.issueFiler ?? NO_FILER,
    resources.iso,
  );
  // #245: every context closed (videos finalized) before the result naming them is written.
  const shotFields = await resources.capture.finish();
  const videos = await finalizeVideos(resources.videoDir, session.closeSession);
  return { issues, engine, resultPath, shotFields, videos };
}

/** Everything the result assembly needs, threaded explicitly. */
export interface GoalResultContext {
  readonly opts: RunExplorationOptions;
  readonly setup: GoalRunSetup;
  readonly resources: GoalRunResources;
  readonly session: GoalRunSession;
  readonly run: GoalRunMissionPhase;
  readonly recording: Recording;
  readonly serverLogRun: ServerLogRun | undefined;
  readonly defects: GoalDefectState;
  readonly verdict: GoalJobVerdictState;
  readonly artifacts: GoalArtifacts;
}

/** #213: whether the run's first page was a sign-in page despite a `--storage-state` session. */
function goalSessionLostField(primaryState: string | undefined, transcript: readonly TranscriptEntry[]): { sessionLost?: { reason: string } } {
  const lost = sessionLostReason({
    target: primaryState === undefined ? {} : { storageStatePath: resolvePath(primaryState) },
    transcript,
  });
  return lost === undefined ? {} : { sessionLost: { reason: lost } };
}

/** The fixture identity persisted with the result (never a run secret). */
function goalFixturesField(
  fx: MissionFixtures | undefined,
  missionFixture: ResolvedMissionFixture | undefined,
  atRest: <T>(value: T) => T,
): { fixtures?: MissionFixtureResult } {
  if (fx === undefined || missionFixture === undefined) return {};
  return {
    fixtures: atRest({
      ...missionFixture.record,
      cycles: fx.record().cycles,
      log: fx.record().log,
      ...(missionFixture.persisted.spec === undefined ? {} : { spec: missionFixture.persisted.spec }),
      ...(missionFixture.persisted.hooks === undefined ? {} : { hooks: missionFixture.persisted.hooks }),
      ...(missionFixture.persisted.identities === undefined ? {} : { identities: missionFixture.persisted.identities }),
    }),
  };
}

/** #209: the typed cause of a goal-specific miss, after an engine failure or a starved host. */
function goalFailureField(jobFold: ReturnType<typeof goalJobFold>, failureNow: MissionFailure | undefined): { failure?: MissionFailure } {
  const f = jobFold.failure ?? failureNow;
  return f === undefined ? {} : { failure: f };
}

/** #423: the prose `reason` — the goal's own account, then what the defect oracles found. */
function goalReasonField(c: GoalResultContext): { reason?: string } {
  const { run, serverLogRun, defects, verdict } = c;
  const mission = run.mission;
  if (defects.host.failure !== undefined) return { reason: defects.host.failure.message };
  const parts: string[] = [];
  const own = withServerCause(mission.reason, verdict.modelGoalOutcome, serverLogRun?.transcript);
  if (own !== undefined) parts.push(own);
  if (verdict.jobFold.failure !== undefined) parts.push(verdict.jobFold.failure.message);
  if (verdict.jobFold.note !== undefined) parts.push(verdict.jobFold.note);
  if (verdict.unverifiedPass) parts.push("the goal passed but no done check verified the job (add --success or --job <id>)");
  if (defects.oracleBroken) parts.push(serverLogOutcomeReason("inconclusive", serverLogRun));
  if ((serverLogRun?.defects.length ?? 0) > 0) parts.push(serverLogOutcomeReason("defects-found", serverLogRun));
  if (defects.httpDefects.length > 0) {
    // #208: a 5xx alone on a goal whose checks held says both; otherwise it is named beside the rest.
    parts.push(parts.length === 0 ? http5xxGoalReason(defects.httpDefects, mission.assertionPassed) : `HTTP 5xx: ${describeHttp5xx(defects.httpDefects)}`);
  }
  return parts.length === 0 ? {} : { reason: parts.join("; ") };
}

/** Result head: the verdict, the timing/run outcomes and the mission's own account fields. */
function goalResultHead(c: GoalResultContext) {
  const { run, verdict, artifacts } = c;
  const mission = run.mission;
  return {
    schemaVersion: MISSION_RESULT_SCHEMA_VERSION,
    strategy: "goal" as const,
    missionOutcome: verdict.missionOutcome,
    goalOutcome: verdict.goalOutcome,
    ...(verdict.job === undefined ? {} : { job: verdict.job }),
    ...(verdict.goalReason === undefined ? {} : { goalReason: verdict.goalReason }),
    issues: artifacts.issues,
    timing: mission.run.timing,
    outcome: verdict.goalOutcome,
    runOutcome: mission.run.outcome,
    ...(mission.run.actionableControl === undefined ? {} : { actionableControl: mission.run.actionableControl }),
    ...(mission.run.noRouteShortfall === undefined ? {} : { noRouteShortfall: mission.run.noRouteShortfall }),
    ...(mission.run.answer === undefined ? {} : { answer: mission.run.answer }),
    ...(mission.run.boundary === undefined ? {} : { boundary: mission.run.boundary }),
    ...(mission.run.partialReport === undefined ? {} : { partialReport: mission.run.partialReport }),
    depth: mission.run.depth,
    assertionPassed: mission.assertionPassed,
    checks: mission.checks,
    ...(mission.warnings === undefined ? {} : { checkWarnings: mission.warnings }),
    ...(mission.attempts === undefined ? {} : { attempts: mission.attempts }),
  };
}

/** Result middle: session/stop/action fields, the Recording and its paths, and the target. */
function goalResultMiddle(c: GoalResultContext) {
  const { opts, setup, resources, run, recording, serverLogRun, verdict, artifacts } = c;
  const mission = run.mission;
  const start = run.start;
  return {
    ...goalSessionLostField(setup.primaryState, serverLogRun?.transcript ?? mission.transcript),
    stop: mission.run.stop,
    finalUrl: mission.finalUrl,
    decisions: mission.run.decisions,
    actions: mission.run.actions,
    recordingPaths: [resources.journal.recordingPath],
    ...artifacts.videos,
    ...artifacts.shotFields,
    transcriptPath: resources.journal.transcriptPath,
    transcript: serverLogRun?.transcript ?? mission.transcript,
    exitCode: missionExitCode(verdict.missionOutcome),
    resultPath: artifacts.resultPath,
    target: {
      seedUrl: start.persistUrl,
      allowlist: [...opts.allowlist],
      ...(setup.primaryState !== undefined ? { storageStatePath: resolvePath(setup.primaryState) } : {}),
      ...(opts.actors === undefined ? {} : { actors: persistedActors(opts.actors) }),
    },
    ...branchFields(start),
    recording,
    hangs: mission.hang === undefined ? [] : [mission.hang],
    ...(mission.intermittentHangs === undefined ? {} : { intermittentHangs: mission.intermittentHangs }),
    ...(mission.run.crash === undefined ? {} : { crash: mission.run.crash }),
    // #180: the declared budgets' observed trajectory, whatever the outcome (a hang included).
    ...(mission.budget === undefined ? {} : { budget: mission.budget }),
    sideEffects: mission.run.sideEffects,
    ...(mission.run.sideEffectsTruncated === undefined ? {} : { sideEffectsTruncated: mission.run.sideEffectsTruncated }),
    ...(mission.run.safetyOverrides === undefined ? {} : { safetyOverrides: mission.run.safetyOverrides }),
    ...(mission.run.actionDeltas === undefined ? {} : { actionDeltas: mission.run.actionDeltas }),
    engine: artifacts.engine,
  };
}

/** Result tail: the fixture/failure/reason fields, declared invariants and server-log summaries. */
function goalResultTail(c: GoalResultContext) {
  const { setup, run, serverLogRun, defects, verdict, resources } = c;
  const mission = run.mission;
  return {
    ...goalFixturesField(setup.fx, setup.missionFixture, setup.atRest),
    ...goalFailureField(verdict.jobFold, defects.failureNow),
    ...goalReasonField(c),
    ...declaredResult(c.opts.invariants, mission.invariantDefects, mission.invariants),
    ...(resources.runUsage === undefined ? {} : { usage: resources.runUsage.snapshot() }),
    ...serverLogResult(serverLogRun),
    defects: defects.defects,
    defectOutcome: defects.defectOutcome,
    ...defects.host.fields,
  };
}

/** Assemble the persisted `RunExplorationResult` from its contiguous parts. */
export function assembleGoalResult(c: GoalResultContext): RunExplorationResult {
  return { ...goalResultHead(c), ...goalResultMiddle(c), ...goalResultTail(c) };
}
