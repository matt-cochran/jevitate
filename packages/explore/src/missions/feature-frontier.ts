/**
 * Feature-frontier run phases (structural split of `runFeatureFrontier`).
 *
 * `runFeatureFrontier` keeps its signature and stays the orchestrator over the frontier loop; the
 * guidance below names the types it used to own. This module holds the per-iteration phases —
 * pick the next frontier item, act/probe it, record observations/invariants, decide continue/stop,
 * finalize — plus the pure record helpers and the explicit run-state object the phases thread
 * through. It never imports the original mission file (`./feature.js`); the types the helpers need
 * that used to live there (`FeatureCoverage`, `FeatureRunResult`, `FeatureMissionParams`, `Declared`)
 * moved here and are re-exported from there, so every importer and api-surface snapshot is unchanged.
 */

import type { Page } from "playwright";
import type { Actor } from "@jevitate/screenplay";
import { navigateWithStartupRetry } from "../startup-retry.js";
import {
  RecordingSchema,
  type Assertion,
  type PageSegment,
  type Recording,
  type Step,
  type StepTiming,
  type TargetDescriptor,
  type InvariantSpec,
} from "@jevitate/recording";
import { isAuthorizedExploreTarget } from "../authorized-targets.js";
import { resolveBounds, type Bounds } from "../bounds.js";
import type { Control, Snapshot } from "../snapshot.js";
import { perceive } from "../perceive.js";
import { targetCandidates, type TargetOp } from "../actions.js";
import { act } from "../act.js";
import { toPath } from "../record.js";
import { stateFingerprint, actionKey, type FrontierOp } from "../feature/fingerprint.js";
import { controlIdentity } from "../coverage/fingerprint.js";
import { Frontier, type FrontierItem } from "../feature/frontier.js";
import { chromeClassifier } from "../coverage/chrome.js";
import { StallWatchdog, StalledError } from "../stall-watchdog.js";
import { seedPath } from "./induction.js";
import { reachFrontierState } from "../feature/reach.js";
import { isInScope, type CapabilityScope } from "../feature/capability-scope.js";
import { boundaryValueCandidates, isSecretLike } from "../feature/boundary-values.js";
import { featureWords, relevanceScore, ChromeTracker } from "../feature/relevance.js";
import type { MissionFailure } from "@jevitate/domain";
import type { SettleConfig } from "../settle-config.js";
import type { HangSignal } from "../hang.js";
import { recordCoverageHang, type HangFinding } from "../hang-repro.js";
import type { HostHealthSampler } from "../host-health.js";
import { MissionSessions } from "../mission-session.js";
import type { VerifySession } from "../verify-fix.js";
import { CrashWatch, describeFailure, assertSeedReachable, describeUnreachable, isPageUnresponsive, isTargetUnresponsive, isUnreachableTarget } from "../mission-failure.js";
import { monitorFor } from "../page-monitor.js";
import { TranscriptLog, type TranscriptEntry, type TranscriptListener } from "../transcript.js";
import { seedRedirectReason } from "../seed-redirect.js";
import { blockedDepartureReason, drainBlockedDeparture, peekBlockedDeparture, seedLandingReason } from "../blocked-navigation.js";
import { MissionSafety } from "../mission-safety.js";
import type { SafetyConfig, SafetyOverride } from "../safety.js";
import type { SideEffect } from "../side-effects.js";
import {
  recordingStepCount,
  type DeclaredRun,
  type InvariantDefect,
  type InvariantReport,
} from "../declared-invariants.js";
import { BudgetMonitor, type BudgetTrajectory } from "../budget.js";
import type { DemoOverlay } from "../demo-overlay.js";

export interface FeatureCoverage {
  pathsDiscovered: number;
  statesExercised: number;
  transitionsExercised: number;
  /** urls that were reached but fell outside scope (the feature's perimeter). Deduplicated. */
  boundaryEdges: string[];
  /**
   * Count of executed actions that (a) succeeded, (b) landed in scope, and
   * (c) were not flagged as global chrome (`feature/relevance.ts`'s
   * `ChromeTracker`) — i.e. actions that genuinely exercised the named
   * capability. Zero means the run proved nothing about `scope.name`,
   * whatever the loop's own stop reason was — `runFeatureCliMission` turns
   * that into `missionOutcome: "inconclusive"`, never a fabricated `"clean"`.
   */
  inScopeActionsExercised: number;
  /**
   * #209: of those, the actions on a control RELEVANT to the feature — one whose name/label/testId/
   * role shares a word with the feature text (`relevance > 0`). Zero means every control exercised
   * was unrelated to the named capability (all `relevance=0`): the run proved nothing about it
   * either, and `runFeatureCliMission` reports it `inconclusive` like the chrome-only case.
   */
  relevantActionsExercised: number;
  /** #209: the feature words relevance was judged against (empty: the feature text had none). */
  featureWords: string[];
}

export interface FeatureRunResult {
  /**
   * `crashed`: the engine failed; the paths discovered up to the failure are still returned.
   * `hang`: stopped at a hang it could not reset from (an unresponsive page, no fresh session).
   * `scope-unreachable`: the seed redirected elsewhere (e.g. a lost `--storage-state` session
   * bounced to a login page) — the run never got to test the capability it was asked to (#82) — or,
   * mid-run, the frontier could not return to the seed after a departure (#114).
   * `stalled`: no step completed within the stall watchdog's bound (#114).
   */
  outcome: "exhausted" | "cap" | "path-cap" | "crashed" | "hang" | "scope-unreachable" | "stalled" | "budget";
  /** Hangs met while exploring (deduped by fingerprint), each with its fresh-context reproduction. */
  hangs: HangFinding[];
  /** Why the run crashed, could not reach its target, or stalled. */
  failure?: MissionFailure;
  coverage: FeatureCoverage;
  recordings: Recording[];
  /** The shared decision transcript: each ranked frontier action, whether it landed, in/out of scope, and chrome. */
  transcript: TranscriptEntry[];
  /** Declared-invariant violations (#86), each with the path Recording that reproduces it. */
  invariantDefects?: InvariantDefect[];
  /** Per declared invariant: how often it applied, held, was violated, or could not be read. */
  invariants?: InvariantReport[];
  /** The writes the frontier's actions fired (#116), marked when the control was paid / destructive. */
  sideEffects?: SideEffect[];
  sideEffectsTruncated?: number;
  /** #428: every --allow-control exemption the run used (regex, control, the soft rule it waived, step). */
  safetyOverrides?: SafetyOverride[];
  /** Declared mission spend budgets (#150): the observed trajectory, present when any were declared. */
  budget?: BudgetTrajectory[];
}

export type FeatureMissionParams = {
  page: Page;
  actor: Actor;
  seedUrl: string;
  allowlist: readonly string[];
  scope: CapabilityScope;
  bounds?: Partial<Bounds>;
  maxDepth?: number;
  maxPaths?: number;
  /** Bound (ms) on waiting for a rendered page on each perception. Default `RENDER_WAIT_MS` — the shared settle rule
   *  recognises a control-free leaf state in about the quiet window, so no shorter coverage bound is needed. */
  renderWaitMs?: number;
  /** The target's settle configuration (background requests, long-poll threshold). */
  settle?: SettleConfig;
  /** Opens a FRESH browser session: reproduces a hang and resets to it after one. */
  openFreshSession?: () => Promise<VerifySession>;
  /** Fresh-context replays that confirm a hang. Default 2. */
  hangReplays?: number;
  /** The run's host-health sampler (#203): a hang met while the host was starved is `environment-degraded`, never a finding. */
  readonly hostHealth?: HostHealthSampler;
  /** Incremental-flush seam: every transcript entry, as it is recorded. */
  onTranscriptEntry?: TranscriptListener;
  /** App-declared invariants (#86): evaluated around every frontier action; a violation is a hard defect. */
  invariants?: InvariantSpec;
  /** Registered secrets: redacted out of invariant values and evidence. */
  secrets?: readonly string[];
  /** Resolved `authFrom.secret` refs (#135) a declared probe may use: `env:VAR` → its value. */
  invariantAuthTokens?: ReadonlyMap<string, string>;
  /** No-progress watchdog (#114): the run ends `stalled` when no step completes within this bound. Default 120s. */
  stallTimeoutMs?: number;
  /** Bound (ms) on one reset-and-replay back to a queued state. Default `DEFAULT_REACH_TIMEOUT_MS`. */
  reachTimeoutMs?: number;
  /** The shared safety policy (#116): session-ending / destructive / paid / --deny'd controls are never clicked. */
  safety?: SafetyConfig;
  /** #245: show the on-page demo overlay (display only; invisible to the run). Default off: nothing injected. */
  demoOverlay?: boolean;
};

/** Declared invariants (#86) for a frontier mission: the monitor and the defects it found. */
export type Declared = DeclaredRun;

const TIMING: StepTiming = { atMs: 0, durationMs: 0, gapBeforeMs: 0 };

/** The ops the feature frontier issues — never `upload` (the mission carries no fixture). */
const FRONTIER_OPS: ReadonlySet<TargetOp> = new Set<TargetOp>(["click", "type", "select"]);

/** #277: how many times a seed that re-rendered differently on a reset is queued afresh. */
export const MAX_SEED_REQUEUES = 3;

/**
 * The frontier candidates a state offers, by the SHARED affordance mapping (`affordedOp`,
 * ./actions.ts) — the same op the goal loop would use on each control.
 */
export function frontierCandidates(controls: readonly Control[]): Array<{ control: Control; op: FrontierOp }> {
  const out: Array<{ control: Control; op: FrontierOp }> = [];
  for (const c of targetCandidates(controls, { ops: FRONTIER_OPS })) {
    if (c.op === "click" || c.op === "type" || c.op === "select") out.push({ control: c.control, op: c.op });
  }
  return out;
}

/**
 * The same candidates, RANKED by relevance to the feature words (ticket #78):
 * highest-scoring first, so a capability-relevant control (e.g. "Buy pack" for
 * `--feature "buy a pack"`) is tried well before de-prioritised global chrome
 * (header/nav landmarks, theme toggles, account menus, command palettes — see
 * `ChromeTracker`). A stable sort keeps original DOM order among equal scores.
 */
export function rankedFrontierCandidates(
  controls: readonly Control[],
  words: readonly string[],
  chrome: ChromeTracker,
): Array<{ control: Control; op: FrontierOp }> {
  return frontierCandidates(controls)
    .map((c, i) => ({ ...c, i, score: relevanceScore(c.control, words, chrome) }))
    .sort((a, b) => b.score - a.score || a.i - b.i);
}

export function pathnameOf(url: string): string {
  try {
    return new URL(url).pathname;
  } catch {
    return url;
  }
}

export function seedRecording(seedUrl: string, site: string): Recording {
  // WITH the seed's query (#114): `/workspace?inquiry=…` without it is a different page, so every
  // reset would land elsewhere and every queued item would go stale.
  const path = seedPath(seedUrl);
  return {
    version: "1.0.0",
    site,
    pages: [
      { url: path, steps: [{ step: { kind: "navigate", url: path, expect: { kind: "urlIncludes", text: path } }, timing: TIMING }] },
    ],
  };
}

/**
 * Pure, immutable append: prefix + one executed step → a new schema-valid,
 * replayable Recording. Mirrors `RunRecorder`'s record-before-reobserve
 * discipline (a navigating step gets a `urlIncludes` postcondition and opens
 * the next page segment); a non-navigating step gets a `visible` postcondition.
 */
export function extendRecording(
  prefix: Recording,
  op: FrontierOp,
  descriptor: TargetDescriptor,
  value: string | undefined,
  navigatedToPath: string | null,
): Recording {
  const pages: PageSegment[] = structuredClone(prefix.pages);
  // A feature path always starts with its seed navigate segment (`seedRecording`); a prefix with no
  // page segment is not a path this mission produced, so it is rejected rather than guessed at.
  const last = pages.at(-1);
  if (last === undefined) throw new Error("extendRecording: path prefix has no page segment");
  const expect: Assertion =
    navigatedToPath !== null ? { kind: "urlIncludes", text: navigatedToPath } : { kind: "visible", target: { ...descriptor } };

  let step: Step;
  if (op === "click") step = { kind: "click", target: { ...descriptor }, expect };
  else if (op === "type") step = { kind: "fill", target: { ...descriptor }, value: { redacted: false, value: value ?? "" }, expect };
  else step = { kind: "select", target: { ...descriptor }, value: { redacted: false, value: value ?? "" }, expect };

  last.steps.push({ step, timing: TIMING });
  if (navigatedToPath !== null) pages.push({ url: navigatedToPath, steps: [] });
  return RecordingSchema.parse({ version: prefix.version, site: prefix.site, pages });
}

/**
 * The frontier loop's explicit run state: every closure variable `runFeatureFrontier` used to keep
 * (names unchanged), plus its inputs. The per-iteration phases mutate it and return discriminated
 * values; the orchestrator keeps the early returns.
 */
export interface FrontierRun {
  readonly params: FeatureMissionParams;
  readonly declared: Declared | null;
  readonly safety: MissionSafety;
  readonly budget: BudgetMonitor | null;
  readonly overlay: DemoOverlay | null;
  readonly bounds: Bounds;
  readonly maxDepth: number;
  readonly maxPaths: number;
  readonly inScope: (url: string) => boolean;
  readonly sessions: MissionSessions;
  readonly hangs: Map<string, HangFinding>;
  /** The hang the latest perception saw (a holder: it is set inside the perception closure). */
  readonly seenHang: { last: HangSignal | null };
  readonly snapshotNow: () => Promise<Snapshot>;
  /** The crash watch, re-created on every session reset (a holder, so the reset callback can swap it). */
  readonly crashWatch: { current: CrashWatch };
  readonly visited: Set<string>;
  readonly boundaryEdgeSet: Set<string>;
  readonly leaves: Map<string, Recording>;
  readonly extended: Set<string>;
  transitionsExercised: number;
  pathsDiscovered: number;
  inScopeActionsExercised: number;
  relevantActionsExercised: number;
  readonly words: string[];
  readonly chrome: ChromeTracker;
  readonly watchdog: StallWatchdog;
  readonly guard: <T>(work: Promise<T>) => Promise<T>;
  readonly transcript: TranscriptLog;
  readonly frontier: Frontier;
  readonly seedRec: Recording;
  departed: boolean;
  actions: number;
  seedRequeues: number;
  currentFingerprint: string;
}

/**
 * Build the run state synchronously — the same initializers, in the same order, with the same
 * listeners attached as the original head of `runFeatureFrontier`. No page work happens here.
 */
export function createFrontierRun(
  params: FeatureMissionParams,
  declared: Declared | null,
  safety: MissionSafety,
  budget: BudgetMonitor | null,
  overlay: DemoOverlay | null,
): FrontierRun {
  const bounds = resolveBounds(params.bounds);
  const maxDepth = params.maxDepth ?? 10;
  const maxPaths = params.maxPaths ?? 20;
  const site = new URL(params.seedUrl).origin;
  // #277: the seed page is where the operator started the mission, so staying on it never "leaves the
  // scope" — even when the route globs only name its sub-routes (`--url …/projects --route '/projects/**'`).
  // Otherwise every action on the seed reads as a departure and its in-scope navigation is never followed.
  const seedPathname = pathnameOf(params.seedUrl);
  const inScope = (url: string): boolean => {
    if (isInScope(url, params.scope)) return true;
    try {
      const u = new URL(url);
      return u.origin === site && u.pathname === seedPathname;
    } catch {
      return false;
    }
  };

  const sessions = new MissionSessions({ page: params.page, actor: params.actor }, params.openFreshSession);
  const hangs = new Map<string, HangFinding>();
  const seenHang: { last: HangSignal | null } = { last: null };

  // Shared perception (render wait + occlusion): a state is never fingerprinted from a blank,
  // still-rendering frame — including right after a reset-and-replay.
  const snapshotNow = async (): Promise<Snapshot> => {
    const p = await perceive(sessions.page, {
      maxCandidates: bounds.maxCandidates,
      ...(params.secrets === undefined ? {} : { secrets: params.secrets }),
      ...(params.renderWaitMs === undefined ? {} : { renderWaitMs: params.renderWaitMs }),
      ...(params.settle === undefined ? {} : { settleConfig: params.settle }),
    });
    seenHang.last = p.hang;
    return p.snapshot;
  };

  const crashWatch = { current: new CrashWatch(sessions.page) };
  declared?.monitor.attach(sessions.page);
  sessions.onReset((page) => {
    crashWatch.current = new CrashWatch(page);
    declared?.monitor.attach(page);
  });

  // No-progress watchdog (#114): every recorded step kicks it; every await on the page is guarded.
  const watchdog = new StallWatchdog(params.stallTimeoutMs);
  const guard = <T>(work: Promise<T>): Promise<T> => watchdog.guard(work);
  const transcript = new TranscriptLog([], (entry, all) => {
    watchdog.kick("choosing the next frontier action");
    params.onTranscriptEntry?.(entry, all);
  });

  // Ranking inputs (ticket #78): feature words drive lexical relevance; the
  // chrome tracker accumulates cross-page control repetition as it's observed.
  const words = featureWords(params.scope.name);
  const chrome = new ChromeTracker();
  const frontier = new Frontier({ classify: chromeClassifier({ chrome, inScope }) });
  const seedRec = seedRecording(params.seedUrl, site);

  return {
    params,
    declared,
    safety,
    budget,
    overlay,
    bounds,
    maxDepth,
    maxPaths,
    inScope,
    sessions,
    hangs,
    seenHang,
    snapshotNow,
    crashWatch,
    visited: new Set<string>(),
    boundaryEdgeSet: new Set<string>(),
    leaves: new Map<string, Recording>(),
    extended: new Set<string>(),
    transitionsExercised: 0,
    pathsDiscovered: 1, // the seed state counts as the first path
    inScopeActionsExercised: 0,
    relevantActionsExercised: 0,
    words,
    chrome,
    watchdog,
    guard,
    transcript,
    frontier: frontier,
    seedRec,
    departed: false,
    actions: 0,
    seedRequeues: 0,
    currentFingerprint: "",
  };
}

/** A candidate the safety policy refuses is withheld at push time (#186), its refusal recorded once. */
export function withheld(run: FrontierRun, control: Control, op: FrontierOp, on: Snapshot): boolean {
  return run.safety.withholds(op, control, (reason, refusal) =>
    run.transcript.record({
      op: null,
      control,
      confidence: null,
      chosenBy: "strategy",
      strategy: "safety-policy",
      origin: "engine",
      actOk: false,
      reason,
      safety: refusal,
      snapshot: on,
    }),
  );
}

/** Build the result the loop returns at every stop (the original local `endRun`). */
export function finishFrontierRun(run: FrontierRun, outcome: FeatureRunResult["outcome"], failure?: MissionFailure): FeatureRunResult {
  return {
    outcome,
    ...(failure === undefined ? {} : { failure }),
    coverage: {
      pathsDiscovered: run.pathsDiscovered,
      statesExercised: run.visited.size,
      transitionsExercised: run.transitionsExercised,
      boundaryEdges: [...run.boundaryEdgeSet],
      inScopeActionsExercised: run.inScopeActionsExercised,
      relevantActionsExercised: run.relevantActionsExercised,
      featureWords: [...run.words],
    },
    recordings: [...run.leaves.entries()].filter(([fp]) => !run.extended.has(fp)).map(([, r]) => r),
    hangs: [...run.hangs.values()],
    transcript: run.transcript.entries(),
  };
}

/** The typed stop the original `catch` produced. */
export function handleFrontierError(run: FrontierRun, e: unknown): FeatureRunResult {
  // The watchdog fired (#114): a typed `stalled` stop with every path found so far, never an idle run.
  if (e instanceof StalledError) return finishFrontierRun(run, "stalled", { kind: "stalled", message: e.reason });
  // Engine failure: a typed `crashed` result carrying every path discovered so far.
  const failure = describeFailure(e, run.crashWatch.current.signals());
  // #226: the app stopped answering navigation (a frozen backend): the run stopped short of its
  // target — the same `inconclusive` ending as losing the seed, with the typed reason, never `crashed`.
  // #296: a page whose renderer stopped answering (closed by the liveness watchdog) is `stalled`.
  return finishFrontierRun(run, isTargetUnresponsive(failure) ? "scope-unreachable" : isPageUnresponsive(failure) ? "stalled" : "crashed", failure);
}

export type FrontierSetup = { readonly kind: "return"; readonly result: FeatureRunResult } | { readonly kind: "ready"; readonly snap: Snapshot };

/**
 * Load the seed and prime the frontier: reachability, the first snapshot, the redirect and
 * budget-baseline gates, and the seed's own candidates. Returns a typed stop instead of throwing
 * where the original returned early.
 */
export async function setupFrontierRun(run: FrontierRun): Promise<FrontierSetup> {
  const { params, sessions, watchdog, guard } = run;
  watchdog.during("loading the seed");
  await guard(monitorFor(sessions.page).instrument());
  run.safety.attach(monitorFor(sessions.page));
  // #128: real network evidence for the FIRST navigation — a refused connection can still
  // surface as a bare navigation timeout.
  let firstNavNetError: string | null = null;
  const onFirstNavRequestFailed = (req: { failure(): { errorText: string } | null }): void => {
    const text = req.failure()?.errorText;
    if (text !== undefined) firstNavNetError = text;
  };
  sessions.page.on("requestfailed", onFirstNavRequestFailed);
  try {
    await guard(assertSeedReachable(sessions.actor, params.seedUrl));
    await guard(navigateWithStartupRetry(sessions.actor, params.seedUrl));
  } catch (e) {
    const message = e instanceof Error ? (e.message.split("\n")[0] ?? e.message) : String(e);
    // #521: a seed load cut short by a navigation the opt-in guard stopped is no unreachable target —
    // the page stayed on the seed; the seed check below reads where it tried to go.
    if (peekBlockedDeparture(sessions.actor) === undefined) {
      if (!isUnreachableTarget(message) && !isUnreachableTarget(firstNavNetError ?? "")) throw e;
      // The seed itself could not be loaded: never a defect in the app, never a bug in jevitate —
      // a configuration problem. `inconclusive`, never `crashed`; no crash report/issue drafted.
      return {
        kind: "return",
        result: finishFrontierRun(run, "scope-unreachable", {
          kind: "target-unreachable",
          message: `target unreachable (${describeUnreachable(message, firstNavNetError)})`,
        }),
      };
    }
  } finally {
    sessions.page.off("requestfailed", onFirstNavRequestFailed);
  }
  const snap = await guard(run.snapshotNow());

  // The seed redirected elsewhere — most often a lost/expired `--storage-state` session bounced
  // to a login page (#82): the run cannot exercise the capability it was asked to.
  // #521: a seed navigation the opt-in guard stopped is where the seed went (the page stayed put).
  const redirect = seedLandingReason(params.seedUrl, snap.url, drainBlockedDeparture(sessions.actor));
  if (redirect !== null) {
    return { kind: "return", result: finishFrontierRun(run, "scope-unreachable", { kind: "target-unreachable", message: redirect.reason }) };
  }
  run.chrome.observe(pathnameOf(snap.url), snap.controls);
  run.currentFingerprint = stateFingerprint(snap);
  run.visited.add(run.currentFingerprint);

  // #150 — a budget's baseline is read once, on the seed's settled snapshot, before any action.
  // An unreadable baseline fails closed by default (`onUnreadable: "stop"`).
  if (run.budget !== null) {
    const b = await guard(run.budget.baseline(sessions.page));
    if (b.crossed) {
      run.transcript.record({
        op: null,
        control: null,
        confidence: null,
        chosenBy: "strategy",
        strategy: "budget",
        actOk: false,
        reason: b.reason ?? "budget observable unreadable at run start",
        snapshot: snap,
      });
      return { kind: "return", result: finishFrontierRun(run, "budget") };
    }
  }

  // Chrome last (#115): nav/header/footer landmarks, controls repeated across pathnames and links out
  // of scope are tried only once the capability's own controls are exhausted, each destination once.
  run.leaves.set(run.currentFingerprint, run.seedRec);
  for (const { control, op } of rankedFrontierCandidates(snap.controls, run.words, run.chrome)) {
    if (withheld(run, control, op, snap)) continue;
    run.frontier.push({ key: actionKey(run.currentFingerprint, control, op), fromFingerprint: run.currentFingerprint, pathPrefix: run.seedRec, control, op });
  }
  return { kind: "ready", snap };
}

export type FrontierStepResult =
  | { readonly kind: "continue"; readonly snap: Snapshot }
  | { readonly kind: "break"; readonly snap: Snapshot }
  | { readonly kind: "return"; readonly result: FeatureRunResult };

/**
 * One turn of the frontier loop: cap checks, pick, reach, plan, act, observe, budget, hang, finalize.
 * Every early `return endRun(…)` stays here; the phases return discriminated values.
 */
export async function runFrontierIteration(run: FrontierRun, snapIn: Snapshot): Promise<FrontierStepResult> {
  let snap = snapIn;
  if (run.actions >= run.bounds.maxActions) return { kind: "return", result: finishFrontierRun(run, "cap") };
  if (run.pathsDiscovered >= run.maxPaths) return { kind: "return", result: finishFrontierRun(run, "path-cap") };

  const picked = pickFrontierItem(run);
  if (picked.kind === "break") return { kind: "break", snap };
  if (picked.kind === "continue") return { kind: "continue", snap };

  const reached = await reachQueuedState(run, picked.item, snap);
  if (reached.kind === "continue") return { kind: "continue", snap: reached.snap };
  if (reached.kind === "return") return { kind: "return", result: reached.result };
  snap = reached.snap;

  const planned = planFrontierAction(run, snap, picked.item);
  if (planned.kind === "continue") return { kind: "continue", snap };

  const acted = await actFrontierItem(run, planned.plan);
  if (acted.kind === "continue") return { kind: "continue", snap };

  const observed = await observeFrontierAction(run, planned.plan);
  snap = observed.snap;

  const budgetResult = await checkFrontierBudget(run, planned.plan, observed);
  if (budgetResult !== null) return { kind: "return", result: budgetResult };

  const hung = await handleFrontierHang(run, planned.plan, observed);
  if (hung.kind === "continue") return { kind: "continue", snap };
  if (hung.kind === "return") return { kind: "return", result: hung.result };

  return finalizeFrontierStep(run, planned.plan, observed);
}

export type PickResult =
  | { readonly kind: "item"; readonly item: FrontierItem }
  | { readonly kind: "continue" }
  | { readonly kind: "break" };

/** Pick the next queued item and drop the ones that prove nothing new. */
export function pickFrontierItem(run: FrontierRun): PickResult {
  const item = run.frontier.popPreferring(run.currentFingerprint);
  if (item === undefined) return { kind: "break" };
  const depth = item.pathPrefix.pages.reduce((n, p) => n + p.steps.length, 0);
  if (depth >= run.maxDepth) return { kind: "continue" };
  // A link to a boundary already recorded proves nothing new: shared nav repeated on every
  // in-scope state would otherwise be re-clicked once per state (the states multiply as
  // in-scope controls toggle), so the run never exhausts.
  if (item.control.href != null && !run.inScope(item.control.href) && run.boundaryEdgeSet.has(item.control.href)) return { kind: "continue" };
  return { kind: "item", item };
}

export type ReachStep =
  | { readonly kind: "reached"; readonly snap: Snapshot }
  | { readonly kind: "continue"; readonly snap: Snapshot }
  | { readonly kind: "return"; readonly result: FeatureRunResult };

/**
 * Reset-and-replay back to the state `item` must run from (or a no-op when it already is the
 * current state), including the #277 stale-seed requeue. Returns a typed stop when the seed is gone.
 */
export async function reachQueuedState(run: FrontierRun, item: FrontierItem, snapIn: Snapshot): Promise<ReachStep> {
  if (item.fromFingerprint === run.currentFingerprint) return { kind: "reached", snap: snapIn };
  let snap = snapIn;
  run.watchdog.during(run.departed ? "returning to the seed after a departure" : "resetting to a queued state");
  const reached = await run.guard(
    reachFrontierState({
      actor: run.sessions.actor,
      item,
      snapshotNow: run.snapshotNow,
      homeUrl: run.params.seedUrl,
      currentUrl: () => run.sessions.page.url(),
      ...(run.params.reachTimeoutMs === undefined ? {} : { timeoutMs: run.params.reachTimeoutMs }),
    }),
  );
  if (!reached.ok) {
    if (reached.reason !== "stale") {
      // The seed is gone (a lost session) or stopped answering: a typed stop, never an idle grind (#114).
      return {
        kind: "return",
        result: finishFrontierRun(run, "scope-unreachable", {
          kind: "target-unreachable",
          message: `could not return to the seed${run.departed ? " after a departure" : ""} (${reached.detail ?? reached.reason})`,
        }),
      };
    }
    // Stale — dropped, and so is every other item replaying the same path (#114).
    run.frontier.dropState(item.fromFingerprint);
    run.currentFingerprint = "";
    // #277: the SEED itself re-rendered differently (a dismissed banner that stays dismissed, a
    // list that changed): its queued controls are gone with it, so the seed as it renders NOW is
    // queued afresh — the run keeps following its in-scope navigation instead of ending at the
    // seed. Bounded: a seed that differs on every load is re-queued at most MAX_SEED_REQUEUES times.
    if (item.pathPrefix === run.seedRec && run.seedRequeues < MAX_SEED_REQUEUES) {
      const fresh = await run.guard(run.snapshotNow());
      const freshFp = stateFingerprint(fresh);
      if (run.seenHang.last === null && run.inScope(fresh.url) && seedRedirectReason(run.params.seedUrl, fresh.url) === null && !run.visited.has(freshFp)) {
        run.seedRequeues += 1;
        snap = fresh;
        run.chrome.observe(pathnameOf(snap.url), snap.controls);
        run.visited.add(freshFp);
        run.leaves.set(freshFp, run.seedRec);
        for (const { control, op } of rankedFrontierCandidates(snap.controls, run.words, run.chrome)) {
          if (withheld(run, control, op, snap)) continue;
          run.frontier.push({ key: actionKey(freshFp, control, op), fromFingerprint: freshFp, pathPrefix: run.seedRec, control, op });
        }
        run.currentFingerprint = freshFp;
      }
    }
    return { kind: "continue", snap };
  }
  run.departed = false;
  snap = reached.snapshot;
  run.chrome.observe(pathnameOf(snap.url), snap.controls);
  run.currentFingerprint = item.fromFingerprint;
  return { kind: "reached", snap };
}

export interface FrontierActionPlan {
  readonly item: FrontierItem;
  readonly fillText: string | undefined;
  readonly beforeUrl: string;
  readonly decidedOn: Snapshot;
  readonly itemScore: number;
  readonly itemWasChrome: boolean;
  readonly rankReason: string;
}

export type PlanResult = { readonly kind: "plan"; readonly plan: FrontierActionPlan } | { readonly kind: "continue" };

/**
 * Decide whether `item` is actionable — a secret-like field yields NO candidate and is skipped
 * entirely (guardrail #3), and a safety refusal is recorded once — and capture the values the
 * action and its records need.
 */
export function planFrontierAction(run: FrontierRun, snap: Snapshot, item: FrontierItem): PlanResult {
  // Boundary-value stimulation on type; a secret-like field yields NO
  // candidate and is skipped entirely (guardrail #3 — never synthesized).
  const fillText = item.op === "type" && !isSecretLike(item.control) ? boundaryValueCandidates(item.control)[0] : undefined;
  if (item.op === "type" && fillText === undefined) return { kind: "continue" };

  const itemScore = relevanceScore(item.control, run.words, run.chrome);
  const itemWasChrome = run.chrome.isChrome(item.control);
  const rankReason = `relevance=${itemScore} chrome=${itemWasChrome}`;
  // The shared safety policy (#116): a session-ending / destructive / paid control is never
  // clicked; the refusal is recorded once per control.
  const unsafe = run.safety.gate(item.op, item.control);
  if (unsafe !== null) {
    if (unsafe.first) {
      run.transcript.record({
        op: null,
        control: item.control,
        confidence: null,
        chosenBy: "strategy",
        strategy: "safety-policy",
        origin: "engine",
        actOk: false,
        reason: unsafe.reason,
        safety: unsafe.refusal,
        snapshot: snap,
      });
    }
    return { kind: "continue" };
  }
  return { kind: "plan", plan: { item, fillText, beforeUrl: snap.url, decidedOn: snap, itemScore, itemWasChrome, rankReason } };
}

export type ActResult = { readonly kind: "ok" } | { readonly kind: "continue" };

/** Announce and dispatch one frontier action, recording a failed attempt as the original did. */
export async function actFrontierItem(run: FrontierRun, plan: FrontierActionPlan): Promise<ActResult> {
  const { item, fillText, decidedOn, rankReason } = plan;
  // #245: the demo overlay says what is about to happen and highlights the target (display only).
  if (run.overlay !== null) {
    await run.overlay.announce(
      run.sessions.page,
      {
        step: run.transcript.nextStep,
        strategy: "feature",
        op: item.op,
        target: item.control.name || item.control.summary,
        why: `exercise the "${run.params.scope.name}" capability`,
      },
      item.control,
    );
  }
  run.watchdog.during(`acting on "${item.control.name || item.op}"`);
  if (run.declared !== null) await run.guard(run.declared.monitor.before(run.sessions.actor));
  run.safety.mark(run.transcript.nextStep, item.op, item.control);
  const result = await run.guard(act(run.sessions.actor, { op: item.op, control: item.control, value: fillText ?? null }));
  run.actions += 1;
  run.frontier.recordAttempt();
  if (!result.ok) {
    run.transcript.record({
      op: item.op,
      control: item.control,
      confidence: null,
      chosenBy: "strategy",
      strategy: "feature-frontier",
      actOk: false,
      reason: result.reason === undefined ? rankReason : `${rankReason}; ${result.reason}`,
      snapshot: decidedOn,
    });
    return { kind: "continue" };
  }
  return { kind: "ok" };
}

export interface FrontierObservation {
  readonly snap: Snapshot;
  readonly blockedTo: string | undefined;
  readonly newFingerprint: string;
  readonly branch: Recording;
}

/**
 * Re-observe the settled state the action produced (record-before-reobserve), fold in the
 * transition bookkeeping, and judge declared invariants (#86) against the new state.
 */
export async function observeFrontierAction(run: FrontierRun, plan: FrontierActionPlan): Promise<FrontierObservation> {
  const snap = await run.guard(run.snapshotNow());
  // #521: a navigation the opt-in guard stopped (the page stayed put) is a departure all the same.
  const blockedTo = drainBlockedDeparture(run.sessions.actor);
  run.chrome.observe(pathnameOf(snap.url), snap.controls);
  const navigatedToPath = toPath(plan.beforeUrl) !== toPath(snap.url) ? toPath(snap.url) : null;
  const newFingerprint = stateFingerprint(snap);
  // #160: a not-yet-exercised control is preferred over one already acted on (#75's own
  // preference, never previously wired into this mission), and a toggle exercised once in
  // each direction is dropped for the rest of the run instead of oscillating forever.
  run.frontier.markExercised(controlIdentity(plan.item.control));
  run.frontier.noteTransition(plan.item.fromFingerprint, plan.item.control, newFingerprint);
  const branch = extendRecording(plan.item.pathPrefix, plan.item.op, plan.item.control.descriptor, plan.fillText, navigatedToPath);
  run.transitionsExercised += 1;
  run.extended.add(plan.item.fromFingerprint);
  if (run.declared !== null && run.seenHang.last === null) {
    // Declared invariants (#86): judged on the settled state the action produced; the finding
    // replays this very path (the seed navigate is its first step).
    const path = { ...branch, pages: branch.pages.filter((p) => p.steps.length > 0) };
    const checked = await run.guard(run.declared.monitor.after(run.sessions.actor, { op: plan.item.op, control: plan.item.control.name, url: plan.beforeUrl }));
    run.declared.lastRepro = { recordingStepIndex: recordingStepCount(path) - 1, recording: path };
    for (const v of checked.violations) run.declared.log.add(v, run.declared.lastRepro);
  }
  return { snap, blockedTo, newFingerprint, branch };
}

/**
 * #150 — post-settle: a crossed budget stops the mission cleanly, before its next action.
 * Returns the typed stop, or null when there is no crossed budget.
 */
export async function checkFrontierBudget(run: FrontierRun, plan: FrontierActionPlan, obs: FrontierObservation): Promise<FeatureRunResult | null> {
  if (run.budget === null || run.seenHang.last !== null) return null;
  const b = await run.guard(run.budget.afterSettle(run.sessions.page, run.transitionsExercised));
  if (!b.crossed) return null;
  run.transcript.record({
    op: plan.item.op,
    control: plan.item.control,
    confidence: null,
    chosenBy: "strategy",
    strategy: "budget",
    actOk: true,
    reason: b.reason ?? "mission budget crossed",
    snapshot: obs.snap,
  });
  return finishFrontierRun(run, "budget");
}

export type HangResult = { readonly kind: "none" } | { readonly kind: "continue" } | { readonly kind: "return"; readonly result: FeatureRunResult };

/**
 * A hang: record it (reproduced from the path that led here), reset to a known state and keep
 * exploring the rest of the frontier. The hung state is never expanded.
 */
export async function handleFrontierHang(run: FrontierRun, plan: FrontierActionPlan, obs: FrontierObservation): Promise<HangResult> {
  const hang = run.seenHang.last;
  if (hang === null || obs.blockedTo !== undefined) return { kind: "none" };
  run.transcript.record({
    op: plan.item.op,
    control: plan.item.control,
    confidence: null,
    chosenBy: "strategy",
    strategy: "feature-frontier",
    actOk: true,
    reason: `${plan.rankReason}; hang (${hang.kind}): ${hang.detail}`,
    snapshot: plan.decidedOn,
  });
  run.watchdog.suspend(); // the reproduction is bounded on its own (fresh contexts, bounded replays)
  await recordCoverageHang({
    hang,
    recording: { ...obs.branch, pages: obs.branch.pages.filter((p) => p.steps.length > 0) },
    steps: [],
    found: run.hangs,
    ...(run.params.safety === undefined ? {} : { safety: run.params.safety }),
    ...(run.params.openFreshSession === undefined ? {} : { openSession: run.params.openFreshSession }),
    ...(run.params.hangReplays === undefined ? {} : { attempts: run.params.hangReplays }),
    ...(run.params.hostHealth === undefined ? {} : { hostHealth: run.params.hostHealth }),
    // #230: an app that stopped answering ends the run target-unresponsive, never a hang finding.
    liveness: { pageUrl: run.sessions.page.url(), authorized: (u) => isAuthorizedExploreTarget(u, run.params.allowlist) },
    // Re-detected with the SAME perception bounds the mission used.
    perceive: {
      ...(run.params.secrets === undefined ? {} : { secrets: run.params.secrets }),
      ...(run.params.renderWaitMs === undefined ? {} : { renderWaitMs: run.params.renderWaitMs }),
      ...(run.params.settle === undefined ? {} : { settleConfig: run.params.settle }),
    },
  });
  run.watchdog.kick("resetting after a hang");
  if (!(await run.guard(run.sessions.reset(hang)))) return { kind: "return", result: finishFrontierRun(run, "hang") };
  await run.guard(monitorFor(run.sessions.page).instrument());
  run.safety.attach(monitorFor(run.sessions.page));
  run.currentFingerprint = ""; // the next item is reached afresh from the seed
  return { kind: "continue" };
}

/**
 * Record the action's landing (transcript, boundary edges, visited states) and, for a newly
 * discovered in-scope state, queue its candidates — exactly the original tail of the loop body.
 */
export function finalizeFrontierStep(run: FrontierRun, plan: FrontierActionPlan, obs: FrontierObservation): FrontierStepResult {
  const { snap, blockedTo, newFingerprint, branch } = obs;
  const landedInScope = blockedTo === undefined && run.inScope(snap.url);
  run.transcript.record({
    op: plan.item.op,
    control: plan.item.control,
    confidence: null,
    chosenBy: "strategy",
    strategy: "feature-frontier",
    actOk: true,
    reason: `${plan.rankReason}; inScope=${landedInScope}${blockedTo === undefined ? "" : `; ${blockedDepartureReason(blockedTo)}`}`,
    snapshot: plan.decidedOn,
  });

  if (!landedInScope) {
    // Out of scope — recorded as a boundary edge (deduplicated), never
    // expanded (guardrail #4). Never counted as a discovered feature path.
    run.boundaryEdgeSet.add(blockedTo ?? snap.url);
    run.leaves.set(newFingerprint, branch);
    run.currentFingerprint = newFingerprint;
    run.departed = true;
    return { kind: "continue", snap };
  }

  if (!plan.itemWasChrome) {
    run.inScopeActionsExercised += 1;
    // #209: relevance is the ranking's own lexical score (no chrome penalty on a non-chrome item).
    if (plan.itemScore > 0) run.relevantActionsExercised += 1;
  }

  if (!run.visited.has(newFingerprint)) {
    run.visited.add(newFingerprint);
    run.leaves.set(newFingerprint, branch);
    run.pathsDiscovered += 1;
    for (const { control, op } of rankedFrontierCandidates(snap.controls, run.words, run.chrome)) {
      if (withheld(run, control, op, snap)) continue;
      run.frontier.push({ key: actionKey(newFingerprint, control, op), fromFingerprint: newFingerprint, pathPrefix: branch, control, op });
    }
  }
  run.currentFingerprint = newFingerprint;
  return { kind: "continue", snap };
}
