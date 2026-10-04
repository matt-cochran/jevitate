/**
 * runInductionMission — the public surface (types, seedPath) and the frontier's driver. Module map
 * (#232): the frontier's state and phases live in ./induction-frontier/ as functions of a
 * FrontierContext:
 *
 *   context.ts         FrontierContext (every former closure variable + the run's inputs) + createFrontierContext
 *   seed.ts            loadSeed: first navigation, seed state, budget baseline, the seed's enqueue
 *   reach.ts           reachItem: reset and replay to a queued item's state
 *   act.ts             actOnItem: re-resolve, safety gate, act (one timeout retry), a failed act
 *   settle.ts          settleTransition: new state, delta, transition, invariants, post-settle budget
 *   hang-departure.ts  handleHangOrDeparture: an in-scope hang (reset) or a departure (never expanded)
 *   judge.ts           judgeState: overflow, advisory defect judgment, enqueue
 *   transition.ts      Acted / Settled: a transition's former per-iteration locals
 *   helpers.ts         pure helpers (failure classes, enqueue rule, replayable paths)
 */
import { deltaStatsOf, type ActionDelta, type ActionDeltaStats } from "../action-delta.js";
import type { Page } from "playwright";
import type { Actor } from "@jevitate/screenplay";
import type { InvariantSpec, Recording } from "@jevitate/recording";
import { type GenerationPort, type JudgmentPort } from "@jevitate/ai-core";
import {
  InvariantDefectLog,
  finishDeclaredRun,
  type DeclaredRun,
  InvariantMonitor,
  type InvariantDefect,
  type InvariantReport,
} from "../declared-invariants.js";
import {
  assertAuthorizedExploreTarget,
  type Bounds,
  type TranscriptEntry,
  type TranscriptListener,
} from "../index.js";
import { type MissionFailure } from "@jevitate/domain";
import type { SettleConfig, TimingConfig } from "../settle-config.js";
import { type HangFinding } from "../hang-repro.js";
import type { HostHealthSampler } from "../host-health.js";
import type { VerifySession } from "../verify-fix.js";
import { describeFailure, isPageUnresponsive, isTargetUnresponsive } from "../mission-failure.js";
import { summarizeTimings, type TimingSummary } from "../timing.js";
import { StalledError } from "../stall-watchdog.js";
import { demoOverlayFor, type DemoOverlay } from "../demo-overlay.js";
import {
  type CoverageSufficiency,
  type CoverageSufficiencyThresholds,
} from "../coverage/sufficiency.js";
import { MissionSafety } from "../mission-safety.js";
import type { SafetyConfig } from "../safety.js";
import type { SideEffect } from "../side-effects.js";
import { BudgetMonitor, type BudgetTrajectory } from "../budget.js";
import { type ClippingFinding, type OverflowFinding } from "../overflow.js";
import {
  seedPath as seedPathOf,
} from "./induction-frontier/helpers.js";
import { createFrontierContext, type FrontierState } from "./induction-frontier/context.js";
import { loadSeed } from "./induction-frontier/seed.js";
import { judgeState } from "./induction-frontier/judge.js";
import { handleHangOrDeparture } from "./induction-frontier/hang-departure.js";
import { settleTransition } from "./induction-frontier/settle.js";
import { actOnItem } from "./induction-frontier/act.js";
import { reachItem } from "./induction-frontier/reach.js";

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
  /**
   * #209: the defect's own 16-hex fingerprint and kind, so it takes its place in the result's unified
   * `defects` list (#195) like every other strategy's: a horizontal overflow keeps the overflow
   * finding's fingerprint (`horizontal-overflow`); a state the advisory judgment flagged is
   * `judgment-flagged-state`, keyed by the state's fingerprint.
   */
  readonly fingerprint: string;
  readonly kind: "horizontal-overflow" | "vertical-clipping" | "judgment-flagged-state";
  readonly stateFingerprint: string;
  readonly url: string;
  readonly reason: string;
  /** A replayable repro path from the seed to the flagged state. */
  readonly recording: Recording;
  /** Present for a horizontal-overflow hard signal (#149): the structured finding `reason` summarizes. */
  readonly overflow?: OverflowFinding;
  /** Present for a vertical-clipping hard signal (#302): the element whose text is cut off. */
  readonly clipping?: ClippingFinding;
  /**
   * #214: `true` on a `judgment-flagged-state` — a model's opinion alone, never an independent oracle's
   * verdict (guardrail #4). Reported (with its repro Recording, so `verify-fix` can replay it) but it
   * never sets the mission outcome or exit code on its own. Absent on a hard-signal defect.
   */
  readonly advisory?: true;
  /**
   * #320: on a `judgment-flagged-state`, what the advisory judgment saw: its probability, the action
   * that led to the state, and the page's controls it was shown (redacted, bounded) — so a flag can
   * be triaged without replaying it. The judgment returns a yes/no with a probability, never a claim
   * of its own: this is its evidence, not an explanation it wrote.
   */
  readonly judgment?: {
    readonly probability: number;
    /** `<op> "<control name>"` — the action whose result was judged. */
    readonly after: string;
    /** The first controls of the judged state, as the judgment was shown them (redacted). */
    readonly shown: readonly string[];
  };
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
  /** Of those, the ones that failed on a TIMEOUT (#203) — a frontier drained by these is `insufficient-coverage`. */
  readonly timedOutActions: number;
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
  /** `insufficient-coverage` (#203; one name since #209 — was `insufficient-exploration`): the frontier emptied because its actions TIMED OUT (each one
   *  blacklisted its control), not because its states ran out — never reported as `exhausted`. */
  readonly outcome: "exhausted" | "insufficient-coverage" | "cap" | "crashed" | "hang" | "scope-unreachable" | "stalled" | "budget";
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
  /** Declared mission spend budgets (#150): the observed trajectory, present when any were declared. */
  readonly budget?: BudgetTrajectory[];
  /** #303 (`actionDeltas`): verdict counts, and the actions that changed nothing (`noEffect`, deduped). */
  readonly actionDeltas?: ActionDeltaStats & { readonly noEffect?: readonly string[] };
}

/** Declared invariants (#86) for a frontier mission: the monitor and the defects it found. */
type Declared = DeclaredRun;

export interface InductionMissionParams {
  readonly page: Page;
  readonly actor: Actor;
  readonly judgment: JudgmentPort;
  /** Accepted for symmetry with the goal-based mission / CLI wiring; the
   *  coverage loop drives ops directly and authors no synthetic fill text. */
  readonly generation?: GenerationPort;
  readonly seedUrl: string;
  /**
   * #293 journey-anchored exploration: the page is ALREADY at `seedUrl`'s state (a Journey prefix was
   * replayed into this session), so the first navigation is skipped and the frontier starts from the
   * live page. A reset back to a queued state still re-navigates to `seedUrl` (in-page state such as a
   * half-filled form is not restored by a reset).
   */
  readonly startInPlace?: boolean;
  /**
   * #293: how a reset gets back to the start state before replaying a queued state's path, instead
   * of re-navigating to `seedUrl` — a journey-anchored run re-replays its Journey prefix, so in-page
   * state is restored too. Resolves `false` when it could not (the reset is then `seed-unreachable`).
   * Each call costs `restartCost` actions from `maxActions`.
   */
  readonly restartAtStart?: (actor: Actor) => Promise<boolean>;
  /** #293: the actions one `restartAtStart` costs against `maxActions` (the prefix's step count). Default 0. */
  readonly restartCost?: number;
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
  /** The run's host-health sampler (#203): a hang met while the host was starved is `environment-degraded`, never a finding. */
  readonly hostHealth?: HostHealthSampler;
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
   * #303 `--action-deltas` (opt-in): record what each frontier action changed (code verdict) on its
   * transcript step; actions with no visible effect (`no-change`) are listed as evidence of dead
   * controls. The frontier itself still expands by state fingerprint (unchanged). Off: no capture.
   */
  readonly actionDeltas?: boolean;
  /** Resolved `authFrom.secret` refs (#135) a declared probe may use: `env:VAR` → its value. */
  readonly invariantAuthTokens?: ReadonlyMap<string, string>;
  /** #245: show the on-page demo overlay (display only; invisible to the run). Default off: nothing injected. */
  readonly demoOverlay?: boolean;
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
  /**
   * Horizontal-overflow hard signal (#149): checked after every settled state (and on the seed
   * page) and, when it fires, recorded as a `DefectRecord` — a hard defect, never a Jev judgment
   * (guardrail #4). Runs by default only when the emulated viewport is narrower than 1024px, or
   * always when `checkOverflow` is set (CLI `--check-overflow`). The vertical-clipping signal (#302:
   * text cut off by a fixed-height box, or above the page top) runs alongside it, under the same gate.
   */
  readonly overflow?: {
    readonly checkOverflow?: boolean;
    readonly toleranceCss?: number;
    /** `--ignore-overflow <selector>` (repeatable): intentional overflow, never a defect. */
    readonly ignoreSelectors?: readonly string[];
    /** The device name (`--device`), recorded on a finding for context. */
    readonly device?: string;
    readonly secrets?: readonly string[];
  };
}

/** The seed's path WITH its query (`/workspace?inquiry=…`) — `toPath` drops the query, and a seed that
 *  needs it replays to a different page (#114). Sensitive query values stay masked. */
export function seedPath(seedUrl: string): string {
  return seedPathOf(seedUrl);
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
            ...(params.invariantAuthTokens === undefined ? {} : { authTokens: params.invariantAuthTokens }),
          }),
          log: new InvariantDefectLog(),
          lastRepro: null,
        };
  const safety = new MissionSafety(params.safety);
  // #150 — the SAME invariants monitor reads a budget's declared observables (one probe schedule,
  // the same #86/#135 read/auth/redaction machinery). A budget-only spec (no invariants) still works:
  // `declared` above is non-null whenever `params.invariants` is given, whatever its `invariants` array.
  const budgetDecls = params.invariants?.budget ?? [];
  const budget = declared === null || budgetDecls.length === 0 ? null : new BudgetMonitor(budgetDecls, declared.monitor);
  const overlay = demoOverlayFor(params.demoOverlay, params.secrets ?? []);
  const deltaLog: Array<{ delta: ActionDelta; action: string }> | null = params.actionDeltas === true ? [] : null;
  const result = { ...(await runInductionFrontier(params, declared, safety, budget, overlay, deltaLog)), ...safety.result() };
  await overlay?.finish(`jevitate · coverage — ${result.outcome}`, result.outcome === "exhausted" || result.outcome === "cap" || result.outcome === "budget");
  // #195: the shared end-of-run path — a never.response hit to the LAST action is never lost.
  if (declared !== null) await finishDeclaredRun(declared);
  return {
    ...result,
    ...(declared === null ? {} : { invariantDefects: declared.log.defects(), invariants: declared.monitor.report() }),
    ...(budget === null ? {} : { budget: budget.trajectory() }),
    ...(deltaLog === null
      ? {}
      : (() => {
          const noEffect = [...new Set(deltaLog.filter((d) => d.delta.verdict === "no-change").map((d) => d.action))].slice(0, 50);
          return { actionDeltas: { ...deltaStatsOf(deltaLog.map((d) => d.delta)), ...(noEffect.length === 0 ? {} : { noEffect }) } };
        })()),
  };
}

async function runInductionFrontier(
  params: InductionMissionParams,
  declared: Declared | null,
  safety: MissionSafety,
  budget: BudgetMonitor | null,
  overlay: DemoOverlay | null = null,
  deltaLog: Array<{ delta: ActionDelta; action: string }> | null = null,
): Promise<InductionRunResult> {
  const ctx: FrontierState = createFrontierContext(params, declared, safety, budget, overlay, deltaLog);

  try {
    const early = await loadSeed(ctx);
    if (early !== null) return early;

    while (!ctx.frontier.isExhausted()) {
      // Hard cap (guardrail #2): checked BEFORE spending — never guess one more step.
      if (ctx.actions + ctx.restartSpend >= ctx.bounds.maxActions) {
        return {
          outcome: "cap",
          coverage: ctx.report(false),
          recordings: [...ctx.statePaths.values()],
          transcript: ctx.transcript.entries(),
          timing: summarizeTimings(ctx.timings),
          hangs: [...ctx.hangs.values()],
        };
      }

      const item = ctx.frontier.popPreferring(ctx.currentFingerprint);
      if (item === undefined) break;

      const depth = item.pathPrefix.pages.reduce((n, p) => n + p.steps.length, 0);
      if (depth >= ctx.maxDepth) continue; // bounded exploration depth

      if (item.fromFingerprint !== ctx.currentFingerprint) {
        const reached = await reachItem(ctx, item);
        if (reached === "continue") continue;
        if (reached !== "next") return reached;
      }

      const acted = await actOnItem(ctx, item);
      if (acted === "continue") continue;

      const settled = await settleTransition(ctx, item, acted);
      if ("outcome" in settled) return settled;

      const left = await handleHangOrDeparture(ctx, item, acted, settled);
      if (left === "continue") continue;
      if (left !== "next") return left;

      const judged = await judgeState(ctx, item, acted, settled);
      if (judged === "continue") continue;
    }

    // #203: states did not run out — the frontier was drained by actions that timed out (each one
    // blacklisted its control). At least as many timed-out actions as exercised transitions means the
    // frontier ended on timeouts, so "exhausted" would claim coverage the run never had.
    if (ctx.timedOutActions > 0 && ctx.timedOutActions >= ctx.transitionsExercised) {
      return {
        outcome: "insufficient-coverage",
        failure: {
          kind: "insufficient-coverage",
          message: `the frontier ended because ${ctx.timedOutActions} action(s) timed out even after a retry (vs ${ctx.transitionsExercised} transition(s) exercised, ${ctx.visited.size} state(s) visited), not because its states ran out — a slow app or a loaded host can time out a working control: re-run it, or raise the click timeout with JEVITATE_CLICK_TIMEOUT_MS`,
        },
        coverage: ctx.report(true),
        recordings: [...ctx.statePaths.values()],
        transcript: ctx.transcript.entries(),
        timing: summarizeTimings(ctx.timings),
        hangs: [...ctx.hangs.values()],
      };
    }
    return {
      outcome: "exhausted",
      coverage: ctx.report(true),
      recordings: [...ctx.statePaths.values()],
      transcript: ctx.transcript.entries(),
      timing: summarizeTimings(ctx.timings),
      hangs: [...ctx.hangs.values()],
    };
  } catch (e) {
    // The watchdog fired (#114): a typed `stalled` stop with everything found so far, never an idle run.
    if (e instanceof StalledError) return ctx.ended("stalled", { kind: "stalled", message: e.reason });
    // Engine failure: a typed `crashed` result with every state path and transcript step so far —
    // unless the app stopped answering navigation (#226, a frozen backend): `scope-unreachable`
    // (inconclusive) with the typed `target-unresponsive` reason, never `crashed`.
    const failure = describeFailure(e, ctx.crashWatch.signals());
    return {
      // #296: a page whose renderer stopped answering (closed by the liveness watchdog) is `stalled`.
      outcome: isTargetUnresponsive(failure) ? "scope-unreachable" : isPageUnresponsive(failure) ? "stalled" : "crashed",
      failure,
      coverage: ctx.report(false),
      recordings: [...ctx.statePaths.values()],
      transcript: ctx.transcript.entries(),
      timing: summarizeTimings(ctx.timings),
      hangs: [...ctx.hangs.values()],
    };
  } finally {
    ctx.watchdog.stop();
    await ctx.sessions.closeOwned();
  }
}

