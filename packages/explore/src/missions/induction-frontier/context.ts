/**
 * The induction frontier's run state (#232): `FrontierContext` holds every closure variable
 * `runInductionFrontier` used to keep (names unchanged) plus its inputs, and `createFrontierContext`
 * builds it — the same initializers, in the same order, with the same listeners attached.
 */

import type { MissionFailure } from "@jevitate/domain";
import type { Recording } from "@jevitate/recording";
import { PageDeltas, type ActionDelta } from "../../action-delta.js";
import { scopeGlobs, scopePredicate } from "../../adversarial/scope.js";
import { BudgetMonitor } from "../../budget.js";
import { Frontier } from "../../coverage/frontier.js";
import {
  assessCoverageSufficiency,
  resolveCoverageSufficiencyThresholds,
  type CoverageSufficiencyThresholds,
} from "../../coverage/sufficiency.js";
import type { DeclaredRun } from "../../declared-invariants.js";
import type { DemoOverlay } from "../../demo-overlay.js";
import { ChromeTracker } from "../../feature/relevance.js";
import type { HangFinding } from "../../hang-repro.js";
import type { HangSignal } from "../../hang.js";
import { TranscriptLog, perceive, resolveBounds, type Bounds, type Control, type Snapshot } from "../../index.js";
import { CrashWatch } from "../../mission-failure.js";
import { MissionSafety } from "../../mission-safety.js";
import { MissionSessions } from "../../mission-session.js";
import { clippingSummary, detectClipping, detectOverflow, shouldCheckOverflow } from "../../overflow.js";
import { StallWatchdog } from "../../stall-watchdog.js";
import { summarizeTimings, type PageTiming } from "../../timing.js";
import type {
  CoverageReport,
  CoverageScopeDeparture,
  DefectRecord,
  InductionMissionParams,
  InductionRunResult,
} from "../induction.js";
import { pathOf } from "./helpers.js";

/** The induction frontier's run state (#232): every closure variable of `runInductionFrontier()`, one field each, names unchanged. */
export interface FrontierContext {
  readonly params: InductionMissionParams;
  readonly declared: DeclaredRun | null;
  readonly safety: MissionSafety;
  readonly budget: BudgetMonitor | null;
  readonly overlay: DemoOverlay | null;
  readonly deltaLog: Array<{ delta: ActionDelta; action: string }> | null;
  /** #303 (opt-in): the action-delta tracker, following the session's current page. */
  readonly pageDeltas: PageDeltas | null;
  readonly bounds: Bounds;
  readonly maxDepth: number;
  readonly site: string;
  readonly sessions: MissionSessions;
  readonly hangs: Map<string, HangFinding>;
  /** The hang the latest perception saw (a holder: it is set inside the perception closure). */
  readonly seenHang: { last: HangSignal | null };
  lastTiming: PageTiming | undefined;
  /** Every perception's full timing (with request samples), once each — the run summary's input. */
  readonly timings: PageTiming[];
  readonly takeSnapshot: () => Promise<Snapshot>;
  readonly watchdog: StallWatchdog;
  readonly guard: <T>(work: Promise<T>) => Promise<T>;
  readonly transcript: TranscriptLog;
  readonly strategyLabel: "exploratory-frontier" | "coverage-frontier";
  crashWatch: CrashWatch;
  readonly visited: Set<string>;
  readonly statePaths: Map<string, Recording>;
  readonly defects: DefectRecord[];
  readonly seenOverflow: Set<string>;
  readonly checkOverflow: (stateFp: string, url: string, recording: Recording) => Promise<void>;
  transitionsExercised: number;
  actions: number;
  /** #293: actions spent re-replaying the Journey prefix on resets (counted against `maxActions`). */
  restartSpend: number;
  failedActions: number;
  timedOutActions: number;
  /** #213: what explains a run that took no action — the seed's candidates, safety refusals, dropped chrome. */
  seedCandidates: number;
  readonly refusedControls: Map<string, string>;
  frontierRef: Frontier | undefined;
  nonNavActionsExercised: number;
  /** #209: exercised links to another page — global navigation only if chrome (see `report`). */
  readonly crossPageLinks: Control[];
  readonly sufficiencyThresholds: CoverageSufficiencyThresholds;
  readonly routeGlobs: string[];
  readonly inScope: (url: string) => boolean;
  readonly chrome: ChromeTracker;
  readonly observe: (s: Snapshot) => void;
  readonly departures: CoverageScopeDeparture[];
  readonly MAX_LISTED_DEPARTURES: 50;
  outOfScopeTransitions: number;
  readonly report: (frontierExhausted: boolean) => CoverageReport;
  readonly ended: (outcome: "scope-unreachable" | "stalled", failure: MissionFailure) => InductionRunResult;
  snap: Snapshot;
  currentFingerprint: string;
  readonly withheld: (control: Control, on: Snapshot) => boolean;
  readonly frontier: Frontier;
  /** The last transition left the target scope — the next reset is a return after a departure. */
  departed: boolean;
  readonly seedRecording: Recording;
}

/** The writable view of the run state, for the code that sets it up. */
export type FrontierState = { -readonly [K in keyof FrontierContext]: FrontierContext[K] };

/** Builds the run state of one frontier run (everything before its first navigation). */
export function createFrontierContext(
  params: InductionMissionParams,
  declared: DeclaredRun | null,
  safety: MissionSafety,
  budget: BudgetMonitor | null,
  overlay: DemoOverlay | null = null,
  deltaLog: Array<{ delta: ActionDelta; action: string }> | null = null,
): FrontierContext {
  const ctx = {} as FrontierState;
  ctx.params = params;
  ctx.declared = declared;
  ctx.safety = safety;
  ctx.budget = budget;
  ctx.overlay = overlay;
  ctx.deltaLog = deltaLog;
  /** #303 (opt-in): the action-delta tracker, following the session's current page. */
  ctx.pageDeltas = deltaLog === null ? null : new PageDeltas({ secrets: params.secrets ?? [], goal: "map every reachable state" });
  ctx.bounds = resolveBounds(params.bounds);
  ctx.maxDepth = params.maxDepth ?? 10;
  ctx.site = new URL(params.seedUrl).origin;
  // Shared perception (render wait + occlusion): a state is never fingerprinted from a blank,
  // still-rendering frame — including right after a reset-and-replay.
  ctx.sessions = new MissionSessions({ page: params.page, actor: params.actor }, params.openFreshSession);
  ctx.hangs = new Map<string, HangFinding>();
  /** The hang the latest perception saw (a holder: it is set inside the perception closure). */
  ctx.seenHang = { last: null };
  ctx.lastTiming = undefined;
  /** Every perception's full timing (with request samples), once each — the run summary's input. */
  ctx.timings = [];
  ctx.takeSnapshot = async (): Promise<Snapshot> => {
    const p = await perceive(ctx.sessions.page, {
      maxCandidates: ctx.bounds.maxCandidates,
      ...(params.secrets === undefined ? {} : { secrets: params.secrets }),
      ...(params.renderWaitMs === undefined ? {} : { renderWaitMs: params.renderWaitMs }),
      ...(params.settle === undefined ? {} : { settleConfig: params.settle }),
      ...(params.timingConfig === undefined ? {} : { timingConfig: params.timingConfig }),
    });
    ctx.lastTiming = p.timing;
    ctx.seenHang.last = p.hang;
    ctx.timings.push(p.timing);
    return p.snapshot;
  };
  // No-progress watchdog (#114): every recorded step kicks it; every await on the page is guarded by
  // it, so a wait that never ends stops the run (`stalled`) instead of idling until it is killed.
  ctx.watchdog = new StallWatchdog(params.stallTimeoutMs);
  ctx.guard = <T>(work: Promise<T>): Promise<T> => ctx.watchdog.guard(work);
  ctx.transcript = new TranscriptLog([], (entry, all) => {
    ctx.watchdog.kick("choosing the next frontier action");
    params.onTranscriptEntry?.(entry, all);
  });
  ctx.strategyLabel = params.strategy === "exploratory" ? "exploratory-frontier" : "coverage-frontier";
  ctx.crashWatch = new CrashWatch(ctx.sessions.page);
  declared?.monitor.attach(ctx.sessions.page);
  ctx.sessions.onReset((page) => {
    ctx.crashWatch = new CrashWatch(page);
    declared?.monitor.attach(page);
  });
  ctx.visited = new Set<string>();
  ctx.statePaths = new Map<string, Recording>();
  ctx.defects = [];
  // Horizontal-overflow (#149): one defect per distinct fingerprint (route + element) — a wide table
  // seen across many visited states is still ONE finding, never a defect per occurrence.
  ctx.seenOverflow = new Set<string>();
  ctx.checkOverflow = async (stateFp: string, url: string, recording: Recording): Promise<void> => {
    const vp = ctx.sessions.page.viewportSize();
    if (!shouldCheckOverflow(vp?.width, params.overflow?.checkOverflow ?? false)) return;
    const finding = await detectOverflow(ctx.sessions.page, {
      viewport: vp ?? { width: 1280, height: 720 },
      ...(params.overflow?.device === undefined ? {} : { device: params.overflow.device }),
      ...(params.overflow?.toleranceCss === undefined ? {} : { toleranceCss: params.overflow.toleranceCss }),
      ...(params.overflow?.ignoreSelectors === undefined ? {} : { ignoreSelectors: params.overflow.ignoreSelectors }),
      ...(params.overflow?.secrets === undefined ? {} : { secrets: params.overflow.secrets }),
    });
    if (finding !== null && !ctx.seenOverflow.has(finding.fingerprint)) {
      ctx.seenOverflow.add(finding.fingerprint);
      ctx.defects.push({
        fingerprint: finding.fingerprint,
        kind: "horizontal-overflow",
        stateFingerprint: stateFp,
        url,
        reason: `horizontal-overflow: ${finding.element.descriptor} overflows the ${finding.viewport.width}px viewport by ${finding.overflowPx}px at ${finding.route}`,
        recording,
        overflow: finding,
      });
    }
    // #302: text cut off vertically — one defect per element (route + element), like overflow.
    const clipped = await detectClipping(ctx.sessions.page, {
      viewport: vp ?? { width: 1280, height: 720 },
      ...(params.overflow?.device === undefined ? {} : { device: params.overflow.device }),
      ...(params.overflow?.ignoreSelectors === undefined ? {} : { ignoreSelectors: params.overflow.ignoreSelectors }),
      ...(params.overflow?.secrets === undefined ? {} : { secrets: params.overflow.secrets }),
    });
    for (const c of clipped) {
      if (ctx.seenOverflow.has(c.fingerprint)) continue;
      ctx.seenOverflow.add(c.fingerprint);
      ctx.defects.push({ fingerprint: c.fingerprint, kind: "vertical-clipping", stateFingerprint: stateFp, url, reason: clippingSummary(c), recording, clipping: c });
    }
  };
  ctx.transitionsExercised = 0;
  ctx.actions = 0;
  /** #293: actions spent re-replaying the Journey prefix on resets (counted against `maxActions`). */
  ctx.restartSpend = 0;
  ctx.failedActions = 0;
  ctx.timedOutActions = 0;
  /** #213: what explains a run that took no action — the seed's candidates, safety refusals, dropped chrome. */
  ctx.seedCandidates = 0;
  ctx.refusedControls = new Map<string, string>();
  ctx.frontierRef = undefined;
  ctx.nonNavActionsExercised = 0;
  /** #209: exercised links to another page — global navigation only if chrome (see `report`). */
  ctx.crossPageLinks = [];
  ctx.sufficiencyThresholds = resolveCoverageSufficiencyThresholds(params.sufficiencyThresholds);

  // Scope containment (#89, reusing #64's implementation): the frontier is scoped to the seed's
  // own route (and everything under it) plus the caller's `--route` globs. A transition landing
  // outside it is recorded as a departure but never expanded — never enqueued, never counted as
  // coverage — so the run stays prioritized on its target instead of wandering the whole app.
  ctx.routeGlobs = scopeGlobs(params.seedUrl, params.routeGlobs);
  ctx.inScope = scopePredicate(params.allowlist, ctx.routeGlobs);
  // Global chrome (#115): controls repeated unchanged across pathnames, besides nav/header/footer
  // landmarks and links out of scope, are tried only once the target's own controls are exhausted.
  ctx.chrome = new ChromeTracker();
  ctx.observe = (s: Snapshot): void => ctx.chrome.observe(pathOf(s.url), s.controls);
  ctx.departures = [];
  ctx.MAX_LISTED_DEPARTURES = 50;
  ctx.outOfScopeTransitions = 0;

  ctx.report = (frontierExhausted: boolean): CoverageReport => ({
    statesVisited: ctx.visited.size,
    transitionsExercised: ctx.transitionsExercised,
    frontierExhausted,
    defects: ctx.defects,
    failedActions: ctx.failedActions,
    timedOutActions: ctx.timedOutActions,
    sufficiency: assessCoverageSufficiency(
      {
        actions: ctx.actions,
        failedActions: ctx.failedActions,
        // #209: a link to another page counts as global navigation only when it is page CHROME — in a
        // `<nav>`/`<header>`/`<footer>` landmark, or repeated on 2+ pages (judged over the whole run,
        // so a header link met before its second page still counts as chrome). A link in the page's
        // own body (a small app whose pages link to each other in their content) is in-page coverage.
        nonNavActionsExercised: ctx.nonNavActionsExercised + ctx.crossPageLinks.filter((c) => (c.landmark ?? null) === null && !ctx.chrome.isChrome(c)).length,
        timedOutActions: ctx.timedOutActions,
        noAction: {
          seedCandidates: ctx.seedCandidates,
          refused: [...ctx.refusedControls].map(([name, risk]) => ({ name, risk })),
          outOfScopeChrome: ctx.frontierRef?.droppedLeavingChrome ?? 0,
        },
      },
      ctx.sufficiencyThresholds,
    ),
    scope: { routeGlobs: ctx.routeGlobs, outOfScopeTransitions: ctx.outOfScopeTransitions, departures: ctx.departures.slice(0, ctx.MAX_LISTED_DEPARTURES) },
  });

  ctx.ended = (outcome: "scope-unreachable" | "stalled", failure: MissionFailure): InductionRunResult => ({
    outcome,
    failure,
    coverage: ctx.report(false),
    recordings: [...ctx.statePaths.values()],
    transcript: ctx.transcript.entries(),
    timing: summarizeTimings(ctx.timings),
    hangs: [...ctx.hangs.values()],
  });
  return ctx;
}
