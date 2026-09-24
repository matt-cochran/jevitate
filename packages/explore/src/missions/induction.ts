import type { Page } from "playwright";
import type { Actor } from "@jevitate/screenplay";
import { Navigate } from "@jevitate/screenplay";
import type { InvariantSpec, PageSegment, RecordedStep, Recording, Step, TargetDescriptor } from "@jevitate/recording";
import { redactUrl, type Answer, type GenerationPort, type JudgmentPort } from "@jevitate/ai-core";
import {
  InvariantDefectLog,
  InvariantMonitor,
  recordingStepCount,
  type InvariantDefect,
  type InvariantReport,
} from "../declared-invariants.js";
import {
  assertAuthorizedExploreTarget,
  perceive,
  targetCandidates,
  TranscriptLog,
  act,
  toPath,
  resolveBounds,
  buildJudgmentState,
  PROMPT_INJECTION_GUARD,
  type Bounds,
  type Control,
  type Snapshot,
  type TargetOp,
  type TranscriptEntry,
  type TranscriptListener,
} from "../index.js";
import type { MissionFailure } from "@jevitate/domain";
import type { SettleConfig, TimingConfig } from "../settle-config.js";
import type { HangSignal } from "../hang.js";
import { recordCoverageHang, type HangFinding } from "../hang-repro.js";
import { MissionSessions } from "../mission-session.js";
import type { VerifySession } from "../verify-fix.js";
import { CrashWatch, describeFailure, describeUnreachable, isUnreachableTarget } from "../mission-failure.js";
import { monitorFor } from "../page-monitor.js";
import { summarizeTimings, type PageTiming, type TimingSummary } from "../timing.js";
import { actionKey, controlIdentity, stateFingerprint, type FrontierOp } from "../coverage/fingerprint.js";
import { Frontier } from "../coverage/frontier.js";
import { chromeClassifier } from "../coverage/chrome.js";
import { reachFrontierState } from "../coverage/reach.js";
import { ChromeTracker } from "../feature/relevance.js";
import { StallWatchdog, StalledError } from "../stall-watchdog.js";
import { isNavControl } from "../coverage/nav.js";
import {
  assessCoverageSufficiency,
  resolveCoverageSufficiencyThresholds,
  type CoverageSufficiency,
  type CoverageSufficiencyThresholds,
} from "../coverage/sufficiency.js";
import { seedRedirectReason } from "../seed-redirect.js";
import { scopeGlobs, scopePredicate } from "../adversarial/scope.js";
import { MissionSafety } from "../mission-safety.js";
import type { SafetyConfig } from "../safety.js";
import type { SideEffect } from "../side-effects.js";

/** A failed act whose reason names a timeout, or a target this gate refused as not actionable
 *  (a visually-hidden skip link, an occluded target) — never re-chosen for the rest of the run. */
function isUnactionableFailure(reason: string | undefined): boolean {
  if (reason === undefined) return false;
  return /timeout|not actionable|no longer present/i.test(reason);
}

/**
 * Proof-by-induction (state-coverage) mission — spec §3.3.
 *
 * A bounded, terminating expansion of a state-fingerprint FRONTIER that
 * maximizes new-state / transition coverage (objective: coverage, not
 * shortest-path-to-goal). It reuses `@jevitate/explore`'s primitives
 * (`snapshot`/`act`/`assertAuthorizedExploreTarget`) but composes a DIFFERENT
 * loop than the goal-based driver: it maintains an explicit queue of
 * not-yet-tried `(state, action)` pairs keyed by a state fingerprint, pops the
 * next unexplored pair, and — when that pair belongs to a state other than the
 * one the browser is on — resets to the seed and replays the recorded prefix
 * (`reachFrontierState`) to get back there deterministically.
 *
 * "Same state?" is decided by fingerprint EQUALITY (a hard oracle), never a Jev
 * judgment. Jev's only role here is an advisory `Noul` "is this a defect?" per
 * state — it is recorded but NEVER gates termination, state identity, or
 * frontier expansion (guardrail #4).
 */

export interface DefectRecord {
  readonly stateFingerprint: string;
  readonly url: string;
  readonly reason: string;
  /** A replayable repro path from the seed to the flagged state. */
  readonly recording: Recording;
}

/** One transition whose result landed outside the mission's target scope (#89) — recorded, never
 *  expanded: its controls are never enqueued, so the frontier never wanders past it. */
export interface CoverageScopeDeparture {
  /** The state the departing action was performed FROM. */
  readonly fromFingerprint: string;
  /** The (redacted) URL it landed on. */
  readonly url: string;
  /** What was acted on (control name or op). */
  readonly action: string;
}

/** Where the frontier was allowed to expand, and how often a transition left it (#89, reusing #64's
 *  scope model). Out-of-scope states never count toward `statesVisited`/coverage. */
export interface CoverageScope {
  readonly routeGlobs: string[];
  readonly outOfScopeTransitions: number;
  /** The first departures (up to 50), in order. */
  readonly departures: CoverageScopeDeparture[];
}

export interface CoverageReport {
  readonly statesVisited: number;
  readonly transitionsExercised: number;
  readonly frontierExhausted: boolean;
  readonly defects: DefectRecord[];
  /** Actions the frontier attempted that did not land (gate refusal, action failure) — #75. */
  readonly failedActions: number;
  /** What the run exercised vs. its thresholds, and whether silence here may read as `clean` (#75,
   *  mirroring the adversarial coverage thresholds from #69). */
  readonly sufficiency: CoverageSufficiency;
  /** The mission's target scope and every departure from it (#89). */
  readonly scope: CoverageScope;
}

export interface InductionRunResult {
  /** `crashed`: the engine failed; everything discovered up to the failure is still returned. */
  /** `hang`: stopped at a hang it could not reset from (an unresponsive page, no fresh session). */
  /** `scope-unreachable`: the seed redirected elsewhere (e.g. a lost `--storage-state` session
   *  bounced to a login page) — the run never got to test what it was asked to (#82) — or, mid-run,
   *  the frontier could not return to the seed after a departure (#114). */
  /** `stalled`: no step completed within the stall watchdog's bound (#114). */
  readonly outcome: "exhausted" | "cap" | "crashed" | "hang" | "scope-unreachable" | "stalled";
  /** Hangs met while exploring (deduped by fingerprint), each with its fresh-context reproduction. */
  readonly hangs: HangFinding[];
  /** Why the run crashed/could not reach its target/stalled — present for `crashed`, `scope-unreachable` and `stalled`. */
  readonly failure?: MissionFailure;
  readonly coverage: CoverageReport;
  /** One replayable repro Recording per distinct state visited (discovery order). */
  readonly recordings: Recording[];
  /** The shared decision transcript: each frontier action, whether it landed, and Jev's advisory `isDefect`. */
  readonly transcript: TranscriptEntry[];
  /** Per-run timing summary: slowest pages/transitions and endpoints (p50/max), keyed by route. */
  readonly timing: TimingSummary;
  /** Declared-invariant violations (#86), each with the path Recording that reproduces it. */
  readonly invariantDefects?: InvariantDefect[];
  /** Per declared invariant: how often it applied, held, was violated, or could not be read. */
  readonly invariants?: InvariantReport[];
  /** The writes the frontier's actions fired (#116), marked when the control was paid / destructive. */
  readonly sideEffects?: SideEffect[];
  readonly sideEffectsTruncated?: number;
}

/** Declared invariants (#86) for a frontier mission: the monitor and the defects it found. */
interface Declared {
  readonly monitor: InvariantMonitor;
  readonly log: InvariantDefectLog;
}

export interface InductionMissionParams {
  readonly page: Page;
  readonly actor: Actor;
  readonly judgment: JudgmentPort;
  /** Accepted for symmetry with the goal-based mission / CLI wiring; the
   *  coverage loop drives ops directly and authors no synthetic fill text. */
  readonly generation?: GenerationPort;
  readonly seedUrl: string;
  readonly allowlist: readonly string[];
  readonly bounds?: Partial<Bounds>;
  readonly maxDepth?: number;
  /** Bound (ms) on waiting for a rendered page on each perception. Default `RENDER_WAIT_MS` — the shared settle rule
   *  recognises a control-free leaf state in about the quiet window, so no shorter coverage bound is needed. */
  readonly renderWaitMs?: number;
  /** Incremental-flush seam: every transcript entry, as it is recorded. */
  readonly onTranscriptEntry?: TranscriptListener;
  /** The target's settle configuration (background requests, long-poll threshold). */
  readonly settle?: SettleConfig;
  /**
   * Opens a FRESH browser session: reproduces a hang and resets to it after one, so the frontier
   * keeps being explored. Without it the same page is reused (and an unresponsive page ends the run).
   */
  readonly openFreshSession?: () => Promise<VerifySession>;
  /** Fresh-context replays that confirm a hang. Default 2. */
  readonly hangReplays?: number;
  /** The target's timing configuration (API path prefixes). */
  readonly timingConfig?: TimingConfig;
  /** How much of the target a run must exercise before "found nothing" may be reported `clean`
   *  (#75). Default `DEFAULT_COVERAGE_SUFFICIENCY_THRESHOLDS`. */
  readonly sufficiencyThresholds?: Partial<CoverageSufficiencyThresholds>;
  /**
   * Extra in-scope route globs (CLI `--route`, #64/#89 — the same glob syntax the adversarial and
   * feature missions use). The scope is always the seed URL's route and everything under it; these
   * add to it. Pass `["/**"]` (CLI `--scope app`) to widen containment to the whole app.
   */
  readonly routeGlobs?: readonly string[];
  /** App-declared invariants (#86): evaluated around every frontier action; a violation is a hard defect. */
  readonly invariants?: InvariantSpec;
  /** Registered secrets: redacted out of invariant values and evidence. */
  readonly secrets?: readonly string[];
  /**
   * `coverage` (default): the exhaustive breadth sweep. `exploratory`: novelty-seeking — the control
   * that appeared most recently is tried first, following what each action revealed (#115).
   */
  readonly strategy?: "coverage" | "exploratory";
  /** No-progress watchdog (#114): the run ends `stalled` when no step completes within this bound. Default 120s. */
  readonly stallTimeoutMs?: number;
  /** Bound (ms) on one reset-and-replay back to a queued state. Default `DEFAULT_REACH_TIMEOUT_MS`. */
  readonly reachTimeoutMs?: number;
  /** The shared safety policy (#116): session-ending / destructive / paid / --deny'd controls are never clicked. */
  readonly safety?: SafetyConfig;
}

/**
 * Which ops the frontier enqueues for a control. RULING (deviation from the
 * plan's literal `type`/`select` inclusion): the coverage fingerprint is a
 * function of url-template + control role/name/enabled — a control's VALUE is
 * deliberately excluded. `type`/`select` only mutate a value, so they can never
 * expand the state frontier; enqueuing them would only burn the action budget
 * against guardrail #2 (bounded). Clicks (navigations / control toggles) are
 * the only fingerprint-affecting transitions, so the frontier enqueues the
 * controls whose SHARED afforded op (`affordedOp`, ./actions.ts) is `click`.
 */
const FRONTIER_OPS: ReadonlySet<TargetOp> = new Set<TargetOp>(["click"]);

function enqueueFrom(
  frontier: Frontier,
  fingerprint: string,
  pathPrefix: Recording,
  controls: readonly Control[],
): void {
  // A disabled control can never be acted on — never enqueue it.
  for (const { control } of targetCandidates(controls, { ops: FRONTIER_OPS, enabledOnly: true })) {
    frontier.push({ key: actionKey(fingerprint, control, "click"), fromFingerprint: fingerprint, pathPrefix, control, op: "click" });
  }
}

/**
 * Re-resolves a frontier item's control in the CURRENT snapshot by its stable
 * identity (role + name + enabled) — the `index` is snapshot-local and useless
 * across re-snapshots. A control that has vanished returns null and the item is
 * dropped, never guessed at (fail-closed).
 */
function resolveControl(snap: Snapshot, want: Control): Control | null {
  return (
    snap.controls.find((c) => c.role === want.role && c.name === want.name && c.enabled === want.enabled) ?? null
  );
}

/**
 * Immutable "append one executed step to a replayable path", mirroring
 * `RunRecorder`'s discipline: a step whose action changed the URL gets a
 * `urlIncludes` postcondition (and opens the next page segment); one that did
 * not keeps a `visible` postcondition on its target. Returns a NEW Recording.
 */
function extendPath(
  prefix: Recording,
  op: FrontierOp,
  descriptor: TargetDescriptor,
  value: string | null,
  afterUrl: string,
): Recording {
  const pages: PageSegment[] = prefix.pages.map((p) => ({ ...p, steps: [...p.steps] }));
  let current = pages[pages.length - 1];
  if (current === undefined) {
    current = { url: "/", steps: [] };
    pages.push(current);
  }
  const target: TargetDescriptor = { ...descriptor };
  let step: Step;
  if (op === "click") {
    step = { kind: "click", target, expect: { kind: "visible", target } };
  } else if (op === "type") {
    step = { kind: "fill", target, value: { redacted: false, value: value ?? "" }, expect: { kind: "visible", target } };
  } else {
    step = { kind: "select", target, value: { redacted: false, value: value ?? "" }, expect: { kind: "visible", target } };
  }
  const recorded: RecordedStep = { step };
  current.steps.push(recorded);

  const path = toPath(afterUrl);
  if (path !== current.url) {
    step.expect = { kind: "urlIncludes", text: path };
    pages.push({ url: path, steps: [] });
  }
  return { version: prefix.version, site: prefix.site, pages };
}

/** A frontier path as a replayable Recording: the seed navigate, then the path's non-empty pages. */
function withSeed(branch: Recording, seedUrl: string): Recording {
  const seed = seedPath(seedUrl);
  return {
    ...branch,
    pages: [
      { url: seed, steps: [{ step: { kind: "navigate", url: seed, expect: { kind: "urlIncludes", text: seed } } }] },
      ...branch.pages.filter((p) => p.steps.length > 0),
    ],
  };
}

/** The seed's path WITH its query (`/workspace?inquiry=…`) — `toPath` drops the query, and a seed that
 *  needs it replays to a different page (#114). Sensitive query values stay masked. */
export function seedPath(seedUrl: string): string {
  try {
    const u = new URL(seedUrl);
    return redactUrl(`${u.pathname || "/"}${u.search}`);
  } catch {
    return toPath(seedUrl);
  }
}

export async function runInductionMission(params: InductionMissionParams): Promise<InductionRunResult> {
  // Guardrail #1 — authoring/test plane only: refuse an undeclared origin before
  // any page interaction (throws UnauthorizedExploreTargetError).
  assertAuthorizedExploreTarget(params.seedUrl, params.allowlist);
  const declared: Declared | null =
    params.invariants === undefined
      ? null
      : {
          monitor: new InvariantMonitor(params.invariants, {
            allowlist: params.allowlist,
            baseUrl: params.seedUrl,
            ...(params.secrets === undefined ? {} : { secrets: params.secrets }),
          }),
          log: new InvariantDefectLog(),
        };
  const safety = new MissionSafety(params.safety);
  const result = { ...(await runInductionFrontier(params, declared, safety)), ...safety.result() };
  return declared === null ? result : { ...result, invariantDefects: declared.log.defects(), invariants: declared.monitor.report() };
}

async function runInductionFrontier(
  params: InductionMissionParams,
  declared: Declared | null,
  safety: MissionSafety,
): Promise<InductionRunResult> {
  const bounds = resolveBounds(params.bounds);
  const maxDepth = params.maxDepth ?? 10;
  const site = new URL(params.seedUrl).origin;
  // Shared perception (render wait + occlusion): a state is never fingerprinted from a blank,
  // still-rendering frame — including right after a reset-and-replay.
  const sessions = new MissionSessions({ page: params.page, actor: params.actor }, params.openFreshSession);
  const hangs = new Map<string, HangFinding>();
  /** The hang the latest perception saw (a holder: it is set inside the perception closure). */
  const seenHang: { last: HangSignal | null } = { last: null };
  let lastTiming: PageTiming | undefined;
  /** Every perception's full timing (with request samples), once each — the run summary's input. */
  const timings: PageTiming[] = [];
  const takeSnapshot = async (): Promise<Snapshot> => {
    const p = await perceive(sessions.page, {
      maxCandidates: bounds.maxCandidates,
      ...(params.renderWaitMs === undefined ? {} : { renderWaitMs: params.renderWaitMs }),
      ...(params.settle === undefined ? {} : { settleConfig: params.settle }),
      ...(params.timingConfig === undefined ? {} : { timingConfig: params.timingConfig }),
    });
    lastTiming = p.timing;
    seenHang.last = p.hang;
    timings.push(p.timing);
    return p.snapshot;
  };
  // No-progress watchdog (#114): every recorded step kicks it; every await on the page is guarded by
  // it, so a wait that never ends stops the run (`stalled`) instead of idling until it is killed.
  const watchdog = new StallWatchdog(params.stallTimeoutMs);
  const guard = <T>(work: Promise<T>): Promise<T> => watchdog.guard(work);
  const transcript = new TranscriptLog([], (entry, all) => {
    watchdog.kick("choosing the next frontier action");
    params.onTranscriptEntry?.(entry, all);
  });
  const strategyLabel = params.strategy === "exploratory" ? "exploratory-frontier" : "coverage-frontier";
  let crashWatch = new CrashWatch(sessions.page);
  declared?.monitor.attach(sessions.page);
  sessions.onReset((page) => {
    crashWatch = new CrashWatch(page);
    declared?.monitor.attach(page);
  });
  const visited = new Set<string>();
  const statePaths = new Map<string, Recording>();
  const defects: DefectRecord[] = [];
  let transitionsExercised = 0;
  let actions = 0;
  let failedActions = 0;
  let nonNavActionsExercised = 0;
  const sufficiencyThresholds = resolveCoverageSufficiencyThresholds(params.sufficiencyThresholds);

  // Scope containment (#89, reusing #64's implementation): the frontier is scoped to the seed's
  // own route (and everything under it) plus the caller's `--route` globs. A transition landing
  // outside it is recorded as a departure but never expanded — never enqueued, never counted as
  // coverage — so the run stays prioritized on its target instead of wandering the whole app.
  const routeGlobs = scopeGlobs(params.seedUrl, params.routeGlobs);
  const inScope = scopePredicate(params.allowlist, routeGlobs);
  // Global chrome (#115): controls repeated unchanged across pathnames, besides nav/header/footer
  // landmarks and links out of scope, are tried only once the target's own controls are exhausted.
  const chrome = new ChromeTracker();
  const observe = (s: Snapshot): void => chrome.observe(pathOf(s.url), s.controls);
  const departures: CoverageScopeDeparture[] = [];
  const MAX_LISTED_DEPARTURES = 50;
  let outOfScopeTransitions = 0;

  const report = (frontierExhausted: boolean): CoverageReport => ({
    statesVisited: visited.size,
    transitionsExercised,
    frontierExhausted,
    defects,
    failedActions,
    sufficiency: assessCoverageSufficiency({ actions, failedActions, nonNavActionsExercised }, sufficiencyThresholds),
    scope: { routeGlobs, outOfScopeTransitions, departures: departures.slice(0, MAX_LISTED_DEPARTURES) },
  });

  const ended = (outcome: "scope-unreachable" | "stalled", failure: MissionFailure): InductionRunResult => ({
    outcome,
    failure,
    coverage: report(false),
    recordings: [...statePaths.values()],
    transcript: transcript.entries(),
    timing: summarizeTimings(timings),
    hangs: [...hangs.values()],
  });

  try {
    watchdog.during("loading the seed");
    await guard(monitorFor(sessions.page).instrument());
    safety.attach(monitorFor(sessions.page));
    // #128: real network evidence for the FIRST navigation — a refused connection can still
    // surface as a bare navigation timeout.
    let firstNavNetError: string | null = null;
    const onFirstNavRequestFailed = (req: { failure(): { errorText: string } | null }): void => {
      const text = req.failure()?.errorText;
      if (text !== undefined) firstNavNetError = text;
    };
    sessions.page.on("requestfailed", onFirstNavRequestFailed);
    try {
      await guard(sessions.actor.attemptsTo(Navigate.to(params.seedUrl)));
    } catch (e) {
      const message = e instanceof Error ? (e.message.split("\n")[0] ?? e.message) : String(e);
      if (!isUnreachableTarget(message) && !isUnreachableTarget(firstNavNetError ?? "")) throw e;
      // The seed itself could not be loaded: never a defect in the app, never a bug in jevitate —
      // a configuration problem. `inconclusive`, never `crashed`; no crash report/issue drafted.
      return ended("scope-unreachable", {
        kind: "target-unreachable",
        message: `target unreachable (${describeUnreachable(message, firstNavNetError)})`,
      });
    } finally {
      sessions.page.off("requestfailed", onFirstNavRequestFailed);
    }
    let snap = await guard(takeSnapshot());

    // The seed redirected elsewhere (a lost `--storage-state` session bounced to a login page, most
    // often) — the run cannot test what it was asked to, so it is never `clean` (#82).
    const redirect = seedRedirectReason(params.seedUrl, snap.url);
    if (redirect !== null) {
      transcript.record({
        op: null,
        control: null,
        confidence: null,
        chosenBy: "strategy",
        strategy: "seed-load",
        actOk: false,
        reason: `${redirect.reason} (inconclusive)`,
        snapshot: snap,
      });
      return {
        outcome: "scope-unreachable",
        coverage: report(false),
        recordings: [],
        transcript: transcript.entries(),
        timing: summarizeTimings(timings),
        hangs: [...hangs.values()],
        failure: { kind: "target-unreachable", message: redirect.reason },
      };
    }

    let currentFingerprint = stateFingerprint(snap);
    visited.add(currentFingerprint);
    observe(snap);
    const frontier = new Frontier({
      order: params.strategy === "exploratory" ? "novelty" : "breadth",
      classify: chromeClassifier({ chrome, inScope }),
    });
    /** The last transition left the target scope — the next reset is a return after a departure. */
    let departed = false;

    const seedRecording: Recording = { version: "1", site, pages: [] };
    statePaths.set(currentFingerprint, seedRecording);
    enqueueFrom(frontier, currentFingerprint, seedRecording, snap.controls);

    while (!frontier.isExhausted()) {
      // Hard cap (guardrail #2): checked BEFORE spending — never guess one more step.
      if (actions >= bounds.maxActions) {
        return {
          outcome: "cap",
          coverage: report(false),
          recordings: [...statePaths.values()],
          transcript: transcript.entries(),
          timing: summarizeTimings(timings),
          hangs: [...hangs.values()],
        };
      }

      const item = frontier.popPreferring(currentFingerprint);
      if (item === undefined) break;

      const depth = item.pathPrefix.pages.reduce((n, p) => n + p.steps.length, 0);
      if (depth >= maxDepth) continue; // bounded exploration depth

      if (item.fromFingerprint !== currentFingerprint) {
        watchdog.during(departed ? "returning to the seed after a departure" : "resetting to a queued state");
        const reached = await guard(
          reachFrontierState({
            actor: sessions.actor,
            seedUrl: params.seedUrl,
            item,
            snapshotNow: takeSnapshot,
            homeUrl: params.seedUrl,
            currentUrl: () => sessions.page.url(),
            ...(params.reachTimeoutMs === undefined ? {} : { timeoutMs: params.reachTimeoutMs }),
          }),
        );
        if (!reached.ok) {
          if (reached.reason === "stale") {
            // Stale — dropped, never guessed at; so is every other item replaying the same path (#114).
            frontier.dropState(item.fromFingerprint);
            currentFingerprint = "";
            continue;
          }
          // The seed is gone (a lost session) or stopped answering: no queued item is reachable —
          // a typed stop, never an idle grind through every queued item's reset (#114).
          return ended("scope-unreachable", {
            kind: "target-unreachable",
            message: `could not return to the seed${departed ? " after a departure" : ""} (${reached.detail ?? reached.reason})`,
          });
        }
        snap = reached.snapshot;
        observe(snap);
        currentFingerprint = item.fromFingerprint;
        departed = false;
      }

      const liveControl = resolveControl(snap, item.control);
      if (liveControl === null) continue; // control vanished between snapshots — dropped

      // The shared safety policy (#116): never clicked, never retried (blacklisted), recorded once.
      const unsafe = safety.gate(item.op, liveControl);
      if (unsafe !== null) {
        frontier.blacklist(controlIdentity(liveControl));
        if (unsafe.first) {
          transcript.record({
            op: null,
            control: liveControl,
            confidence: null,
            chosenBy: "strategy",
            strategy: "safety-policy",
            origin: "engine",
            actOk: false,
            reason: unsafe.reason,
            snapshot: snap,
          });
        }
        continue;
      }
      const actedOn = snap.url;
      watchdog.during(`acting on "${liveControl.name || item.op}"`);
      if (declared !== null) await guard(declared.monitor.before(sessions.actor));
      safety.mark(transcript.nextStep, item.op, liveControl);
      const result = await guard(
        act(sessions.actor, {
          op: item.op,
          control: liveControl,
          value: item.op === "click" ? null : "",
        }),
      );
      actions += 1;
      frontier.recordAttempt();
      const decidedOn = snap;
    // Each perception's timing is reported once (a failed act re-uses the same snapshot).
    const decidedOnTiming = lastTiming;
    lastTiming = undefined;
      if (!result.ok) {
        failedActions += 1;
        // A control that failed with a timeout (or was refused as not actionable — a clipped/
        // offscreen skip link, an occluded target) is never re-chosen for the rest of the run
        // (#75): every OTHER state that re-offers the same control identity drops it at `push`.
        if (isUnactionableFailure(result.reason)) frontier.blacklist(controlIdentity(liveControl));
        transcript.record({
          op: item.op,
          control: liveControl,
          confidence: null,
          chosenBy: "strategy",
          strategy: strategyLabel,
          actOk: false,
          ...(result.reason === undefined ? {} : { reason: result.reason }),
          snapshot: decidedOn,
        ...(decidedOnTiming === undefined ? {} : { timing: decidedOnTiming }),
        });
        continue;
      }

      frontier.markExercised(controlIdentity(liveControl));
      if (!isNavControl(liveControl, decidedOn.url)) nonNavActionsExercised += 1;

      snap = await guard(takeSnapshot());
      observe(snap);
      const newFingerprint = stateFingerprint(snap);
      const branch = extendPath(item.pathPrefix, item.op, liveControl.descriptor, null, snap.url);
      transitionsExercised += 1;
      if (declared !== null && seenHang.last === null) {
        // Declared invariants (#86): judged on the settled state the action produced; the finding
        // replays this path from the seed (the frontier's reach navigates there first).
        const path = withSeed(branch, params.seedUrl);
        const checked = await guard(declared.monitor.after(sessions.actor, { op: item.op, control: liveControl.name, url: actedOn }));
        for (const v of checked.violations) {
          declared.log.add(v, { recordingStepIndex: recordingStepCount(path) - 1, recording: path });
        }
      }

      // A hang: record it (reproduced from the path that led here), reset to a known state and keep
      // exploring the rest of the frontier. The hung state is never expanded.
      const hang = seenHang.last;
      if (hang !== null) {
        transcript.record({
          op: item.op,
          control: liveControl,
          confidence: null,
          chosenBy: "strategy",
          strategy: strategyLabel,
          actOk: true,
          reason: `hang (${hang.kind}): ${hang.detail}`,
          snapshot: decidedOn,
          ...(decidedOnTiming === undefined ? {} : { timing: decidedOnTiming }),
        });
        watchdog.suspend(); // the reproduction is bounded on its own (fresh contexts, bounded replays)
        await recordCoverageHang({
          hang,
          // The path starts at the seed (the frontier's reach navigates there first): prepend it.
          recording: withSeed(branch, params.seedUrl),
          steps: transcript.entries(),
          found: hangs,
          ...(params.openFreshSession === undefined ? {} : { openSession: params.openFreshSession }),
          ...(params.hangReplays === undefined ? {} : { attempts: params.hangReplays }),
          // Re-detected with the SAME perception bounds the mission used.
          perceive: {
            ...(params.renderWaitMs === undefined ? {} : { renderWaitMs: params.renderWaitMs }),
            ...(params.settle === undefined ? {} : { settleConfig: params.settle }),
          },
        });
        watchdog.kick("resetting after a hang");
        if (!(await guard(sessions.reset(hang)))) {
          return {
            outcome: "hang",
            coverage: report(false),
            recordings: [...statePaths.values()],
            transcript: transcript.entries(),
            timing: summarizeTimings(timings),
            hangs: [...hangs.values()],
          };
        }
        await guard(monitorFor(sessions.page).instrument());
        safety.attach(monitorFor(sessions.page));
        currentFingerprint = ""; // the next item is reached afresh from the seed
        continue;
      }

      // Scope containment (#89, reusing #64's scope model): a transition that landed outside the
      // target is recorded (a departure) but never expanded — its controls are never enqueued, and
      // it is never judged, so the frontier stays prioritized on the in-scope target instead of
      // wandering into the rest of the app. The next frontier pop (necessarily sourced from an
      // in-scope state, since only those are ever enqueued) resets and replays back into scope.
      if (!inScope(snap.url)) {
        outOfScopeTransitions += 1;
        const landed = redactUrl(snap.url);
        departures.push({ fromFingerprint: currentFingerprint, url: landed, action: liveControl.name || item.op });
        transcript.record({
          op: item.op,
          control: liveControl,
          confidence: null,
          chosenBy: "strategy",
          strategy: strategyLabel,
          actOk: true,
          reason: `left the target scope (landed on ${landed}); not expanded`,
          snapshot: decidedOn,
          ...(decidedOnTiming === undefined ? {} : { timing: decidedOnTiming }),
        });
        currentFingerprint = newFingerprint;
        departed = true;
        continue;
      }

      // Advisory-only Jev defect judgment (guardrail #4). State is redacted first
      // (guardrail #3, via buildJudgmentState) and carries the prompt-injection
      // guard (guardrail #5). The verdict NEVER gates termination or expansion — so an
      // unavailable judgment is a missing advisory, recorded, and the run goes on.
      let isDefect: Answer | undefined;
      let judgmentNote: string | undefined;
      try {
        const answers = await guard(params.judgment.systemOne({
          state: buildJudgmentState({
            goal: "state coverage",
            url: snap.url,
            controls: [PROMPT_INJECTION_GUARD, ...snap.controls.map((c) => c.summary)],
            history: [],
          }),
          questions: { isDefect: { kind: "noul" } },
        }));
        isDefect = answers.isDefect;
      } catch (e) {
        if (e instanceof StalledError) throw e;
        judgmentNote = `advisory judgment unavailable: ${e instanceof Error ? e.message.split("\n")[0] : String(e)}`;
      }
      const flagged = isDefect?.kind === "noul" && isDefect.value;
      transcript.record({
        op: item.op,
        control: liveControl,
        confidence: null,
        chosenBy: "strategy",
        strategy: strategyLabel,
        actOk: true,
        snapshot: decidedOn,
        ...(decidedOnTiming === undefined ? {} : { timing: decidedOnTiming }),
        ...(judgmentNote === undefined ? {} : { reason: judgmentNote }),
        ...(isDefect?.kind === "noul"
          ? { judgments: { isDefect: { value: isDefect.value, probability: isDefect.probability } } }
          : {}),
      });
      if (flagged) {
        defects.push({
          stateFingerprint: newFingerprint,
          url: snap.url,
          reason: "judgment flagged defect",
          recording: branch,
        });
        currentFingerprint = newFingerprint;
        continue; // recorded, but a flagged state is never expanded
      }

      if (!visited.has(newFingerprint)) {
        visited.add(newFingerprint);
        statePaths.set(newFingerprint, branch);
        enqueueFrom(frontier, newFingerprint, branch, snap.controls);
      }
      currentFingerprint = newFingerprint;
    }

    return {
      outcome: "exhausted",
      coverage: report(true),
      recordings: [...statePaths.values()],
      transcript: transcript.entries(),
      timing: summarizeTimings(timings),
      hangs: [...hangs.values()],
    };
  } catch (e) {
    // The watchdog fired (#114): a typed `stalled` stop with everything found so far, never an idle run.
    if (e instanceof StalledError) return ended("stalled", { kind: "stalled", message: e.reason });
    // Engine failure: a typed `crashed` result with every state path and transcript step so far.
    return {
      outcome: "crashed",
      failure: describeFailure(e, crashWatch.signals()),
      coverage: report(false),
      recordings: [...statePaths.values()],
      transcript: transcript.entries(),
      timing: summarizeTimings(timings),
      hangs: [...hangs.values()],
    };
  } finally {
    watchdog.stop();
    await sessions.closeOwned();
  }
}

function pathOf(url: string): string {
  try {
    return new URL(url).pathname;
  } catch {
    return url;
  }
}
