// explore-goal.ts — the goal-directed explore runner (`runExploration`) and its goal-only helpers (#231).
import { sessionLostReason } from "./session-check.js";
import { logsDirFor } from "./project-dir.js";
import { join, resolve as resolvePath } from "node:path";
import type { JudgmentPort, GenerationPort, UsageTracker, UsageCounts } from "@jevitate/ai-core";
import { PlaywrightBrowserPort, resolveEmulation, type BrowserPort, type EmulationSpec } from "@jevitate/playwright";
import { closeOnce, demoOverlayOf, extensionsStamp, finalizeVideos, runVideoDir, sessionLaunchOptions, type BrowserRunOptions } from "./browser-run-options.js";
import { runCaptureFor, type ScreenshotsSpec } from "./run-screenshots.js";
import { evidenceOf, withRunEvidence } from "./defect-evidence.js";
import { CastActor, BrowseTheWeb } from "@jevitate/screenplay";
import { type Assertion, type InvariantSpec, type Recording } from "@jevitate/recording";
import type { ActionDeltaStats, HostHealthSampler, InvariantDefect, InvariantReport, MinEffortRequest, PartialReport, RunDepth, SafetyOverride, SideEffect } from "@jevitate/explore";
import type { DefectOutcome, EnvironmentDegraded, GoalReason, HostHealthSummary } from "@jevitate/domain";
import { runGoalBasedMission, assertAuthorizedExploreTarget, resolveMissionFixture, type Bounds, type GoalBasedOutcome, type StopReason, type TranscriptEntry, type RunAnswer, type RunOutcome, type SuccessCheck, type SuccessCheckResult, type SuccessWhen, type SecretField, type SecretCommandRunner, type TypeFixture, type BudgetTrajectory, type CrashReport, type Http5xxDefect, Http5xxOracle, secretFieldSecrets } from "@jevitate/explore";
import { conversationConfig, type ConversationOptions } from "./conversation-options.js";
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
import { redactSecretValues } from "./journey-api.js";
import type { JourneyBranchPoint } from "@jevitate/journey";
import { failureWithHostStarved, finishHostHealth } from "./host-health-run.js";
import { openServerLogRuntime, type ServerLogDefect, type ServerLogEvidence, type ServerLogRuntimeResult, type ServerLogsSummary, type TranscriptEntryWithLogs } from "./log-correlation.js";
import { fixtureReplayOpener, recordingFixture, type MissionFixtureResult, type MissionFixtures } from "./mission-fixtures.js";
import { observerSessions, persistedActors, type MissionActors } from "./mission-actors.js";
import type { LogClassCause } from "./log-classes.js";
import { triageOf, type ServerLogOptions, serverLogResult, serverLogRuntimeOptions, recordingEmulation, DRAFTS_ONLY, NO_FILER, draftContext, freshSessionOpener, currentUrlSafe, assertSaveStorageStateOutsideProject, persistStorageState, browserVersionOf, type MissionTarget, declaredResult } from "./explore-shared.js";

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
  /**
   * #303 `--action-deltas` (opt-in, off by default): record what each action changed on the page
   * (code's verdict per action) — attached to every transcript and Recording step, summarised in the
   * result (`actionDeltas`), told to the model and used by the no-progress check. Off: no capture.
   */
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
  /** #423: why the goal was not achieved (absent when `succeeded`). */
  readonly goalReason?: GoalReason;
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

/** One-line reason for a server-log-driven outcome change (`reason` is unset otherwise for `succeeded`). */
function serverLogOutcomeReason(newOutcome: GoalBasedOutcome | MissionOutcome, run: ServerLogRuntimeResult | undefined): string {
  if (newOutcome === "defects-found") {
    const n = run?.defects.length ?? 0;
    return `${n} server-log defect${n === 1 ? "" : "s"} found (--log-defect)`;
  }
  // #169: the summary already knows WHICH source(s) failed to attach and their error text — this
  // default only covers the (should-be-unreachable) case of no summary at all.
  return (
    run?.summary.oracleReason ??
    "the --log-defect oracle could not run: every declared --log-source failed to attach — an absence of server-log defects proves nothing"
  );
}

/** Outcomes whose `reason` describes a UI-side blocker worth pairing with a correlated server cause. */
const BLOCKED_LIKE_OUTCOMES: ReadonlySet<GoalBasedOutcome> = new Set(["blocked", "exhausted", "failed", "inconclusive"]);

const SERVER_CAUSE_MAX_CHARS = 160;
/** Decisions that end a run without acting on the page (their state is the previous action's). */
const ENDING_OPS: ReadonlySet<string> = new Set(["blocked", "done", "report"]);

/**
 * The most informative correlated server-log line attached to the LAST transcript step (#165's
 * "Also" — the step the run ended on is the one whose UI blocker `mission.reason` already
 * describes): an `error` line wins over a `warn` one; ties keep the first (arrival order). `undefined`
 * when `--log-source` was not given, or nothing warn/error-level attached to that step.
 */
function lastStepServerCause(transcript: readonly TranscriptEntryWithLogs[] | undefined): { readonly text: string; readonly correlated: boolean } | undefined {
  // The step the run ended on: the last entry — and, when the run ended on a decision that acts on
  // nothing (`blocked`, `done`, `report`), the action just before it too, whose UI state that
  // decision is about (#204: its request's lines are attached to it).
  const logs: ServerLogEvidence[] = [];
  for (let i = (transcript?.length ?? 0) - 1; i >= 0; i--) {
    const e = transcript?.[i];
    if (e === undefined) break;
    logs.push(...(e.serverLogs ?? []));
    if (e.op === null || !ENDING_OPS.has(e.op)) break;
  }
  if (logs.length === 0) return undefined;
  // An error beats a warn; at the same level, a line correlated to its exact request by id (#204)
  // beats one attached by time; ties keep the first (arrival order).
  const rank = (l: ServerLogEvidence): number => (l.level === "error" ? 2 : 0) + (l.request === undefined ? 0 : 1);
  let line: ServerLogEvidence | undefined;
  for (const l of logs) {
    if (l.level !== "error" && l.level !== "warn") continue;
    if (line === undefined || rank(l) > rank(line)) line = l;
  }
  if (line === undefined) return undefined;
  const body = line.message.length > SERVER_CAUSE_MAX_CHARS ? `${line.message.slice(0, SERVER_CAUSE_MAX_CHARS)}…` : line.message;
  const said = `${line.level}${line.target === undefined ? "" : ` ${line.target}`} ${quote(body)}`;
  if (line.request === undefined) return { text: said, correlated: false };
  const r = line.request;
  return { text: `${said} on ${r.method} ${pathOf(r.url)}${r.status === null ? "" : ` (${r.status})`}`, correlated: true };
}

/** A redacted request URL's path (the reason names the endpoint, never its query). */
function pathOf(url: string): string {
  try {
    return new URL(url).pathname;
  } catch {
    return url.split(/[?#]/)[0] ?? url;
  }
}

function quote(s: string): string {
  return `"${s}"`;
}

/**
 * Pairs an already-computed UI-side `reason` with the correlated server cause on the step the run
 * ended on (#165 "Also"): `"<UI reason>; server: <level> \"<message>\""` — or, when the line was
 * correlated to its exact request by a trace/correlation id (#204), `"<UI reason>; caused by:
 * <level> \"<message>\" on POST /x (500)"`. A no-op when there is no
 * `reason` to pair with, the outcome isn't one of blocked/exhausted/inconclusive (a `defects-found`
 * or an oracle-unhealthy `inconclusive` already gets its own `serverLogOutcomeReason`), or no
 * server-log evidence attached to that step — including when `--log-source` was never given.
 */
export function withServerCause(reason: string | undefined, outcome: GoalBasedOutcome, transcript: readonly TranscriptEntryWithLogs[] | undefined): string | undefined {
  if (reason === undefined || !BLOCKED_LIKE_OUTCOMES.has(outcome)) return reason;
  const cause = lastStepServerCause(transcript);
  if (cause === undefined) return reason;
  return `${reason}; ${cause.correlated ? "caused by" : "server"}: ${cause.text}`;
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
  const hasCmdField = (opts.secretFields ?? []).some((f) => f.kind === "cmd");
  const secrets = opts.secrets === undefined && bound.length === 0 && !hasCmdField ? undefined : [...(opts.secrets ?? []), ...bound];
  // #324: a value a cmd: binding reads mid-run joins this run's secrets at once, so everything this
  // command writes (result, evidence, issue drafts) is scrubbed of it too, not only the loop's own.
  const runSecretCommand = opts.secretCommand;
  const secretCommand: SecretCommandRunner | undefined =
    runSecretCommand === undefined
      ? undefined
      : async (command) => {
          const out = await runSecretCommand(command);
          const value = out.trim();
          if (value !== "" && secrets !== undefined && !secrets.includes(value)) secrets.push(value);
          // #360: masked in every screenshot and video frame from now on — before the value is typed.
          if (value !== "") await capture.mask.addSecret(value);
          return out;
        };
  // The state the mission starts from — replays restore THIS fixture and rebind its recorded outputs.
  const fx = opts.fixtures;
  const missionFixture = fx === undefined ? undefined : { record: fx.record(), persisted: fx.persisted() };
  // #399: what is persisted of the fixture never holds a run secret — e.g. a fixture output the
  // Journey prefix took as a secret param (`--param inviteToken=${setup.inviteToken}`). The raw
  // record stays in memory only, for the replays that rebind it.
  const atRest = <T,>(v: T): T => redactSecretValues(v, secrets ?? []);

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
    ...serverLogRuntimeOptions(opts.serverLog),
    secrets: secrets ?? [],
    onTranscriptEntry: journal.onTranscriptEntry,
  });
  // #204: every request's correlation ids, from before the first navigation.
  serverLog?.observe(session.page);
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
    // #293: a journey-anchored run first replays its Journey's prefix into this very session.
    const start = await startFromJourney(opts.journeyPrefix, session, opts.url, opts.allowlist, opts.browser);
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
      startUrl: start.url,
      ...(start.branch === undefined ? {} : { startInPlace: true }),
      // #293: a retried run re-replays the Journey prefix instead of loading the anchor URL.
      ...(start.restart === undefined ? {} : { restartAtStart: start.restart.restartAtStart }),
      ...(opts.successAssertion === undefined ? {} : { successAssertion: opts.successAssertion }),
      ...(opts.successChecks === undefined ? {} : { successChecks: opts.successChecks }),
      ...(opts.successWhen === undefined ? {} : { successWhen: opts.successWhen }),
      ...(opts.allowVacuousChecks === true ? { allowVacuousChecks: true } : {}),
      bounds: opts.bounds,
      ...(opts.minEffort === undefined ? {} : { minEffort: opts.minEffort }),
      secrets,
      ...(opts.secretFields === undefined ? {} : { secretFields: opts.secretFields }),
      ...(secretCommand === undefined ? {} : { secretCommand }),
      ...(opts.secretCommandAttempts === undefined ? {} : { secretCommandAttempts: opts.secretCommandAttempts }),
      ...(opts.typeFixtures === undefined ? {} : { typeFixtures: opts.typeFixtures }),
      site: origin,
      fixture,
      ...conversationConfig(opts.conversation),
      ...(opts.invariants === undefined ? {} : { invariants: opts.invariants }),
      ...(opts.invariantAuthTokens === undefined ? {} : { invariantAuthTokens: opts.invariantAuthTokens }),
      ...(observers === undefined ? {} : { observers }),
      ...(opts.actors === undefined ? {} : { primaryActor: opts.actors.primary.name }),
      hostHealth: health,
      demoOverlay: demoOverlayOf(opts.browser),
      // #303 (opt-in): action deltas, with Jev's advisory relevance labels for changes code cannot tie.
      ...(opts.actionDeltas === true ? { actionDeltas: { jev: true } } : {}),
    });
    await observers?.close();

    // The mission (and its hang replays) is done: restore now, so the persisted log includes it. The
    // caller restores again on every exit path (a no-op once restored).
    await fx?.restore();
    const recording: Recording = {
      ...mission.recording,
      ...(missionFixture === undefined ? {} : { fixture: atRest(recordingFixture(missionFixture.record)) }),
      ...(resolvedEmulation === undefined ? {} : { emulation: recordingEmulation(resolvedEmulation) }),
      ...extensionsStamp(opts.browser), // #256
    };
    // Never blocks the mission itself: the drain wait happens AFTER `runGoalBasedMission` returned.
    const serverLogRun = serverLog === undefined ? undefined : await serverLog.finish(mission.transcript);
    // #423: the goal's own ending. A violated invariant's `defects-found` (#86) no longer replaces a
    // goal-only ending (`goalEnding`): defects are their own, orthogonal verdict (`defectOutcome`).
    const ownGoal: GoalBasedOutcome =
      mission.outcome === "defects-found" && mission.goalEnding !== undefined && GOAL_ONLY.has(mission.goalEnding) ? mission.goalEnding : mission.outcome;
    // #142 follow-up: an unreadable `--log-defect` oracle (and no server-log defect to show) turns an
    // otherwise-`succeeded` run `inconclusive` (exit 2) — its silence proves nothing, never clean.
    const oracleBroken = serverLogRun !== undefined && serverLogRun.defects.length === 0 && !serverLogRun.summary.oracleOk && ownGoal === "succeeded";
    const goalSoFar: GoalBasedOutcome = oracleBroken ? "inconclusive" : ownGoal;
    // #208: an HTTP 5xx is a hard-signal defect — `defects-found` even when the goal's checks held.
    const httpDefects = http5xx.defects(mission.transcript, mission.recording.pages.flatMap((p) => p.steps)[0]?.step.kind === "navigate" ? 1 : 0);
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
      defectOutcome.status === "defects" ? (goalMissionOutcome(goalSoFar, "defects") as Exclude<MissionOutcome, "clean">) : goalSoFar;
    const host = await finishHostHealth(health, preHost, {
      ...((mission.run.failure ?? mission.failure) === undefined ? {} : { failure: (mission.run.failure ?? mission.failure)! }),
      ...(preHost === mission.outcome && (mission.failure?.message ?? mission.reason) !== undefined
        ? { wouldHaveBeen: mission.failure?.message ?? mission.reason }
        : {}),
    });
    // #448: ZERO executed actions → `not-started` (never an exercised ending); passive defects stay listed.
    const failureNow = failureWithHostStarved(host, mission.run.failure ?? host.failure ?? mission.failure);
    // `--allow-vacuous-checks` is the operator's explicit acceptance of a goal that held before any action: that
    // `succeeded` stays (the flag's whole meaning), every other zero-action ending is `not-started`.
    const endedAs = host.outcome === preHost ? goalSoFar : host.outcome;
    const goalOutcome = (opts.allowVacuousChecks === true && endedAs === "succeeded" ? endedAs : startedOutcome(endedAs, mission.run.actions, failureNow?.kind)) as GoalBasedOutcome;
    // #423: THE table (domain `goalMissionOutcome`) — the exit code is unchanged for every combination.
    const missionOutcome = goalMissionOutcome(goalOutcome, defectOutcome.status);
    const goalReason = goalReasonOf({
      goalOutcome,
      ...(mission.goalEnding === undefined ? {} : { overridden: mission.goalEnding }),
      stop: mission.run.stop,
      ...(failureNow === undefined ? {} : { failureKind: failureNow.kind }),
      ...(mission.run.missCause === undefined ? {} : { missCause: mission.run.missCause }),
    });
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
      missionOutcome,
      goalOutcome,
      ...(goalReason === undefined ? {} : { goalReason }),
      issues,
      timing: mission.run.timing,
      outcome: goalOutcome,
      runOutcome: mission.run.outcome,
      ...(mission.run.answer === undefined ? {} : { answer: mission.run.answer }),
      ...(mission.run.partialReport === undefined ? {} : { partialReport: mission.run.partialReport }),
      depth: mission.run.depth,
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
      ...videos,
      ...shotFields,
      transcriptPath: journal.transcriptPath,
      transcript: serverLogRun?.transcript ?? mission.transcript,
      exitCode: missionExitCode(missionOutcome),
      resultPath,
      target: {
        seedUrl: start.persistUrl,
        allowlist: [...opts.allowlist],
        ...(primaryState !== undefined ? { storageStatePath: resolvePath(primaryState) } : {}),
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
      engine,
      ...(fx === undefined || missionFixture === undefined
        ? {}
        : {
            fixtures: atRest({
              ...missionFixture.record,
              cycles: fx.record().cycles,
              log: fx.record().log,
              ...(missionFixture.persisted.spec === undefined ? {} : { spec: missionFixture.persisted.spec }),
              ...(missionFixture.persisted.hooks === undefined ? {} : { hooks: missionFixture.persisted.hooks }),
              ...(missionFixture.persisted.identities === undefined ? {} : { identities: missionFixture.persisted.identities }),
            }),
          }),
      // #209: a goal-specific miss (`success-check-failed`, `vacuous-check`) is typed too — after an
      // engine failure or a starved host, which explain the run before the check does.
      ...((): { failure?: MissionFailure } => {
        const f = failureNow;
        return f === undefined ? {} : { failure: f };
      })(),
      ...(host.failure !== undefined
        ? { reason: host.failure.message }
        : (() => {
            // #423: `reason` stays prose — the goal's own account (with its correlated server cause),
            // then what the defect oracles found; the structured verdicts are goalOutcome/defectOutcome.
            const parts: string[] = [];
            const own = withServerCause(mission.reason, goalOutcome, serverLogRun?.transcript);
            if (own !== undefined) parts.push(own);
            if (oracleBroken) parts.push(serverLogOutcomeReason("inconclusive", serverLogRun));
            if ((serverLogRun?.defects.length ?? 0) > 0) parts.push(serverLogOutcomeReason("defects-found", serverLogRun));
            if (httpDefects.length > 0) {
              // #208: a 5xx alone on a goal whose checks held says both; otherwise it is named beside the rest.
              parts.push(parts.length === 0 ? http5xxGoalReason(httpDefects, mission.assertionPassed) : `HTTP 5xx: ${describeHttp5xx(httpDefects)}`);
            }
            return parts.length === 0 ? {} : { reason: parts.join("; ") };
          })()),
      ...declaredResult(opts.invariants, mission.invariantDefects, mission.invariants),
      ...(runUsage === undefined ? {} : { usage: runUsage.snapshot() }),
      ...serverLogResult(serverLogRun),
      defects,
      defectOutcome,
      ...host.fields,
    };
    // Persisted so `verify-fix` can replay a hang later (the typed result next to the Recording).
    writeMissionResult(journal.recordingPath, result.missionOutcome, result.exitCode, result, runUsage);
    return await withRunEvidence(result, evidenceOf(opts, secrets ?? []), triageOf(opts, serverLogRun, secrets ?? []));
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
