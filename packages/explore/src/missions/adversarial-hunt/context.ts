/**
 * The adversarial hunt's run state (#232): `HuntContext` holds every closure variable
 * `runAdversarialHunt` used to keep (names unchanged), and `createHuntContext` builds it — the same
 * initializers, in the same order, with the same listeners attached — before the run's first navigation.
 */

import type { MissionFailure, MissionOutcome } from "@jevitate/domain";
import type { BudgetDeclaration } from "@jevitate/recording";
import type { ActResult } from "../../act.js";
import { ActionDeltas, PageDeltas, type ActionDelta } from "../../action-delta.js";
import { PageSignalCollector, type DefectSignal } from "../../adversarial/defect-oracle.js";
import type { LastAction, MisuseStep } from "../../adversarial/form-misuse.js";
import { AuthRequestLog, type IdentityFingerprint } from "../../adversarial/identity.js";
import { CanaryTokens } from "../../adversarial/markup-canary.js";
import type { MisuseStrategy } from "../../adversarial/misuse.js";
import { CoverageTracker, resolveCoverageThresholds, type CoverageThresholds } from "../../adversarial/run-coverage.js";
import { scopeGlobs, scopePredicate } from "../../adversarial/scope.js";
import { assertAuthorizedExploreTarget } from "../../authorized-targets.js";
import { resolveBounds, type Bounds } from "../../bounds.js";
import { BudgetMonitor } from "../../budget.js";
import { HeapLog } from "../../crash-report.js";
import { InvariantMonitor, type InvariantAction, type InvariantViolation } from "../../declared-invariants.js";
import { ChromeTracker } from "../../feature/relevance.js";
import type { HangFinding } from "../../hang-repro.js";
import type { HangSignal } from "../../hang.js";
import { hostProbe, type HostPressure, type HostProbe } from "../../host-pressure.js";
import { CrashWatch } from "../../mission-failure.js";
import { MissionSafety } from "../../mission-safety.js";
import { MissionSessions } from "../../mission-session.js";
import { RunRecorder } from "../../record.js";
import type { HangConfig, SettleConfig, TimingConfig } from "../../settle-config.js";
import type { Control, Snapshot } from "../../snapshot.js";
import type { PageTiming } from "../../timing.js";
import { TranscriptLog, type TranscriptJudgment } from "../../transcript.js";
import type {
  AdversarialMissionParams,
  AdversarialOutcome,
  AdversarialStop,
  IdentityChange,
  ScopeDeparture,
} from "../adversarial.js";
import { installFinish } from "./finish.js";
import type { MutableAdvisory, MutableDefect, StepAdvisory, StepFinding } from "./helpers.js";
import { DEFAULT_TIME_BUDGET_MS } from "./helpers.js";
import { installOracle } from "./oracle.js";
import { installSessions } from "./sessions.js";
import { clock } from "@jevitate/domain";

/** The adversarial hunt's run state (#232): every closure variable `runAdversarialHunt()` used to keep, one field each, names unchanged. */
export interface HuntContext {
  readonly origin: string;
  readonly bounds: Bounds;
  readonly site: string;
  readonly now: () => number;
  readonly timeBudgetMs: number;
  readonly routeGlobs: string[];
  readonly inScope: (url: string) => boolean;
  readonly departures: ScopeDeparture[];
  outOfScopeSteps: number;
  readonly thresholds: CoverageThresholds;
  readonly cov: CoverageTracker;
  readonly sessions: MissionSessions;
  collector: PageSignalCollector;
  crashWatch: CrashWatch;
  readonly declared: InvariantMonitor | null;
  /** #300: when the run's pages last fired an auth-shaped request (time only). */
  readonly authRequests: AuthRequestLog;
  readonly budgetDecls: BudgetDeclaration[];
  readonly budget: BudgetMonitor | null;
  /** A `before` snapshot is armed for the action(s) the next adjudication judges. */
  armed: boolean;
  readonly heap: HeapLog;
  readonly safety: MissionSafety;
  readonly probeHost: HostProbe;
  crashHost: HostPressure | undefined;
  readonly secrets: readonly string[];
  /** #303 (opt-in): the action deltas, per transcript step (evidence on the defects found there). */
  readonly pageDeltas: PageDeltas | null;
  readonly stepDeltas: Map<number, ActionDelta>;
  /** #303: the tracker holding a before-capture for the action about to fire, else null. */
  deltaArmed: ActionDeltas | null;
  readonly segments: RunRecorder[];
  recorder: RunRecorder;
  readonly transcript: TranscriptLog;
  readonly defects: Map<string, MutableDefect>;
  readonly advisories: Map<string, MutableAdvisory>;
  readonly hangs: Map<string, HangFinding>;
  /** Every perception's full timing (with request samples), once each — the run summary's input. */
  readonly timings: PageTiming[];
  readonly perceiveOpts: { timingConfig?: TimingConfig | undefined; hangConfig?: HangConfig | undefined; settleConfig?: SettleConfig | undefined; requestBoundMs?: number | undefined; hangProbeMs?: number | undefined; renderWaitMs?: number | undefined; maxCandidates: number; secrets: readonly string[]; };
  /** #301: this run's inert canary tokens, and every one submitted (token → field, page, payload). */
  readonly canaries: CanaryTokens;
  readonly submittedCanaries: Map<string, { readonly field: string; readonly submittedOn: string; readonly payload: "html" | "attribute"; }>;
  readonly reportedCanaries: Set<string>;
  /** #300: the identity the run started as (hashes only), read once the seed page settled. */
  baseline: IdentityFingerprint | null;
  readonly identityChanges: IdentityChange[];
  readonly finish: (outcome: AdversarialOutcome["outcome"], stop: AdversarialStop, failure?: MissionFailure) => AdversarialOutcome;
  readonly perceiveNow: () => Promise<{ snapshot: Snapshot; timing: PageTiming; rendered: boolean; reason?: string; hang: HangSignal | null; }>;
  /**
   * A hang is recorded in the transcript, its steps are replayed in fresh contexts to reproduce it,
   * and it becomes a finding with k/N. The same hang again (by fingerprint) is one more occurrence —
   * never reproduced twice.
   */
  readonly recordHang: (signal: HangSignal, snapshot: Snapshot, timing: PageTiming) => Promise<void>;
  /**
   * Starts a NEW Recording segment at the start URL on the current session page (after a reset):
   * its findings replay from there, never through what ended the previous segment. Returns the
   * perceived start page, or why the run cannot go on (the start page hangs, or does not stay in
   * scope — e.g. the session was lost and it redirects to a login page).
   */
  /** #293: actions spent re-replaying the Journey prefix on resets (counted against `maxActions`). */
  restartSpend: number;
  readonly restartAtSeed: () => Promise<{ ok: true; snapshot: Snapshot; timing: PageTiming; } | { ok: false; stop: AdversarialStop; }>;
  /**
   * After a hang: reset to a known state — a fresh page when the mission can open one (a hung page
   * may not even navigate), else the same page — re-navigate to the start URL in a NEW Recording
   * segment, and keep hunting. Null when the mission cannot continue (an unresponsive page with no
   * way to open a fresh one, or a start page that itself hangs or leaves the scope).
   */
  readonly resetAfterHang: (h: HangSignal) => Promise<{ ok: true; snapshot: Snapshot; timing: PageTiming; } | { ok: false; stop: AdversarialStop; }>;
  /**
   * #300 — after an action switched the signed-in identity: a FRESH session from the original storage
   * state (the only way back to the identity the run was given), at the start URL in a new Recording
   * segment, whose identity must match the baseline again. When no fresh session can be opened, or
   * the restored one is not the original identity, the run cannot go on (`identity-changed`).
   */
  readonly restoreIdentity: () => Promise<{ ok: true; snapshot: Snapshot; timing: PageTiming; } | { ok: false; stop: AdversarialStop; why: string; }>;
  /** The run's verdict: every finding kind folded by severity (a confirmed hang dominates). */
  readonly verdict: () => MissionOutcome;
  /**
   * #150 — the verdict for a `stop: "budget"` ending: a clean, deliberate stop, so it is never
   * `clean` (the run didn't finish its work) — `inconclusive`, unless a defect was already found,
   * which still wins.
   */
  readonly budgetVerdict: () => MissionOutcome;
  /**
   * Horizontal-overflow hard signal (#149) for the CURRENT step, as a `DefectSignal` — pure DOM
   * geometry (`overflow.ts`'s `detectOverflow`), never a Jev judgment. Folded into `hardSignals`
   * alongside the console/network signals; dedup across occurrences is the same fingerprint-keyed
   * `fold()` every other hard signal already goes through.
   */
  readonly overflowSignals: () => Promise<DefectSignal[]>;
  /** A declared-invariant violation (#86) as a step finding. */
  readonly declaredFinding: (v: InvariantViolation) => StepFinding;
  /**
   * The independent oracle for one step: drains the hard signals and checks the user invariants —
   * the code-level `userInvariant` and the declared spec (against the `before` snapshot armed for
   * `action`; with no action only its `never`s apply). Returns the transcript reason and the step's
   * findings, or null when nothing broke.
   */
  readonly adjudicate: (action?: InvariantAction | null, opts?: { readonly identitySwitched?: boolean; }) => Promise<{ reason: string; findings: StepFinding[]; advisories: StepAdvisory[]; } | null>;
  /**
   * Signals that land AFTER a step was adjudicated — while the next page loads and settles (a 500
   * fired by the page the action opened) — belong to that step: drained and folded into it, so a
   * late signal is never lost (not even after the last step, or before a reset).
   */
  readonly drainLate: (step: number) => Promise<void>;
  /**
   * Folds one step's advisory signals into the deduped advisory set (mirrors `fold`, but no repro
   * or triage — an advisory is reported, never a defect, so nothing here needs to be reproduced).
   */
  readonly foldAdvisories: (step: number, list: readonly StepAdvisory[]) => void;
  /**
   * #250 — when each action of the current Recording segment FIRED (wall clock, the signal
   * collector's), with its transcript step and its last Recording step index: an HTTP 5xx is
   * attributed by when its request STARTED (`PageSignalCollector.requestStartOf`), the way
   * `Http5xxOracle` attributes it for the other strategies.
   */
  readonly fired: WeakMap<RunRecorder, { readonly at: number; readonly step: number; readonly index: number; }[]>;
  readonly markFired: (at: number, step: number) => void;
  /** The action whose request an `http-5xx` finding answered; undefined when it cannot tell. */
  readonly requestOrigin: (f: StepFinding) => { readonly step: number; readonly recordingStepIndex: number; } | undefined;
  /**
   * Folds one step's findings into the deduped defect set — called AFTER the step is in the
   * transcript, so a new defect's repro includes the step that surfaced it. A known fingerprint
   * (or one seen in a known defect's cascade) only counts an occurrence.
   */
  readonly fold: (drainedAt: number, findings: readonly StepFinding[]) => Promise<void>;
  readonly started: number;
  snap: Snapshot;
  snapTiming: PageTiming | undefined;
  last: LastAction | null;
  lastRecordedTarget: string | null;
  actions: number;
  strategySteps: number;
  idleStreak: number;
  readonly visitedLinks: Set<string>;
  /**
   * Control identities (#161, a regression of #75) that failed as not-actionable / timed out:
   * never re-chosen by any strategy for the rest of the run. The adversarial strategies pick
   * their own candidates from the live snapshot every step (no shared frontier of #75's own to
   * consult), so the mission loop tracks this itself.
   */
  readonly unactionable: Set<string>;
  /**
   * Controls found disabled when last planned (#188). Filling a form over several episodes may
   * enable its submit, so a disabled plan is never blacklisted — but it is recorded once per
   * disabled streak, not once per episode (a disabled "Create key" read as 7 clicks in one run).
   * An enabled plan ends the streak.
   */
  readonly disabledNow: Set<string>;
  /**
   * Controls the safety policy refused (#116) — never re-planned by any strategy (#193), so a
   * denied submit is attempted (and its refusal recorded) once, not every turn.
   */
  readonly refusedIds: Set<string>;
  /** #300: controls whose action switched the signed-in identity — never acted on again. */
  readonly identitySwitchers: Set<string>;
  /**
   * A click-afforded control the safety policy refuses (#116: `--deny`, paid, destructive) is never
   * offered as a target (#193) — withheld at planning, its refusal recorded once, like the
   * frontier missions do (#186).
   */
  readonly refuses: (c: Control) => boolean;
  /** Page chrome (#115/#193): a landmark control, or one seen unchanged on 2+ in-scope pathnames. */
  readonly chrome: ChromeTracker;
  readonly isChrome: (c: Control) => boolean;
  /** What clicks revealed (#193): a control that made a form appear, and disclosures that showed none. */
  readonly revealed: Map<string, readonly string[]>;
  readonly barren: Set<string>;
  /** Whether the run hunts with `exercise-controls` — then no strategy idles while controls remain (#193). */
  readonly exercises: boolean;
  readonly observeTarget: (on: Snapshot) => void;
  /** How many episodes each strategy has run (rotates its form, field and value). */
  readonly rounds: Map<MisuseStrategy, number>;
  stop: AdversarialStop | null;
  /** Why the run stopped, when that stop is itself the failure (#300 `identity-changed`). */
  stopFailure: MissionFailure | undefined;
  /** Wall-clock time the first action since the last adjudication fired (#300: auth requests since then). */
  chainStart: number | null;
  /** #301: canary tokens submitted since the last adjudicated step (checked after it, and after a reload). */
  readonly chainCanaries: Set<string>;
  /**
   * #301 — after a settled step: is any canary of this run rendered as MARKUP? When this step's
   * chain submitted one, the page is loaded again (a GET of the same in-scope URL — never a re-sent
   * form) and checked again: seen after that ⇒ stored, seen only before ⇒ reflected. A canary first
   * seen on a later page is stored. DOM inspection only — the payload is inert.
   */
  readonly checkCanaries: () => Promise<"ok" | "reloaded">;
  /**
   * SOFT augment only (guardrail #4). Jev's "looks broken?" is consulted and recorded in the
   * transcript — it is never read into the defect decision. Wiring this answer into the defect
   * condition would be the single most dangerous regression this mission can suffer. The state is
   * redacted and carries the prompt-injection guard like every other prompt. It is advisory, so an
   * unavailable judgment is recorded and the run goes on.
   */
  readonly softJudgment: (on: Snapshot) => Promise<{ judgments?: Record<string, TranscriptJudgment>; note?: string; }>;
  /**
   * One planned step through the gated act(). A select with no chosen option takes another
   * option. `send` (a chat composer: #121) is given the CURRENT page's controls as its submit
   * candidates, so it finds its own nearest Send button (or falls back to Enter) exactly as the
   * goal loop's composer handling does — never a separate detected submit control to plan around.
   */
  readonly execute: (s: MisuseStep, candidates: readonly Control[]) => Promise<{ result: ActResult; value?: string; }>;
  /** Appends an executed step to the Recording (the defect's repro path). */
  readonly recordAction: (s: MisuseStep, value: string | undefined, at: number, submittedVia?: ActResult["submittedVia"]) => void;
  /**
   * Perceives what an action produced and checks it: a hang is recorded, then the mission resets
   * to a known state and hunts on; an off-origin page sends it back to the seed. "reset" means the
   * page the episode was planned on is gone; "stop" means the mission cannot continue.
   */
  readonly observeAfter: (step: number, action: string) => Promise<{ kind: "ok"; } | { kind: "reset"; } | { kind: "stop"; stop: AdversarialStop; }>;
}

/** The writable view of the run state, for the code that sets it up. */
export type HuntState = { -readonly [K in keyof HuntContext]: HuntContext[K] };

/** Builds the run state of one hunt (everything before its first navigation). */
export function createHuntContext(params: AdversarialMissionParams): HuntContext {
  const ctx = {} as HuntState;
  // Guardrail #1 — authorize the target origin BEFORE anything else runs.
  ctx.origin = assertAuthorizedExploreTarget(params.seedUrl, params.allowlist);
  ctx.bounds = resolveBounds(params.bounds);
  ctx.site = params.site ?? ctx.origin;
  ctx.now = params.now ?? clock.now;
  ctx.timeBudgetMs = params.timeBudgetMs ?? DEFAULT_TIME_BUDGET_MS;
  if (params.strategies.length === 0) throw new Error("runAdversarialMission: at least one strategy is required");
  // Scope containment (#64): the start route (and below it) plus the caller's globs.
  ctx.routeGlobs = scopeGlobs(params.seedUrl, params.routeGlobs);
  ctx.inScope = scopePredicate(params.allowlist, ctx.routeGlobs);
  ctx.departures = [];
  ctx.outOfScopeSteps = 0;
  ctx.thresholds = resolveCoverageThresholds(params.coverageThresholds);
  ctx.cov = new CoverageTracker(ctx.inScope);

  // The live session; after a hang the mission resets to a fresh page and keeps hunting.
  ctx.sessions = new MissionSessions({ page: params.page, actor: params.actor }, params.openFreshSession);
  // Attach the hard-signal listeners BEFORE navigating (on every page the run works in).
  ctx.collector = new PageSignalCollector(params.page, clock.now, params.allowlist);
  ctx.crashWatch = new CrashWatch(params.page);
  // Declared invariants (#86): listening for `network` observables from before the first navigation.
  ctx.declared = params.invariants === undefined
      ? null
      : new InvariantMonitor(params.invariants, {
          allowlist: params.allowlist,
          baseUrl: params.seedUrl,
          ...(params.secrets === undefined ? {} : { secrets: params.secrets }),
          ...(params.invariantAuthTokens === undefined ? {} : { authTokens: params.invariantAuthTokens }),
        });
  ctx.declared?.attach(params.page);
  /** #300: when the run's pages last fired an auth-shaped request (time only). */
  ctx.authRequests = new AuthRequestLog();
  ctx.authRequests.attach(params.page);
  // #150 — the SAME invariants monitor reads a budget's declared observables (one probe schedule).
  ctx.budgetDecls = params.invariants?.budget ?? [];
  ctx.budget = ctx.declared === null || ctx.budgetDecls.length === 0 ? null : new BudgetMonitor(ctx.budgetDecls, ctx.declared);
  /** A `before` snapshot is armed for the action(s) the next adjudication judges. */
  ctx.armed = false;
  ctx.sessions.onReset((page) => {
    ctx.collector = new PageSignalCollector(page, clock.now, params.allowlist);
    ctx.crashWatch = new CrashWatch(page);
    ctx.declared?.attach(page);
    ctx.authRequests.attach(page);
    ctx.armed = false;
  });
  ctx.heap = new HeapLog();
  /** The shared safety policy and the writes the run fires (#116). */
  // Its clock is the page monitor's (wall time), never the `now` seam: writes are attributed by it.
  ctx.safety = new MissionSafety(params.safety);
  ctx.probeHost = params.hostProbe ?? hostProbe();
  ctx.crashHost = undefined;
  ctx.secrets = params.secrets ?? [];
  /** #303 (opt-in): the action deltas, per transcript step (evidence on the defects found there). */
  ctx.pageDeltas = params.actionDeltas === true ? new PageDeltas({ secrets: ctx.secrets, goal: "adversarial misuse" }) : null;
  ctx.stepDeltas = new Map<number, ActionDelta>();
  /** #303: the tracker holding a before-capture for the action about to fire, else null. */
  ctx.deltaArmed = null;
  // One Recording per segment: segment 0 from the seed; a new one after each reset (its findings
  // replay from that segment's start, never through the hang that ended the previous one).
  ctx.segments = [new RunRecorder(ctx.site, undefined, ctx.secrets, params.onRecording)];
  ctx.recorder = ctx.segments[0] as RunRecorder;
  ctx.transcript = new TranscriptLog(ctx.secrets, params.onTranscriptEntry);
  ctx.defects = new Map<string, MutableDefect>();
  ctx.advisories = new Map<string, MutableAdvisory>();
  ctx.hangs = new Map<string, HangFinding>();
  /** Every perception's full timing (with request samples), once each — the run summary's input. */
  ctx.timings = [];
  ctx.perceiveOpts = {
    maxCandidates: ctx.bounds.maxCandidates,
    // #219: page content is redacted of every registered secret as it is perceived.
    secrets: ctx.secrets,
    ...(params.renderWaitMs === undefined ? {} : { renderWaitMs: params.renderWaitMs }),
    ...(params.hangProbeMs === undefined ? {} : { hangProbeMs: params.hangProbeMs }),
    ...(params.requestBoundMs === undefined ? {} : { requestBoundMs: params.requestBoundMs }),
    ...(params.settle === undefined ? {} : { settleConfig: params.settle }),
    ...(params.hangs === undefined ? {} : { hangConfig: params.hangs }),
    ...(params.timingConfig === undefined ? {} : { timingConfig: params.timingConfig }),
  };

  /** #301: this run's inert canary tokens, and every one submitted (token → field, page, payload). */
  ctx.canaries = new CanaryTokens();
  ctx.submittedCanaries = new Map<string, { readonly field: string; readonly submittedOn: string; readonly payload: "html" | "attribute" }>();
  ctx.reportedCanaries = new Set<string>();
  /** #300: the identity the run started as (hashes only), read once the seed page settled. */
  ctx.baseline = null;
  ctx.identityChanges = [];

  installFinish(ctx);

  installSessions(ctx, params);
  installOracle(ctx, params);
  return ctx;
}
