import { ActionDeltas, deltaStatsOf, type ActionDelta, type ActionDeltaStats } from "../action-delta.js";
import type { Page } from "playwright";
import type { Actor } from "@jevitate/screenplay";
import type { InvariantSpec, Recording } from "@jevitate/recording";
import { redactUrl, type GenerationPort, type JudgmentPort } from "@jevitate/ai-core";
import {
  InvariantDefectLog,
  finishDeclaredRun,
  type DeclaredRun,
  InvariantMonitor,
  recordingStepCount,
  type InvariantDefect,
  type InvariantReport,
} from "../declared-invariants.js";
import {
  assertAuthorizedExploreTarget,
  act,
  type Bounds,
  type TranscriptEntry,
  type TranscriptListener,
} from "../index.js";
import { type MissionFailure } from "@jevitate/domain";
import type { SettleConfig, TimingConfig } from "../settle-config.js";
import type { ActResult } from "../act.js";
import { outOfScopeHangNote } from "../hang.js";
import { recordCoverageHang, type HangFinding } from "../hang-repro.js";
import { isAuthorizedExploreTarget } from "../authorized-targets.js";
import type { HostHealthSampler } from "../host-health.js";
import type { VerifySession } from "../verify-fix.js";
import { describeFailure, isPageUnresponsive, isTargetUnresponsive } from "../mission-failure.js";
import { monitorFor } from "../page-monitor.js";
import { summarizeTimings, type TimingSummary } from "../timing.js";
import { controlIdentity, stateFingerprint } from "../coverage/fingerprint.js";
import { reachFrontierState } from "../coverage/reach.js";
import { StalledError } from "../stall-watchdog.js";
import { isNavControl } from "../coverage/nav.js";
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
  extendPath,
  isTimeoutFailure,
  isUnactionableFailure,
  joinReasons,
  pathOf,
  resolveControl,
  withSeed,
  seedPath as seedPathOf,
} from "./induction-frontier/helpers.js";
import { createFrontierContext, type FrontierState } from "./induction-frontier/context.js";
import { loadSeed } from "./induction-frontier/seed.js";
import { judgeState } from "./induction-frontier/judge.js";

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
        ctx.watchdog.during(ctx.departed ? "returning to the seed after a departure" : "resetting to a queued state");
        const reached = await ctx.guard(
          reachFrontierState({
            actor: ctx.sessions.actor,
            seedUrl: params.seedUrl,
            ...(params.restartAtStart === undefined
              ? {}
              : {
                  reachSeed: async (): Promise<boolean> => {
                    ctx.restartSpend += params.restartCost ?? 0;
                    return params.restartAtStart!(ctx.sessions.actor);
                  },
                }),
            item,
            snapshotNow: ctx.takeSnapshot,
            homeUrl: params.seedUrl,
            currentUrl: () => ctx.sessions.page.url(),
            ...(params.reachTimeoutMs === undefined ? {} : { timeoutMs: params.reachTimeoutMs }),
          }),
        );
        if (!reached.ok) {
          if (reached.reason === "stale") {
            // Stale — dropped, never guessed at; so is every other item replaying the same path (#114).
            ctx.frontier.dropState(item.fromFingerprint);
            ctx.currentFingerprint = "";
            continue;
          }
          // The seed is gone (a lost session) or stopped answering: no queued item is reachable —
          // a typed stop, never an idle grind through every queued item's reset (#114).
          return ctx.ended("scope-unreachable", {
            kind: "target-unreachable",
            message: `could not return to the seed${ctx.departed ? " after a departure" : ""} (${reached.detail ?? reached.reason})`,
          });
        }
        ctx.snap = reached.snapshot;
        ctx.observe(ctx.snap);
        ctx.currentFingerprint = item.fromFingerprint;
        ctx.departed = false;
      }

      const liveControl = resolveControl(ctx.snap, item.control);
      if (liveControl === null) continue; // control vanished between snapshots — dropped

      // The shared safety policy (#116): never clicked, never retried (blacklisted), recorded once.
      const unsafe = safety.gate(item.op, liveControl);
      if (unsafe !== null) {
        ctx.frontier.blacklist(controlIdentity(liveControl));
        if (unsafe.first) {
          ctx.transcript.record({
            op: null,
            control: liveControl,
            confidence: null,
            chosenBy: "strategy",
            strategy: "safety-policy",
            origin: "engine",
            actOk: false,
            reason: unsafe.reason,
            snapshot: ctx.snap,
          });
        }
        continue;
      }
      // #245: the demo overlay says what is about to happen and highlights the target (display only).
      if (overlay !== null) {
        await overlay.announce(
          ctx.sessions.page,
          {
            step: ctx.transcript.nextStep,
            strategy: "coverage",
            op: item.op,
            target: liveControl.name || liveControl.summary,
            why: "map every reachable state of the app",
          },
          liveControl,
        );
      }
      const actedOn = ctx.snap.url;
      ctx.watchdog.during(`acting on "${liveControl.name || item.op}"`);
      if (declared !== null) await ctx.guard(declared.monitor.before(ctx.sessions.actor));
      safety.mark(ctx.transcript.nextStep, item.op, liveControl);
      const actOnce = (): Promise<ActResult> =>
        ctx.guard(
          act(ctx.sessions.actor, {
            op: item.op,
            control: liveControl,
            value: item.op === "click" ? null : "",
          }),
        );
      // #303 (opt-in): the page right before the action.
      let armed: ActionDeltas | null = null;
      if (ctx.pageDeltas !== null) {
        const dl = await ctx.pageDeltas.on(ctx.sessions.page);
        const route = pathOf(ctx.sessions.page.url());
        await dl.perceived(route).catch(() => null);
        try {
          await dl.beforeAction(route, item.op, liveControl);
          armed = dl;
        } catch {
          dl.discard();
        }
      }
      let result = await actOnce();
      // #213: a single timeout on a working control (a slow moment on a loaded host) is retried once
      // before it counts as a failed action — one blip must not make the run inconclusive.
      if (!result.ok && isTimeoutFailure(result.reason)) result = await actOnce();
      ctx.actions += 1;
      ctx.frontier.recordAttempt();
      const decidedOn = ctx.snap;
      // Each perception's timing is reported once (a failed act re-uses the same snapshot).
      const decidedOnTiming = ctx.lastTiming;
      ctx.lastTiming = undefined;
      if (!result.ok) {
        ctx.failedActions += 1;
        if (isTimeoutFailure(result.reason)) ctx.timedOutActions += 1;
        // A control that failed with a timeout (or was refused as not actionable — a clipped/
        // offscreen skip link, an occluded target) is never re-chosen for the rest of the run
        // (#75): every OTHER state that re-offers the same control identity drops it at `push`.
        if (isUnactionableFailure(result.reason)) ctx.frontier.blacklist(controlIdentity(liveControl));
        ctx.transcript.record({
          op: item.op,
          control: liveControl,
          confidence: null,
          chosenBy: "strategy",
          strategy: ctx.strategyLabel,
          actOk: false,
          ...(result.reason === undefined ? {} : { reason: result.reason }),
          snapshot: decidedOn,
          ...(decidedOnTiming === undefined ? {} : { timing: decidedOnTiming }),
        });
        continue;
      }

      ctx.frontier.markExercised(controlIdentity(liveControl));
      if (!isNavControl(liveControl, decidedOn.url)) ctx.nonNavActionsExercised += 1;
      else ctx.crossPageLinks.push(liveControl);

      ctx.snap = await ctx.guard(ctx.takeSnapshot());
      ctx.observe(ctx.snap);
      // #303 (opt-in): what the action changed — on its transcript step (recorded next).
      if (armed !== null && deltaLog !== null) {
        armed.acted({ label: `${item.op} ${liveControl.name}`.trim(), recordIndex: 0, step: ctx.transcript.nextStep });
        const d = await armed.perceived(pathOf(ctx.sessions.page.url())).catch(() => null);
        if (d !== null) {
          deltaLog.push({ delta: d.delta, action: d.delta.action });
          ctx.transcript.attachDelta(ctx.transcript.nextStep, d.delta);
        }
        armed = null;
      }
      const newFingerprint = stateFingerprint(ctx.snap);
      // #160: a toggle exercised once in each direction is dropped for the rest of the run instead
      // of oscillating forever (the same fix as the feature mission's frontier, which shares this
      // class).
      ctx.frontier.noteTransition(item.fromFingerprint, liveControl, newFingerprint);
      const branch = extendPath(item.pathPrefix, item.op, liveControl.descriptor, null, ctx.snap.url);
      ctx.transitionsExercised += 1;
      if (declared !== null && ctx.seenHang.last === null) {
        // Declared invariants (#86): judged on the settled state the action produced; the finding
        // replays this path from the seed (the frontier's reach navigates there first).
        const path = withSeed(branch, params.seedUrl);
        const checked = await ctx.guard(declared.monitor.after(ctx.sessions.actor, { op: item.op, control: liveControl.name, url: actedOn }));
        declared.lastRepro = { recordingStepIndex: recordingStepCount(path) - 1, recording: path };
        for (const v of checked.violations) declared.log.add(v, declared.lastRepro);
      }

      // #150 — post-settle: a crossed budget stops the mission cleanly, before its next action.
      if (budget !== null && ctx.seenHang.last === null) {
        const b = await ctx.guard(budget.afterSettle(ctx.sessions.page, ctx.transitionsExercised));
        if (b.crossed) {
          ctx.transcript.record({
            op: item.op,
            control: liveControl,
            confidence: null,
            chosenBy: "strategy",
            strategy: "budget",
            actOk: true,
            reason: b.reason ?? "mission budget crossed",
            snapshot: ctx.snap,
          });
          return {
            outcome: "budget",
            coverage: ctx.report(false),
            recordings: [...ctx.statePaths.values()],
            transcript: ctx.transcript.entries(),
            timing: summarizeTimings(ctx.timings),
            hangs: [...ctx.hangs.values()],
          };
        }
      }

      // A hang: record it (reproduced from the path that led here), reset to a known state and keep
      // exploring the rest of the frontier. The hung state is never expanded. Only IN-SCOPE pages
      // are hang-checked (#193): a page reached only by a departure is outside the target, so —
      // like every other out-of-scope page — it is never judged; its hang signal is noted on the
      // departure below as advisory, never a finding, and never part of the mission outcome.
      const hang = ctx.seenHang.last;
      if (hang !== null && ctx.inScope(ctx.snap.url)) {
        ctx.transcript.record({
          op: item.op,
          control: liveControl,
          confidence: null,
          chosenBy: "strategy",
          strategy: ctx.strategyLabel,
          actOk: true,
          reason: `hang (${hang.kind}): ${hang.detail}`,
          snapshot: decidedOn,
          ...(decidedOnTiming === undefined ? {} : { timing: decidedOnTiming }),
        });
        ctx.watchdog.suspend(); // the reproduction is bounded on its own (fresh contexts, bounded replays)
        const recorded = await recordCoverageHang({
          hang,
          // The path starts at the seed (the frontier's reach navigates there first): prepend it.
          recording: withSeed(branch, params.seedUrl),
          steps: ctx.transcript.entries(),
          found: ctx.hangs,
          ...(params.safety === undefined ? {} : { safety: params.safety }),
          ...(params.openFreshSession === undefined ? {} : { openSession: params.openFreshSession }),
          ...(params.hangReplays === undefined ? {} : { attempts: params.hangReplays }),
          ...(params.hostHealth === undefined ? {} : { hostHealth: params.hostHealth }),
          // #230: an app that stopped answering ends the run target-unresponsive, never a hang finding.
          liveness: { pageUrl: ctx.sessions.page.url(), authorized: (u) => isAuthorizedExploreTarget(u, params.allowlist) },
          // Re-detected with the SAME perception bounds the mission used.
          perceive: {
            ...(params.renderWaitMs === undefined ? {} : { renderWaitMs: params.renderWaitMs }),
            ...(params.settle === undefined ? {} : { settleConfig: params.settle }),
          },
        });
        ctx.watchdog.kick("resetting after a hang");
        if (!(await ctx.guard(ctx.sessions.reset(hang)))) {
          return {
            outcome: "hang",
            // #203: the page that could not be reset from was hung on a starved host — not an app hang.
            ...(recorded === "degraded"
              ? { failure: { kind: "degraded-environment", message: `the page stopped responding (${hang.kind}) while the host was starved, and no fresh session could replace it` } }
              : {}),
            coverage: ctx.report(false),
            recordings: [...ctx.statePaths.values()],
            transcript: ctx.transcript.entries(),
            timing: summarizeTimings(ctx.timings),
            hangs: [...ctx.hangs.values()],
          };
        }
        await ctx.guard(monitorFor(ctx.sessions.page).instrument());
        safety.attach(monitorFor(ctx.sessions.page));
        ctx.currentFingerprint = ""; // the next item is reached afresh from the seed
        continue;
      }

      // Scope containment (#89, reusing #64's scope model): a transition that landed outside the
      // target is recorded (a departure) but never expanded — its controls are never enqueued, and
      // it is never judged, so the frontier stays prioritized on the in-scope target instead of
      // wandering into the rest of the app. The next frontier pop (necessarily sourced from an
      // in-scope state, since only those are ever enqueued) resets and replays back into scope.
      if (!ctx.inScope(ctx.snap.url)) {
        ctx.outOfScopeTransitions += 1;
        const landed = redactUrl(ctx.snap.url);
        ctx.departures.push({ fromFingerprint: ctx.currentFingerprint, url: landed, action: liveControl.name || item.op });
        ctx.transcript.record({
          op: item.op,
          control: liveControl,
          confidence: null,
          chosenBy: "strategy",
          strategy: ctx.strategyLabel,
          actOk: true,
          reason: joinReasons([
            `left the target scope (landed on ${landed}); not expanded`,
            hang === null ? undefined : outOfScopeHangNote(hang),
          ]),
          snapshot: decidedOn,
          ...(decidedOnTiming === undefined ? {} : { timing: decidedOnTiming }),
        });
        ctx.currentFingerprint = newFingerprint;
        ctx.departed = true;
        if (hang !== null) {
          // The page still looked hung: leave it for a fresh one when the mission can open one (the
          // next item's reach re-navigates to the seed either way). Never a finding, never a stop.
          await ctx.guard(ctx.sessions.reset(hang));
          await ctx.guard(monitorFor(ctx.sessions.page).instrument());
          safety.attach(monitorFor(ctx.sessions.page));
          ctx.currentFingerprint = "";
        }
        continue;
      }

      const judged = await judgeState(ctx, item, { liveControl, actedOn, armed, result, decidedOn, decidedOnTiming }, { newFingerprint, branch });
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

