import type { Page } from "playwright";
import type { Actor } from "@jevitate/screenplay";
import { Navigate } from "@jevitate/screenplay";
import type { Recording } from "@jevitate/recording";
import { redactUrl, type JudgmentPort, type GenerationPort } from "@jevitate/ai-core";
import { combineOutcomes, type MissionFailure, type MissionOutcome } from "@jevitate/domain";
import { assertAuthorizedExploreTarget } from "../authorized-targets.js";
import { resolveBounds, type Bounds } from "../bounds.js";
import type { Control, Snapshot } from "../snapshot.js";
import { perceive } from "../perceive.js";
import { monitorFor } from "../page-monitor.js";
import { summarizeTimings, type PageTiming, type TimingSummary } from "../timing.js";
import { hangFingerprint, type HangSignal } from "../hang.js";
import { MissionSessions } from "../mission-session.js";
import { hostProbe, type HostPressure, type HostProbe } from "../host-pressure.js";
import type { HangConfig, SettleConfig, TimingConfig } from "../settle-config.js";
import { NOT_REPLAYED, hangFinding, hangOutcome, reproduceHang, type HangFinding, type HangReproduction } from "../hang-repro.js";
import type { VerifySession } from "../verify-fix.js";
import { act, type ActResult } from "../act.js";
import { buildJudgmentState } from "../redact.js";
import { PROMPT_INJECTION_GUARD } from "../decide.js";
import {
  TranscriptLog,
  type TranscriptEntry,
  type TranscriptJudgment,
  type TranscriptListener,
} from "../transcript.js";
import { CrashWatch, describeFailure, describeUnreachable, isUnreachableTarget, tryTriage, type Triage } from "../mission-failure.js";
import { HeapLog, buildCrashReport, sampleHeap, type CrashReport } from "../crash-report.js";
import type { HeapSample } from "@jevitate/domain";
import { RunRecorder, emptyRecording } from "../record.js";
import { isAdvisoryConsoleError, PageSignalCollector, type DefectSignal } from "../adversarial/defect-oracle.js";
import {
  advisoryTitle,
  defectTitle,
  groupStepSignals,
  invariantFingerprint,
  messageClass,
  normalizeRoute,
  signalFingerprint,
} from "../adversarial/defect-fingerprint.js";
import type { MisuseStrategy } from "../adversarial/misuse.js";
import { scopeGlobs, scopePredicate } from "../adversarial/scope.js";
import { planMisuseEpisode, type LastAction, type MisuseStep } from "../adversarial/form-misuse.js";
import {
  CoverageTracker,
  resolveCoverageThresholds,
  type AdversarialCoverage,
  type CoverageThresholds,
} from "../adversarial/run-coverage.js";
import { descriptorToLocator } from "@jevitate/recorder";
import { seedRedirectReason } from "../seed-redirect.js";
import { MissionSafety } from "../mission-safety.js";
import type { SafetyConfig } from "../safety.js";
import type { SideEffect } from "../side-effects.js";
import type { InvariantSpec } from "@jevitate/recording";
import {
  InvariantMonitor,
  type InvariantAction,
  type InvariantReport,
  type InvariantViolation,
} from "../declared-invariants.js";
import { BudgetMonitor, type BudgetTrajectory } from "../budget.js";

/**
 * runAdversarialMission — a bounded "try to break it" run that KEEPS HUNTING.
 *
 * The mission cycles bounded misuse strategies (ordering violations,
 * repeated/rapid actions, navigation during pending async, boundary/invalid
 * inputs chosen by field semantics, contradictory actions, following links to
 * other routes) until its step, action or time budget runs out, and after EVERY
 * step asks a TRUSTED HARD-SIGNAL oracle (`PageSignalCollector`) whether the app
 * broke — a console error, an HTTP 5xx, a failed request, an unhandled page
 * exception — plus the user's invariants: an optional code-level `userInvariant` and the app-
 * declared invariant spec (#86), both evaluated around every adjudicated step.
 *
 * A defect is the mission's SUCCESS case, so it is data: finding one does not
 * stop the run. Each defect is keyed by a stable fingerprint (signal kind +
 * normalized route/endpoint + status/message class — see
 * `defect-fingerprint.ts`); a later occurrence of the same fingerprint only
 * counts an occurrence. Every defect carries its reproduction: the ordered
 * transcript steps that led to it and the flat index of the Recording step to
 * replay up to (`RecordingInterpreter.runToCheckpoint`), which `verifyFix`
 * replays to decide "fixed" vs "still reproduces".
 *
 * GUARDRAIL #4 (the mission's defining property): a defect comes EXCLUSIVELY
 * from that independent oracle or the user invariant. Jev's `Noul` "does this
 * look broken?" is a SOFT augment only — recorded in the transcript and
 * discarded; it can never, alone, conclude a defect. A "looks broken" Noul with
 * no hard signal MUST NOT surface as a defect (proved in adversarial.test.ts).
 *
 * The triage narrative gets a REDACTED failure summary + URL only (never raw
 * form state — guardrail #3). It is a HELPER: when it cannot be generated the
 * defect is still recorded with its raw evidence and the triage is marked
 * `unavailable` with the reason.
 *
 * The outcome is always a typed result, never a throw: an engine failure
 * (browser/page crash, unexpected exception) returns `crashed` with the partial
 * transcript, Recording and every defect found so far; a seed page that never
 * renders returns `inconclusive`. Neither can ever read as `clean`.
 */

/** How to reproduce a defect: the steps that led to it and where to replay the Recording to. */
export interface DefectRepro {
  /** The ordered transcript steps up to and including the one that surfaced the defect. */
  readonly steps: TranscriptEntry[];
  /** Flat index (pages→steps) of the last Recording step to replay; `runToCheckpoint` target. */
  readonly recordingStepIndex: number;
  /**
   * The Recording to replay, when the finding came after a RESET (the mission started over on a
   * fresh page after a hang): that segment's own Recording. Absent ⇒ the run's `recording`.
   */
  readonly recording?: Recording;
}

export interface AdversarialDefect {
  /** Stable identity (16 hex): same bug, same fingerprint — across steps and across runs. */
  readonly fingerprint: string;
  /** Every signal fingerprint seen with it (the cascade one broken call fires). */
  readonly related: string[];
  readonly kind: DefectSignal["kind"] | "invariant";
  readonly title: string;
  /** Normalized route (path pattern) of the page it was first seen on. */
  readonly route: string;
  /** The (redacted) page URL it was first seen on. */
  readonly url: string;
  /** The raw hard-signal evidence of its first occurrence. */
  readonly signals: DefectSignal[];
  /** The invariant's reason, for an `invariant` defect. */
  readonly invariantReason?: string;
  /** For a DECLARED invariant (#86): its id, expression, before/after values, action and evidence. */
  readonly invariant?: InvariantViolation;
  readonly firstSeenStep: number;
  readonly occurrences: number;
  readonly occurrenceSteps: number[];
  readonly repro: DefectRepro;
  readonly triage: Triage;
}

/**
 * A console error correlated with a captured 4xx response (#88): reported for visibility, but
 * NEVER a defect — a 4xx is a response the server returned by design (an authorization refusal, a
 * validation error), so it is advisory, lower severity, and never counted toward `defects-found`.
 * A 5xx-correlated (or uncorrelated) console error is unaffected and still files as a defect.
 */
export interface AdvisorySignal {
  /** Stable identity (16 hex): same signal, same fingerprint — across steps and across runs. */
  readonly fingerprint: string;
  readonly kind: "console-error";
  readonly title: string;
  /** Normalized route (path pattern) of the page it was first seen on. */
  readonly route: string;
  /** The (redacted) page URL it was first seen on. */
  readonly url: string;
  /** The correlated response's status (always 4xx — the only case reported as advisory). */
  readonly status: number;
  /** The raw console-error detail. */
  readonly detail: string;
  readonly firstSeenStep: number;
  readonly occurrences: number;
  readonly occurrenceSteps: number[];
}

/** Why the hunt ended (the mission's budget, or nothing left to try). */
export type AdversarialStop =
  | "step-budget"
  | "action-budget"
  | "time-budget"
  | "strategies-exhausted"
  | "not-rendered"
  /** The start URL did not stay in scope (it redirected elsewhere), so the target could not be tested. */
  | "scope-unreachable"
  | "hang"
  | "crashed"
  /** A declared mission spend budget (#150) was crossed, or a paid action was refused before crossing it. */
  | "budget";

/** The typed result of an adversarial run — returned for every ending, including engine failure. */
export interface AdversarialOutcome {
  readonly outcome: MissionOutcome;
  readonly stop: AdversarialStop;
  /** Distinct defects (deduped by fingerprint), in first-seen order. */
  readonly defects: AdversarialDefect[];
  /** 4xx-correlated console errors (#88): reported, deduped by fingerprint, never counted as defects. */
  readonly advisories: AdvisorySignal[];
  /** Hangs found (the run stops at a hang), each with its fresh-context reproduction k/N. */
  readonly hangs: HangFinding[];
  /** The run's Recording (partial when the run crashed) — every defect's repro path. */
  readonly recording: Recording;
  readonly transcript: TranscriptEntry[];
  /** Why the run ended `crashed`/`inconclusive`. */
  readonly failure?: MissionFailure;
  /** The page's JS heap per step (resource evidence for crash attribution). */
  readonly heap: HeapSample[];
  /** For a `crashed` run: the evidence and its attribution (jevitate / system under test / uncertain). */
  readonly crash?: CrashReport;
  /** Per-run timing summary: slowest pages/transitions and endpoints (p50/max), keyed by route. */
  readonly timing: TimingSummary;
  /** The target scope and every departure from it. */
  readonly scope: AdversarialScope;
  /** What the run exercised on its target, and whether that was enough for silence to mean clean. */
  readonly coverage: AdversarialCoverage;
  /** Per declared invariant (#86): how often it applied, held, was violated, or could not be read. */
  readonly invariants?: InvariantReport[];
  /** The writes the run's actions fired (#116), marked when the control was paid / destructive. */
  readonly sideEffects?: SideEffect[];
  readonly sideEffectsTruncated?: number;
  /** Declared mission spend budgets (#150): the observed trajectory, present when any were declared. */
  readonly budget?: BudgetTrajectory[];
}

export interface AdversarialMissionParams {
  readonly page: Page;
  readonly actor: Actor;
  readonly judgment: JudgmentPort;
  readonly generation: GenerationPort;
  readonly seedUrl: string;
  readonly allowlist: readonly string[];
  /** The strategies, cycled in order until a budget runs out. */
  readonly strategies: readonly MisuseStrategy[];
  /** `maxDecisions` caps strategy steps, `maxActions` caps executed actions. */
  readonly bounds?: Partial<Bounds>;
  /** Wall-clock budget for the hunt (ms). Default 10 minutes. */
  readonly timeBudgetMs?: number;
  /** An independent, user-declared (code-level) invariant. `ok:false` is a HARD defect. */
  readonly userInvariant?: (page: Page) => Promise<{ ok: boolean; reason?: string }>;
  /**
   * App-declared invariants (#86): the closed, declarative spec, snapshotted before each action and
   * evaluated after it (with every `never`). A violation is a HARD defect keyed by id + route —
   * the same oracle path as `userInvariant`, generalised to before/after, network and probes.
   */
  readonly invariants?: InvariantSpec;
  /** Recording.site label. Defaults to the seed origin. */
  readonly site?: string;
  /** Bound (ms) on waiting for a rendered page before each strategy step. Default `RENDER_WAIT_MS`. */
  readonly renderWaitMs?: number;
  /** Incremental-flush seam: every transcript entry, as it is recorded. */
  readonly onTranscriptEntry?: TranscriptListener;
  /** Incremental-flush seam: the partial Recording after every recorded step. */
  readonly onRecording?: (recording: Recording) => void;
  /** Clock seam (ms). Default `Date.now`. */
  readonly now?: () => number;
  /** Registered secret values: redacted out of the transcript and the Recording. */
  readonly secrets?: readonly string[];
  /** Resolved `authFrom.secret` refs (#135) a declared probe may use: `env:VAR` → its value. */
  readonly invariantAuthTokens?: ReadonlyMap<string, string>;
  /**
   * Opens a FRESH browser session — used to reproduce a hang by replaying its steps. Without it a
   * hang cannot be confirmed and is reported `intermittent` (0 replays), never dropped.
   */
  readonly openFreshSession?: () => Promise<VerifySession>;
  /** How many fresh-context replays confirm a hang. Default 2. */
  readonly hangReplays?: number;
  /** Bound on the main-thread probe (ms). Default `HANG_PROBE_MS`. */
  readonly hangProbeMs?: number;
  /** A request pending longer than this (ms) is a hang. Default: half the render ceiling. */
  readonly requestBoundMs?: number;
  /** Samples the HOST's resource pressure for hang/crash evidence. Default: this platform's signals. */
  readonly hostProbe?: HostProbe;
  /** The target's timing configuration (API path prefixes). */
  readonly timingConfig?: TimingConfig;
  /** The target's settle configuration (background requests, long-poll threshold). */
  readonly settle?: SettleConfig;
  /** The target's hang configuration (`ui-no-progress` ignores). */
  readonly hangs?: HangConfig;
  /**
   * The shared safety policy (#116). Misuse never targets a session-ending or destructive control
   * (form-misuse's own rule, whatever this says); the policy adds paid and --deny'd controls.
   */
  readonly safety?: SafetyConfig;
  /**
   * Extra in-scope route globs (CLI `--route`, the feature mission's glob syntax). The scope is
   * always the start URL's route and everything under it; these add to it.
   */
  readonly routeGlobs?: readonly string[];
  /**
   * How much of the target a run must exercise before "found nothing" may be reported `clean`.
   * Default `DEFAULT_COVERAGE_THRESHOLDS` (25% of the target's controls, and a submitted form when
   * there is one). Below them a silent run is `inconclusive`, with its coverage attached.
   */
  readonly coverageThresholds?: Partial<CoverageThresholds>;
}

/** One time the run left its target scope (and was reset to the start URL). */
export interface ScopeDeparture {
  /** The transcript step whose action left the scope. */
  readonly step: number;
  /** The (redacted) URL it landed on. */
  readonly url: string;
  /** What was acted on (control name or op). */
  readonly action: string;
}

/** Where the run was allowed to hunt, and how often it left. Out-of-scope steps never count as coverage. */
export interface AdversarialScope {
  readonly routeGlobs: string[];
  /** Steps whose result landed outside the scope (each was followed by a reset). */
  readonly outOfScopeSteps: number;
  /** The first departures (up to 50), in order. */
  readonly departures: ScopeDeparture[];
  /** Times the run moved to a fresh page (after a departure or a hang). */
  readonly resets: number;
}

const MAX_LISTED_DEPARTURES = 50;

export const DEFAULT_ADVERSARIAL_TIME_BUDGET_MS = 10 * 60_000;

/** A defect as seen on ONE step, before it is folded into the deduped set. */
interface StepFinding {
  readonly fingerprint: string;
  readonly related: readonly string[];
  readonly kind: AdversarialDefect["kind"];
  readonly title: string;
  readonly route: string;
  readonly url: string;
  readonly signals: DefectSignal[];
  readonly invariantReason?: string;
  readonly invariant?: InvariantViolation;
}

interface MutableDefect extends Omit<StepFinding, "related"> {
  readonly related: Set<string>;
  /** The recording segment (0 = before any reset) the defect was found in. */
  readonly epoch: number;
  readonly firstSeenStep: number;
  readonly occurrenceSteps: number[];
  readonly repro: DefectRepro;
  readonly triage: Triage;
}

/** An advisory (4xx-correlated console-error) signal as seen on ONE step, before it is deduped. */
interface StepAdvisory {
  readonly fingerprint: string;
  readonly title: string;
  readonly route: string;
  readonly url: string;
  readonly status: number;
  readonly detail: string;
}

interface MutableAdvisory extends StepAdvisory {
  readonly firstSeenStep: number;
  readonly occurrenceSteps: number[];
}

function freezeAdvisory(a: MutableAdvisory): AdvisorySignal {
  return {
    fingerprint: a.fingerprint,
    kind: "console-error",
    title: a.title,
    route: a.route,
    url: a.url,
    status: a.status,
    detail: a.detail,
    firstSeenStep: a.firstSeenStep,
    occurrences: a.occurrenceSteps.length,
    occurrenceSteps: [...a.occurrenceSteps],
  };
}

/** Builds a step advisory from a console-error signal already confirmed advisory (4xx-correlated). */
function stepAdvisory(
  signal: Extract<DefectSignal, { kind: "console-error" }> & { correlatedStatus: number },
  route: string,
  url: string,
): StepAdvisory {
  return {
    fingerprint: signalFingerprint(signal),
    title: advisoryTitle(signal, signal.correlatedStatus),
    route,
    url,
    status: signal.correlatedStatus,
    detail: signal.detail,
  };
}

function freeze(d: MutableDefect, segments: readonly (Recording | null)[]): AdversarialDefect {
  const segment = d.epoch === 0 ? null : (segments[d.epoch] ?? null);
  return {
    fingerprint: d.fingerprint,
    related: [...d.related],
    kind: d.kind,
    title: d.title,
    route: d.route,
    url: d.url,
    signals: d.signals,
    ...(d.invariantReason === undefined ? {} : { invariantReason: d.invariantReason }),
    ...(d.invariant === undefined ? {} : { invariant: d.invariant }),
    firstSeenStep: d.firstSeenStep,
    occurrences: d.occurrenceSteps.length,
    occurrenceSteps: [...d.occurrenceSteps],
    repro: segment === null ? d.repro : { ...d.repro, recording: segment },
    triage: d.triage,
  };
}

export async function runAdversarialMission(params: AdversarialMissionParams): Promise<AdversarialOutcome> {
  // Guardrail #1 — authorize the target origin BEFORE anything else runs.
  const origin = assertAuthorizedExploreTarget(params.seedUrl, params.allowlist);
  const bounds = resolveBounds(params.bounds);
  const site = params.site ?? origin;
  const now = params.now ?? Date.now;
  const timeBudgetMs = params.timeBudgetMs ?? DEFAULT_ADVERSARIAL_TIME_BUDGET_MS;
  if (params.strategies.length === 0) throw new Error("runAdversarialMission: at least one strategy is required");
  // Scope containment (#64): the start route (and below it) plus the caller's globs.
  const routeGlobs = scopeGlobs(params.seedUrl, params.routeGlobs);
  const inScope = scopePredicate(params.allowlist, routeGlobs);
  const departures: ScopeDeparture[] = [];
  let outOfScopeSteps = 0;
  const thresholds = resolveCoverageThresholds(params.coverageThresholds);
  const cov = new CoverageTracker(inScope);

  // The live session; after a hang the mission resets to a fresh page and keeps hunting.
  const sessions = new MissionSessions({ page: params.page, actor: params.actor }, params.openFreshSession);
  // Attach the hard-signal listeners BEFORE navigating (on every page the run works in).
  let collector = new PageSignalCollector(params.page);
  let crashWatch = new CrashWatch(params.page);
  // Declared invariants (#86): listening for `network` observables from before the first navigation.
  const declared =
    params.invariants === undefined
      ? null
      : new InvariantMonitor(params.invariants, {
          allowlist: params.allowlist,
          baseUrl: params.seedUrl,
          ...(params.secrets === undefined ? {} : { secrets: params.secrets }),
          ...(params.invariantAuthTokens === undefined ? {} : { authTokens: params.invariantAuthTokens }),
        });
  declared?.attach(params.page);
  // #150 — the SAME invariants monitor reads a budget's declared observables (one probe schedule).
  const budgetDecls = params.invariants?.budget ?? [];
  const budget = declared === null || budgetDecls.length === 0 ? null : new BudgetMonitor(budgetDecls, declared);
  /** A `before` snapshot is armed for the action(s) the next adjudication judges. */
  let armed = false;
  sessions.onReset((page) => {
    collector = new PageSignalCollector(page);
    crashWatch = new CrashWatch(page);
    declared?.attach(page);
    armed = false;
  });
  const heap = new HeapLog();
  /** The shared safety policy and the writes the run fires (#116). */
  // Its clock is the page monitor's (wall time), never the `now` seam: writes are attributed by it.
  const safety = new MissionSafety(params.safety);
  const probeHost = params.hostProbe ?? hostProbe();
  let crashHost: HostPressure | undefined;
  const secrets = params.secrets ?? [];
  // One Recording per segment: segment 0 from the seed; a new one after each reset (its findings
  // replay from that segment's start, never through the hang that ended the previous one).
  const segments: RunRecorder[] = [new RunRecorder(site, undefined, secrets, params.onRecording)];
  let recorder = segments[0] as RunRecorder;
  const transcript = new TranscriptLog(secrets, params.onTranscriptEntry);
  const defects = new Map<string, MutableDefect>();
  const advisories = new Map<string, MutableAdvisory>();
  const hangs = new Map<string, HangFinding>();
  /** Every perception's full timing (with request samples), once each — the run summary's input. */
  const timings: PageTiming[] = [];
  const perceiveOpts = {
    maxCandidates: bounds.maxCandidates,
    ...(params.renderWaitMs === undefined ? {} : { renderWaitMs: params.renderWaitMs }),
    ...(params.hangProbeMs === undefined ? {} : { hangProbeMs: params.hangProbeMs }),
    ...(params.requestBoundMs === undefined ? {} : { requestBoundMs: params.requestBoundMs }),
    ...(params.settle === undefined ? {} : { settleConfig: params.settle }),
    ...(params.hangs === undefined ? {} : { hangConfig: params.hangs }),
    ...(params.timingConfig === undefined ? {} : { timingConfig: params.timingConfig }),
  };

  const finish = (
    outcome: AdversarialOutcome["outcome"],
    stop: AdversarialStop,
    failure?: MissionFailure,
  ): AdversarialOutcome => {
    const finished = (segments[0] as RunRecorder).tryFinish({ intent: "adversarial" });
    const later = segments.map((r, i) => {
      if (i === 0) return null;
      const f = r.tryFinish({ intent: "adversarial (after reset)" });
      return f.ok ? f.recording : null;
    });
    const recordingFailure: MissionFailure | undefined = finished.ok
      ? undefined
      : { kind: "exception", message: `recording rejected: ${finished.reason}` };
    const coverage = cov.report(thresholds, outOfScopeSteps);
    // A run that found nothing only means something if it tried: below the coverage thresholds a
    // silent run proved nothing about its target, so it is `inconclusive` — never `clean`.
    const thin = outcome === "clean" && !coverage.sufficient;
    const coverageFailure: MissionFailure | undefined = thin
      ? { kind: "insufficient-coverage", message: `coverage below thresholds: ${coverage.shortfalls.join("; ")}` }
      : undefined;
    const finalFailure = failure ?? recordingFailure ?? coverageFailure;
    const honest: MissionOutcome = thin ? "inconclusive" : outcome;
    return {
      coverage,
      outcome: finished.ok ? honest : "crashed",
      stop: finished.ok ? stop : "crashed",
      defects: [...defects.values()].map((d) => freeze(d, later)),
      advisories: [...advisories.values()].map(freezeAdvisory),
      hangs: [...hangs.values()],
      recording: finished.ok ? finished.recording : emptyRecording(site, finished.reason),
      transcript: transcript.entries(),
      ...(finalFailure === undefined ? {} : { failure: finalFailure }),
      heap: heap.samples(),
      timing: summarizeTimings(timings),
      scope: { routeGlobs, outOfScopeSteps, departures: departures.slice(0, MAX_LISTED_DEPARTURES), resets: sessions.resets },
      ...(declared === null ? {} : { invariants: declared.report() }),
      ...(budget === null ? {} : { budget: budget.trajectory() }),
      ...safety.result(),
      ...(outcome === "crashed" && finalFailure !== undefined
        ? {
            crash: buildCrashReport(finalFailure, crashWatch.signals(), heap.samples(), {
              ...(crashHost === undefined ? {} : { host: crashHost }),
            }),
          }
        : {}),
    };
  };

  const perceiveNow = async (): Promise<{
    snapshot: Snapshot;
    timing: PageTiming;
    rendered: boolean;
    reason?: string;
    hang: HangSignal | null;
  }> => {
    const p = await perceive(sessions.page, perceiveOpts);
    timings.push(p.timing);
    await heap.sample(sessions.page, transcript.nextStep);
    return p.rendered
      ? { snapshot: p.snapshot, timing: p.timing, rendered: true, hang: p.hang }
      : { snapshot: p.snapshot, timing: p.timing, rendered: false, reason: p.reason, hang: p.hang };
  };

  /**
   * A hang is recorded in the transcript, its steps are replayed in fresh contexts to reproduce it,
   * and it becomes a finding with k/N. The same hang again (by fingerprint) is one more occurrence —
   * never reproduced twice.
   */
  const recordHang = async (signal: HangSignal, snapshot: Snapshot, timing: PageTiming): Promise<void> => {
    let h = signal;
    transcript.record({
      op: null,
      control: null,
      confidence: null,
      chosenBy: "strategy",
      strategy: "hang-check",
      actOk: false,
      reason: `hang (${h.kind}): ${h.detail}`,
      snapshot,
      timing,
    });
    const step = transcript.nextStep - 1;
    const known = hangs.get(hangFingerprint(h));
    if (known !== undefined) {
      // Already confirmed (or being confirmed): no replay budget spent again — just one more
      // occurrence, and the route added when it is a new one ("also seen on <route>", #87).
      hangs.set(known.fingerprint, {
        ...known,
        occurrences: known.occurrences + 1,
        occurrenceSteps: [...known.occurrenceSteps, step],
        routes: known.routes.includes(h.route) ? known.routes : [...known.routes, h.route],
      });
      return;
    }
    const heapNow = await sampleHeap(sessions.page, 1_000);
    if (heapNow !== null) h = { ...h, heapBytes: heapNow.usedBytes };
    h = { ...h, host: await probeHost() };
    const recordingStepIndex = Math.max(0, recorder.stepCount - 1);
    const partial = recorder.tryFinish({ intent: "adversarial" });
    const reproduction: HangReproduction =
      params.openFreshSession === undefined || !partial.ok
        ? NOT_REPLAYED
        : await reproduceHang({
            recording: partial.recording,
            recordingStepIndex,
            hang: h,
            openSession: params.openFreshSession,
            ...(params.hangReplays === undefined ? {} : { attempts: params.hangReplays }),
            perceive: perceiveOpts,
          });
    const finding = hangFinding(h, transcript.entries(), recordingStepIndex, reproduction);
    const segment = segments.indexOf(recorder);
    hangs.set(
      finding.fingerprint,
      segment > 0 && partial.ok ? { ...finding, repro: { ...finding.repro, recording: partial.recording } } : finding,
    );
  };

  /**
   * Starts a NEW Recording segment at the start URL on the current session page (after a reset):
   * its findings replay from there, never through what ended the previous segment. Returns the
   * perceived start page, or why the run cannot go on (the start page hangs, or does not stay in
   * scope — e.g. the session was lost and it redirects to a login page).
   */
  const restartAtSeed = async (): Promise<
    { ok: true; snapshot: Snapshot; timing: PageTiming } | { ok: false; stop: AdversarialStop }
  > => {
    await monitorFor(sessions.page).instrument();
    safety.attach(monitorFor(sessions.page));
    recorder = new RunRecorder(site, undefined, secrets);
    segments.push(recorder);
    await Navigate.to(params.seedUrl).performAs(sessions.actor);
    recorder.navigate(params.seedUrl, now());
    const back = await perceiveNow();
    recorder.observed(back.snapshot.url, now(), back.timing);
    if (back.hang !== null) {
      await recordHang(back.hang, back.snapshot, back.timing);
      return { ok: false, stop: "hang" };
    }
    if (!inScope(back.snapshot.url)) return { ok: false, stop: "scope-unreachable" };
    return { ok: true, snapshot: back.snapshot, timing: back.timing };
  };

  /**
   * After a hang: reset to a known state — a fresh page when the mission can open one (a hung page
   * may not even navigate), else the same page — re-navigate to the start URL in a NEW Recording
   * segment, and keep hunting. Null when the mission cannot continue (an unresponsive page with no
   * way to open a fresh one, or a start page that itself hangs or leaves the scope).
   */
  const resetAfterHang = async (
    h: HangSignal,
  ): Promise<{ ok: true; snapshot: Snapshot; timing: PageTiming } | { ok: false; stop: AdversarialStop }> => {
    if (!(await sessions.reset(h))) return { ok: false, stop: "hang" };
    return restartAtSeed();
  };

  /** The run's verdict: every finding kind folded by severity (a confirmed hang dominates). */
  const verdict = (): MissionOutcome =>
    combineOutcomes([
      defects.size > 0 ? "defects-found" : "clean",
      ...[...hangs.values()].map((h) => hangOutcome(h.reproduction.status)),
    ]);

  /**
   * #150 — the verdict for a `stop: "budget"` ending: a clean, deliberate stop, so it is never
   * `clean` (the run didn't finish its work) — `inconclusive`, unless a defect was already found,
   * which still wins.
   */
  const budgetVerdict = (): MissionOutcome =>
    combineOutcomes([
      defects.size > 0 ? "defects-found" : "inconclusive",
      ...[...hangs.values()].map((h) => hangOutcome(h.reproduction.status)),
    ]);

  /**
   * The independent oracle for one step: drains the hard signals and checks the user invariants —
   * the code-level `userInvariant` and the declared spec (against the `before` snapshot armed for
   * `action`; with no action only its `never`s apply). Returns the transcript reason and the step's
   * findings, or null when nothing broke.
   */
  const adjudicate = async (action: InvariantAction | null = null): Promise<{ reason: string; findings: StepFinding[]; advisories: StepAdvisory[] } | null> => {
    const invariantResult = params.userInvariant ? await params.userInvariant(sessions.page) : { ok: true };
    const declaredResult = declared === null ? null : await declared.after(sessions.actor, armed ? action : null);
    armed = false;
    // A same-tick console/response event gets one loop tick to land before draining.
    await sessions.page.waitForTimeout(10);
    const hardSignals = collector.drain();
    const url = redactUrl(sessions.page.url());
    const route = normalizeRoute(url);
    const findings: StepFinding[] = [];
    // A console error correlated with a captured 4xx response is advisory, never a defect (#88) —
    // excluded from the defect signal pool before grouping, reported separately instead.
    const advisorySignals = hardSignals.filter(isAdvisoryConsoleError);
    const stepAdvisories = advisorySignals.map((s) => stepAdvisory(s, route, url));
    const forDefect = hardSignals.filter((s) => !isAdvisoryConsoleError(s));

    const group = groupStepSignals(forDefect);
    if (group !== null) {
      findings.push({
        fingerprint: group.fingerprint,
        related: group.related,
        kind: group.primary.kind,
        title: defectTitle(group.primary),
        route,
        url,
        signals: forDefect,
      });
    }
    if (!invariantResult.ok) {
      const reason = invariantResult.reason ?? "user invariant failed";
      const fingerprint = invariantFingerprint(url, reason);
      findings.push({
        fingerprint,
        related: [fingerprint],
        kind: "invariant",
        title: `Invariant violated on ${route}: ${messageClass(reason).slice(0, 80)}`,
        route,
        url,
        signals: [],
        invariantReason: reason,
      });
    }
    for (const v of declaredResult?.violations ?? []) {
      findings.push({
        fingerprint: v.fingerprint,
        related: [v.fingerprint],
        kind: "invariant",
        title: `Invariant "${v.id}" violated on ${v.route}`,
        route: v.route,
        url: v.url,
        signals: [],
        invariantReason: v.reason,
        invariant: v,
      });
    }
    if (findings.length === 0 && stepAdvisories.length === 0) return null;
    const reasons = [
      ...hardSignals.map((s) => s.detail),
      invariantResult.ok ? undefined : invariantResult.reason,
      ...(declaredResult?.violations ?? []).map((v) => v.reason),
    ]
      .filter((r): r is string => Boolean(r))
      .join("; ");
    const prefix = findings.length > 0 ? "defect" : "advisory";
    return { reason: `${prefix}: ${reasons}`, findings, advisories: stepAdvisories };
  };

  /**
   * Signals that land AFTER a step was adjudicated — while the next page loads and settles (a 500
   * fired by the page the action opened) — belong to that step: drained and folded into it, so a
   * late signal is never lost (not even after the last step, or before a reset).
   */
  const drainLate = async (step: number): Promise<void> => {
    const late = collector.drain();
    const advisorySignals = late.filter(isAdvisoryConsoleError);
    const forDefect = late.filter((s) => !isAdvisoryConsoleError(s));
    const group = groupStepSignals(forDefect);
    if (group === null && advisorySignals.length === 0) return;
    const url = redactUrl(sessions.page.url());
    const route = normalizeRoute(url);
    if (group !== null) {
      await fold(step, [
        {
          fingerprint: group.fingerprint,
          related: group.related,
          kind: group.primary.kind,
          title: defectTitle(group.primary),
          route,
          url,
          signals: forDefect,
        },
      ]);
    }
    if (advisorySignals.length > 0) {
      foldAdvisories(
        step,
        advisorySignals.map((s) => stepAdvisory(s, route, url)),
      );
    }
  };

  /**
   * Folds one step's advisory signals into the deduped advisory set (mirrors `fold`, but no repro
   * or triage — an advisory is reported, never a defect, so nothing here needs to be reproduced).
   */
  const foldAdvisories = (step: number, list: readonly StepAdvisory[]): void => {
    for (const a of list) {
      const known = advisories.get(a.fingerprint);
      if (known !== undefined) {
        if (!known.occurrenceSteps.includes(step)) known.occurrenceSteps.push(step);
        continue;
      }
      advisories.set(a.fingerprint, { ...a, firstSeenStep: step, occurrenceSteps: [step] });
    }
  };

  /**
   * Folds one step's findings into the deduped defect set — called AFTER the step is in the
   * transcript, so a new defect's repro includes the step that surfaced it. A known fingerprint
   * (or one seen in a known defect's cascade) only counts an occurrence.
   */
  const fold = async (step: number, findings: readonly StepFinding[]): Promise<void> => {
    for (const f of findings) {
      const known = [...defects.values()].find((d) => d.fingerprint === f.fingerprint || d.related.has(f.fingerprint));
      if (known !== undefined) {
        if (!known.occurrenceSteps.includes(step)) known.occurrenceSteps.push(step);
        for (const r of f.related) known.related.add(r);
        continue;
      }
      // Guardrail #3: the generation call receives only the redacted hard-signal details (never
      // raw form state) + the URL. A triage failure is data (`unavailable`), never a lost defect.
      const summary =
        f.kind === "invariant" ? (f.invariantReason ?? f.title) : f.signals.map((s) => s.detail).join("; ");
      const triage = await tryTriage(params.generation, { failureSummary: summary, url: f.url });
      defects.set(f.fingerprint, {
        ...f,
        related: new Set(f.related),
        epoch: segments.indexOf(recorder),
        firstSeenStep: step,
        occurrenceSteps: [step],
        // The repro is the ordered steps; their timing stays in the run transcript (not copied per defect).
        repro: {
          steps: transcript.entries().map((e): TranscriptEntry => {
            const { timing: _timing, ...step } = e;
            return step;
          }),
          recordingStepIndex: Math.max(0, recorder.stepCount - 1),
        },
        triage,
      });
    }
  };

  try {
    // The page monitor observes network + DOM from BEFORE the first navigation (the settle rule).
    await monitorFor(sessions.page).instrument();
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
      await Navigate.to(params.seedUrl).performAs(sessions.actor);
    } catch (e) {
      const message = e instanceof Error ? (e.message.split("\n")[0] ?? e.message) : String(e);
      if (!isUnreachableTarget(message) && !isUnreachableTarget(firstNavNetError ?? "")) throw e;
      // The seed itself could not be loaded: never a defect in the app, never a bug in jevitate —
      // a configuration problem. `inconclusive`, never `crashed`; no crash report/issue drafted.
      return finish("inconclusive", "scope-unreachable", {
        kind: "target-unreachable",
        message: `target unreachable (${describeUnreachable(message, firstNavNetError)})`,
      });
    } finally {
      sessions.page.off("requestfailed", onFirstNavRequestFailed);
    }
    recorder.navigate(params.seedUrl, now());
    const started = now();

    const seed = await perceiveNow();
    if (seed.hang !== null) {
      await recordHang(seed.hang, seed.snapshot, seed.timing);
      return finish(verdict(), "hang");
    }
    if (!seed.rendered) {
      // Nothing to misuse: the run proves nothing (fail closed on meaning — never `clean`).
      transcript.record({
        op: null,
        control: null,
        confidence: null,
        chosenBy: "strategy",
        strategy: "seed-load",
        actOk: false,
        reason: `${seed.reason ?? "page did not render"} (inconclusive)`,
        snapshot: seed.snapshot,
        timing: seed.timing,
      });
      return finish("inconclusive", "not-rendered", {
        kind: "exception",
        message: seed.reason ?? "seed page did not render",
      });
    }
    // The seed redirected to a login-like page — most often a lost/expired `--storage-state`
    // session (#82). Checked BEFORE the general scope check below (which already catches ANY
    // out-of-scope landing) so THIS specific, actionable cause gets its own reason; every other
    // departure keeps the existing generic "left the target scope" message unchanged.
    const redirect = seedRedirectReason(params.seedUrl, seed.snapshot.url);
    if (redirect !== null && redirect.loginLike) {
      transcript.record({
        op: null,
        control: null,
        confidence: null,
        chosenBy: "strategy",
        strategy: "seed-load",
        actOk: false,
        reason: `${redirect.reason} (inconclusive)`,
        snapshot: seed.snapshot,
        timing: seed.timing,
      });
      return finish("inconclusive", "scope-unreachable", { kind: "target-unreachable", message: redirect.reason });
    }
    if (!inScope(seed.snapshot.url)) {
      // The start URL did not stay on the target (another route, off-allowlist): the run cannot
      // test what it was asked to — it proves nothing, so it is never `clean`.
      const message = `the start URL left the target scope (landed on ${redactUrl(seed.snapshot.url)})`;
      transcript.record({
        op: null,
        control: null,
        confidence: null,
        chosenBy: "strategy",
        strategy: "seed-load",
        actOk: false,
        reason: `${message} (inconclusive)`,
        snapshot: seed.snapshot,
        timing: seed.timing,
      });
      return finish("inconclusive", "scope-unreachable", { kind: "target-unreachable", message });
    }
    let snap = seed.snapshot;
    // A perception's timing is reported ONCE — on the first step decided on it — so a run whose
    // strategies found nothing to do on a page does not count that page's load several times.
    let snapTiming: PageTiming | undefined = seed.timing;
    recorder.observed(snap.url, now(), seed.timing);

    // Step 1 is the seed load itself: an AMBIENT defect (a 5xx fired while the page loads, before
    // any misuse) is attributed to loading the page, and its repro is just the navigation.
    {
      const verdict = await adjudicate();
      const step = transcript.nextStep;
      transcript.record({
        op: null,
        control: null,
        confidence: null,
        chosenBy: "strategy",
        strategy: "seed-load",
        actOk: true,
        reason: verdict === null ? "seed page loaded" : verdict.reason,
        snapshot: snap,
        timing: seed.timing,
      });
      snapTiming = undefined;
      if (verdict !== null) {
        await fold(step, verdict.findings);
        foldAdvisories(step, verdict.advisories);
      }
    }

    // #150 — a budget's baseline is read once, on the seed's settled snapshot, before any action.
    // An unreadable baseline fails closed by default (`onUnreadable: "stop"`). A defect found on the
    // seed load itself (just above) still wins over the budget stop.
    if (budget !== null) {
      const b = await budget.baseline(sessions.page);
      if (b.crossed) {
        transcript.record({
          op: null,
          control: null,
          confidence: null,
          chosenBy: "strategy",
          strategy: "budget",
          actOk: false,
          reason: b.reason ?? "budget observable unreadable at run start",
          snapshot: snap,
        });
        return finish(budgetVerdict(), "budget");
      }
    }

    let last: LastAction | null = null;
    let lastRecordedTarget: string | null = null;
    let actions = 0;
    let strategySteps = 0;
    let idleStreak = 0;
    const visitedLinks = new Set<string>();
    /** How many episodes each strategy has run (rotates its form, field and value). */
    const rounds = new Map<MisuseStrategy, number>();
    let stop: AdversarialStop | null = null;

    /**
     * SOFT augment only (guardrail #4). Jev's "looks broken?" is consulted and recorded in the
     * transcript — it is never read into the defect decision. Wiring this answer into the defect
     * condition would be the single most dangerous regression this mission can suffer. The state is
     * redacted and carries the prompt-injection guard like every other prompt. It is advisory, so an
     * unavailable judgment is recorded and the run goes on.
     */
    const softJudgment = async (
      on: Snapshot,
    ): Promise<{ judgments?: Record<string, TranscriptJudgment>; note?: string }> => {
      try {
        const answers = await params.judgment.systemOne({
          state: buildJudgmentState({
            goal: "try to break it",
            url: sessions.page.url(),
            controls: [PROMPT_INJECTION_GUARD, ...on.controls.map((c) => c.summary)],
            history: [],
          }),
          questions: { looksBroken: { kind: "noul" } },
        });
        const looksBroken = answers.looksBroken;
        return looksBroken?.kind === "noul"
          ? { judgments: { looksBroken: { value: looksBroken.value, probability: looksBroken.probability } } }
          : {};
      } catch (e) {
        return { note: `advisory judgment unavailable: ${e instanceof Error ? e.message.split("\n")[0] : String(e)}` };
      }
    };

    /**
     * One planned step through the gated act(). A select with no chosen option takes another
     * option. `send` (a chat composer: #121) is given the CURRENT page's controls as its submit
     * candidates, so it finds its own nearest Send button (or falls back to Enter) exactly as the
     * goal loop's composer handling does — never a separate detected submit control to plan around.
     */
    const execute = async (s: MisuseStep, candidates: readonly Control[]): Promise<{ result: ActResult; value?: string }> => {
      if (s.op === "select" && s.control !== null && s.fillText === undefined) {
        const option = await otherOption(sessions.page, s.control);
        if (option === null) return { result: { ok: false, mutated: false, reason: "no other option to choose" } };
        return { result: await act(sessions.actor, { op: "select", control: s.control, value: option }), value: option };
      }
      const result = await act(sessions.actor, {
        op: s.op,
        control: s.control,
        value: s.fillText ?? null,
        ...(s.op === "send" ? { candidates } : {}),
      });
      return s.fillText === undefined ? { result } : { result, value: s.fillText };
    };

    /** Appends an executed step to the Recording (the defect's repro path). */
    const recordAction = (s: MisuseStep, value: string | undefined, at: number, submittedVia?: ActResult["submittedVia"]): void => {
      if (s.control === null) {
        if (s.op === "reload") {
          recorder.navigate(sessions.page.url(), at);
          lastRecordedTarget = null;
        }
        return;
      }
      if (s.op === "click") recorder.click(s.control.descriptor, at);
      else if (s.op === "type") {
        // A password field's typed value is synthetic (never a real secret), but it is still kept
        // out of the Recording — `{redacted:true}` with only its length, never the text itself.
        const v = value ?? "";
        recorder.fill(s.control.descriptor, s.redacted === true ? { redacted: true, length: v.length } : v, at);
      } else if (s.op === "select") recorder.select(s.control.descriptor, value ?? "", at);
      else if (s.op === "send") {
        recorder.fill(s.control.descriptor, value ?? "", at);
        if (submittedVia !== undefined && submittedVia.kind === "click") recorder.click(submittedVia.control.descriptor, at);
        else recorder.press("Enter", s.control.descriptor, at);
      } else return;
      lastRecordedTarget = JSON.stringify(s.control.descriptor);
    };

    /**
     * Perceives what an action produced and checks it: a hang is recorded, then the mission resets
     * to a known state and hunts on; an off-origin page sends it back to the seed. "reset" means the
     * page the episode was planned on is gone; "stop" means the mission cannot continue.
     */
    const observeAfter = async (
      step: number,
      action: string,
    ): Promise<{ kind: "ok" } | { kind: "reset" } | { kind: "stop"; stop: AdversarialStop }> => {
      const next = await perceiveNow();
      await drainLate(step);
      snap = next.snapshot;
      snapTiming = next.timing;
      const target = lastRecordedTarget;
      recorder.observed(
        snap.url,
        now(),
        next.timing,
        target === null ? undefined : { lastTargetStillPresent: snap.controls.some((c) => JSON.stringify(c.descriptor) === target) },
      );
      lastRecordedTarget = null;
      let restarted: Awaited<ReturnType<typeof restartAtSeed>>;
      if (next.hang !== null) {
        await recordHang(next.hang, next.snapshot, next.timing);
        // Keep hunting: reset to a known state (a fresh page at the start URL) and go on, within
        // budget. The hung route is not followed again (visit-route remembers it).
        restarted = await resetAfterHang(next.hang);
      } else if (!inScope(snap.url)) {
        // Scope containment (#64; guardrail #1 for another origin): the action left the target.
        // Record the departure, then reset to the start URL in a fresh page and hunt on there.
        // The step spent out of scope counts as out-of-scope, never as coverage.
        outOfScopeSteps += 1;
        const landed = redactUrl(snap.url);
        departures.push({ step, url: landed, action });
        const fresh = params.openFreshSession !== undefined;
        transcript.record({
          op: null,
          control: null,
          confidence: null,
          chosenBy: "strategy",
          strategy: "scope-reset",
          actOk: true,
          reason: `left the target scope (landed on ${landed}); reset to the start URL${fresh ? " in a fresh page" : ""}`,
          snapshot: snap,
          ...(snapTiming === undefined ? {} : { timing: snapTiming }),
        });
        snapTiming = undefined;
        await sessions.fresh();
        restarted = await restartAtSeed();
      } else {
        return { kind: "ok" };
      }
      last = null;
      if (!restarted.ok) return { kind: "stop", stop: restarted.stop };
      snap = restarted.snapshot;
      snapTiming = restarted.timing;
      return { kind: "reset" };
    };

    while (stop === null) {
      if (strategySteps >= bounds.maxDecisions) {
        stop = "step-budget";
        break;
      }
      if (actions >= bounds.maxActions) {
        stop = "action-budget";
        break;
      }
      if (now() - started >= timeBudgetMs) {
        stop = "time-budget";
        break;
      }
      const strategy = params.strategies[strategySteps % params.strategies.length];
      if (strategy === undefined) throw new Error("adversarial: strategy index out of range");
      strategySteps += 1;
      const round = rounds.get(strategy) ?? 0;
      // A snapshot armed by an episode that ended without an adjudication (budget, disabled target)
      // is stale: the next action gets a fresh one, so no effect is attributed to the wrong action.
      armed = false;

      // A perception's timing is reported once — on the first step decided on it.
      let stepSnap = snap;
      let stepTiming = snapTiming;
      snapTiming = undefined;
      cov.observe(snap);
      const episode = planMisuseEpisode({
        snapshot: snap,
        strategy,
        round,
        last,
        visitedLinks,
        exercised: cov.exercisedKeys,
        inScope,
        rng: Math.random,
      });

      cov.strategy(strategy, episode !== null);
      if (episode === null) {
        idleStreak += 1;
        // Independent oracle — runs EVERY step, even when a strategy chose no action: the user
        // invariant is an independent probe of live page state, and hard signals may have accrued.
        const step = transcript.nextStep;
        const verdict = await adjudicate();
        const soft = verdict === null ? await softJudgment(stepSnap) : {};
        transcript.record({
          op: null,
          control: null,
          confidence: null,
          chosenBy: "strategy",
          strategy,
          actOk: false,
          reason: verdict?.reason ?? joinReasons(["strategy found no applicable action", soft.note]),
          snapshot: stepSnap,
          ...(stepTiming === undefined ? {} : { timing: stepTiming }),
          ...(soft.judgments === undefined ? {} : { judgments: soft.judgments }),
        });
        if (verdict !== null) {
          await fold(step, verdict.findings);
          foldAdvisories(step, verdict.advisories);
        }
        // A whole cycle of strategies found nothing to do on this page: there is nothing left.
        if (idleStreak >= params.strategies.length) stop = "strategies-exhausted";
        continue;
      }
      idleStreak = 0;
      rounds.set(strategy, round + 1);

      for (const s of episode.steps) {
        if (actions >= bounds.maxActions) break;
        // A click on a control that is disabled RIGHT NOW is never attempted: it can never mutate
        // anything, so it is a no-op, not an action — counted against no budget, and the episode
        // moves on rather than spending its remaining steps (and the next loop turn's strategy pick)
        // on a target that cannot be clicked. Checked live (not from the planning snapshot), because
        // an earlier step in THIS episode may just have made it enabled (e.g. filling the last
        // required field) — the same live truth `act()`'s own gate re-checks right before clicking.
        if (s.op === "click" && s.control !== null && (await isDisabledNow(sessions.page, s.control))) {
          transcript.record({
            op: null,
            control: s.control,
            confidence: null,
            chosenBy: "strategy",
            strategy,
            actOk: false,
            reason: joinReasons([s.note, "target disabled — no-op, choosing another action"]),
            snapshot: stepSnap,
            ...(stepTiming === undefined ? {} : { timing: stepTiming }),
          });
          stepTiming = undefined;
          break;
        }
        // The shared safety policy (#116): a paid / session-ending / destructive / --deny'd control is
        // never clicked — a no-op like a disabled target, counted against no budget.
        const unsafe = safety.gate(s.op, s.control);
        if (unsafe !== null) {
          transcript.record({
            op: null,
            control: s.control,
            confidence: null,
            chosenBy: "strategy",
            strategy,
            actOk: false,
            reason: joinReasons([s.note, unsafe.reason]),
            snapshot: stepSnap,
            ...(stepTiming === undefined ? {} : { timing: stepTiming }),
          });
          stepTiming = undefined;
          break;
        }
        // #150 — mission spend budget, pre-action: a paid control (#116) whose declared cost estimate
        // would cross what remains of the budget is refused BEFORE it fires — code decides, never a
        // model routing around it. The run stops cleanly, with `stop: "budget"`.
        if (budget !== null) {
          const risk = s.control === null ? null : safety.policy.riskOf(s.control);
          const g = await budget.guard(sessions.page, { op: s.op, control: s.control?.name ?? s.op, paid: risk === "paid" });
          if (g.refuse) {
            transcript.record({
              op: null,
              control: s.control,
              confidence: null,
              chosenBy: "strategy",
              strategy,
              actOk: false,
              reason: joinReasons([s.note, g.reason]),
              snapshot: stepSnap,
              ...(stepTiming === undefined ? {} : { timing: stepTiming }),
            });
            stepTiming = undefined;
            stop = "budget";
            break;
          }
        }
        // Declared invariants (#86): snapshot BEFORE the action(s) the next adjudication judges.
        const actedOn = sessions.page.url();
        if (declared !== null && !armed) {
          await declared.before(sessions.actor);
          armed = true;
        }
        const at = now();
        safety.mark(transcript.nextStep, s.op, s.control);
        const { result, value } = await execute(s, stepSnap.controls);
        actions += 1;
        if (result.ok) recordAction(s, value, at, result.submittedVia);
        if (result.ok) cov.acted(stepSnap.url, s.control, s.submitsForm);
        if (strategy === "visit-route" && s.control !== null) visitedLinks.add(s.control.name);
        last = { op: s.op, control: s.control, ...(value === undefined ? {} : { fillText: value }) };
        // Evidence for "act while the submit is pending": how many requests the action left in flight.
        const inFlight = !s.settle && result.ok ? monitorFor(sessions.page).pending().length : 0;
        const reason = joinReasons([
          s.note,
          result.ok ? result.note : result.reason,
          inFlight > 0 ? `${inFlight} request(s) in flight` : undefined,
        ]);
        const entry = {
          op: s.op,
          control: s.control,
          confidence: null,
          chosenBy: "strategy" as const,
          strategy,
          actOk: result.ok,
          snapshot: stepSnap,
          ...(stepTiming === undefined ? {} : { timing: stepTiming }),
          ...(s.redacted === true ? { redacted: true } : {}),
        };
        stepTiming = undefined;
        const step = transcript.nextStep;
        if (!s.settle) {
          // The next step fires at once, without waiting for this one to settle (that is the misuse).
          transcript.record({ ...entry, ...(reason === undefined ? {} : { reason }) });
          continue;
        }
        const verdict = await adjudicate({ op: s.op, control: s.control?.name ?? null, url: actedOn });
        const soft = verdict === null ? await softJudgment(stepSnap) : {};
        const full = verdict === null ? joinReasons([reason, soft.note]) : joinReasons([reason, verdict.reason]);
        transcript.record({
          ...entry,
          ...(full === undefined ? {} : { reason: full }),
          ...(soft.judgments === undefined ? {} : { judgments: soft.judgments }),
        });
        if (verdict !== null) {
          await fold(step, verdict.findings);
          foldAdvisories(step, verdict.advisories);
        }
        const after = await observeAfter(step, s.control?.name ?? s.op);
        if (after.kind === "stop") {
          stop = after.stop;
          break;
        }
        // The rest of the episode was planned for a page that is gone.
        if (after.kind === "reset") break;
        // #150 — post-settle: a crossed budget stops the mission cleanly, before its next action.
        if (budget !== null) {
          const b = await budget.afterSettle(sessions.page, step);
          if (b.crossed) {
            transcript.record({
              op: null,
              control: null,
              confidence: null,
              chosenBy: "strategy",
              strategy: "budget",
              actOk: true,
              reason: b.reason ?? "mission budget crossed",
              snapshot: snap,
            });
            stop = "budget";
            break;
          }
        }
        stepSnap = snap;
        stepTiming = snapTiming;
        snapTiming = undefined;
      }
    }

    // Anything that arrived after the last adjudication still counts.
    await drainLate(Math.max(1, transcript.nextStep - 1));
    return finish(stop === "budget" ? budgetVerdict() : verdict(), stop);
  } catch (e) {
    crashHost = await probeHost();
    return finish("crashed", "crashed", describeFailure(e, crashWatch.signals()));
  } finally {
    await sessions.closeOwned();
  }
}

/** Joins the non-empty parts of a transcript reason; undefined when there are none. */
function joinReasons(parts: ReadonlyArray<string | undefined>): string | undefined {
  const kept = parts.filter((p): p is string => p !== undefined && p !== "");
  return kept.length === 0 ? undefined : kept.join("; ");
}

/**
 * A cheap, read-only LIVE check (never `act()`'s own gate — that one is a different agent's to
 * change): resolves the control right now and reports whether it is currently disabled. False on
 * anything else (not unique, detached, vanished) — that is `act()`'s gate's call to make, not
 * this one's; this check only ever exists to SKIP an attempt it already knows is doomed.
 */
async function isDisabledNow(page: Page, control: Control): Promise<boolean> {
  try {
    const locator = descriptorToLocator(page, control.descriptor);
    if ((await locator.count()) !== 1) return false;
    return !(await locator.isEnabled());
  } catch {
    return false;
  }
}

/** A native select's first enabled option other than the current one (null: none, or not a select). */
async function otherOption(page: Page, control: Control): Promise<string | null> {
  try {
    return await descriptorToLocator(page, control.descriptor).evaluate((el) => {
      if (!(el instanceof HTMLSelectElement)) return null;
      const other = Array.from(el.options).find((o) => !o.disabled && o.value !== el.value);
      return other === undefined ? null : other.value;
    });
  } catch {
    return null;
  }
}
