import type { Page } from "playwright";
import type { Actor } from "@jevitate/screenplay";
import { Navigate } from "@jevitate/screenplay";
import type { Recording } from "@jevitate/recording";
import { redactUrl, type JudgmentPort, type GenerationPort } from "@jevitate/ai-core";
import { combineOutcomes, type MissionFailure, type MissionOutcome } from "@jevitate/domain";
import { assertAuthorizedExploreTarget, isAuthorizedExploreTarget } from "../authorized-targets.js";
import { resolveBounds, type Bounds } from "../bounds.js";
import type { Control, Snapshot } from "../snapshot.js";
import { perceive } from "../perceive.js";
import { monitorFor } from "../page-monitor.js";
import { summarizeTimings, type PageTiming, type TimingSummary } from "../timing.js";
import { hangFingerprint, type HangSignal } from "../hang.js";
import { MissionSessions } from "../mission-session.js";
import type { HangConfig, SettleConfig } from "../settle-config.js";
import { hangFinding, reproduceHang, type HangFinding, type HangReproduction } from "../hang-repro.js";
import type { VerifySession } from "../verify-fix.js";
import { act } from "../act.js";
import { buildJudgmentState } from "../redact.js";
import { PROMPT_INJECTION_GUARD } from "../decide.js";
import {
  TranscriptLog,
  type TranscriptEntry,
  type TranscriptJudgment,
  type TranscriptListener,
} from "../transcript.js";
import { CrashWatch, describeFailure, tryTriage, type Triage } from "../mission-failure.js";
import { HeapLog, buildCrashReport, sampleHeap, type CrashReport } from "../crash-report.js";
import type { HeapSample } from "@jevitate/domain";
import { RunRecorder, emptyRecording } from "../record.js";
import { PageSignalCollector, type DefectSignal } from "../adversarial/defect-oracle.js";
import {
  defectTitle,
  groupStepSignals,
  invariantFingerprint,
  messageClass,
  normalizeRoute,
} from "../adversarial/defect-fingerprint.js";
import { pickMisuseAction, type MisuseDecision, type MisuseStrategy } from "../adversarial/misuse.js";

/**
 * runAdversarialMission — a bounded "try to break it" run that KEEPS HUNTING.
 *
 * The mission cycles bounded misuse strategies (ordering violations,
 * repeated/rapid actions, navigation during pending async, boundary/invalid
 * inputs chosen by field semantics, contradictory actions, following links to
 * other routes) until its step, action or time budget runs out, and after EVERY
 * step asks a TRUSTED HARD-SIGNAL oracle (`PageSignalCollector`) whether the app
 * broke — a console error, an HTTP 5xx, a failed request, an unhandled page
 * exception — plus an optional user-declared invariant.
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
  readonly firstSeenStep: number;
  readonly occurrences: number;
  readonly occurrenceSteps: number[];
  readonly repro: DefectRepro;
  readonly triage: Triage;
}

/** Why the hunt ended (the mission's budget, or nothing left to try). */
export type AdversarialStop =
  | "step-budget"
  | "action-budget"
  | "time-budget"
  | "strategies-exhausted"
  | "not-rendered"
  | "hang"
  | "crashed";

/** The typed result of an adversarial run — returned for every ending, including engine failure. */
export interface AdversarialOutcome {
  readonly outcome: MissionOutcome;
  readonly stop: AdversarialStop;
  /** Distinct defects (deduped by fingerprint), in first-seen order. */
  readonly defects: AdversarialDefect[];
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
  /** An independent, user-declared invariant. `ok:false` is a HARD defect. */
  readonly userInvariant?: (page: Page) => Promise<{ ok: boolean; reason?: string }>;
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
  /**
   * Opens a FRESH browser session — used to reproduce a hang by replaying its steps. Without it a
   * hang cannot be confirmed and is reported `intermittent` (0 replays), never dropped.
   */
  readonly openFreshSession?: () => Promise<VerifySession>;
  /** How many fresh-context replays confirm a hang. Default 2. */
  readonly hangReplays?: number;
  /** Bound on the main-thread probe (ms). Default `HANG_PROBE_MS`. */
  readonly hangProbeMs?: number;
  /** A request pending longer than this (ms) is a hang. Default: the render ceiling. */
  readonly requestBoundMs?: number;
  /** The target's settle configuration (background requests, long-poll threshold). */
  readonly settle?: SettleConfig;
  /** The target's hang configuration (`ui-no-progress` ignores). */
  readonly hangs?: HangConfig;
}

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

  // The live session; after a hang the mission resets to a fresh page and keeps hunting.
  const sessions = new MissionSessions({ page: params.page, actor: params.actor }, params.openFreshSession);
  // Attach the hard-signal listeners BEFORE navigating (on every page the run works in).
  let collector = new PageSignalCollector(params.page);
  let crashWatch = new CrashWatch(params.page);
  sessions.onReset((page) => {
    collector = new PageSignalCollector(page);
    crashWatch = new CrashWatch(page);
  });
  const heap = new HeapLog();
  const secrets = params.secrets ?? [];
  // One Recording per segment: segment 0 from the seed; a new one after each reset (its findings
  // replay from that segment's start, never through the hang that ended the previous one).
  const segments: RunRecorder[] = [new RunRecorder(site, undefined, secrets, params.onRecording)];
  let recorder = segments[0] as RunRecorder;
  const transcript = new TranscriptLog(secrets, params.onTranscriptEntry);
  const defects = new Map<string, MutableDefect>();
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
    const finalFailure = failure ?? recordingFailure;
    return {
      outcome: finished.ok ? outcome : "crashed",
      stop: finished.ok ? stop : "crashed",
      defects: [...defects.values()].map((d) => freeze(d, later)),
      hangs: [...hangs.values()],
      recording: finished.ok ? finished.recording : emptyRecording(site, finished.reason),
      transcript: transcript.entries(),
      ...(finalFailure === undefined ? {} : { failure: finalFailure }),
      heap: heap.samples(),
      timing: summarizeTimings(timings),
      ...(outcome === "crashed" && finalFailure !== undefined
        ? { crash: buildCrashReport(finalFailure, crashWatch.signals(), heap.samples()) }
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
      hangs.set(known.fingerprint, {
        ...known,
        occurrences: known.occurrences + 1,
        occurrenceSteps: [...known.occurrenceSteps, step],
      });
      return;
    }
    const heapNow = await sampleHeap(sessions.page, 1_000);
    if (heapNow !== null) h = { ...h, heapBytes: heapNow.usedBytes };
    const recordingStepIndex = Math.max(0, recorder.stepCount - 1);
    const partial = recorder.tryFinish({ intent: "adversarial" });
    const reproduction: HangReproduction =
      params.openFreshSession === undefined || !partial.ok
        ? { attempts: 0, reproduced: 0, status: "intermittent", runs: [] }
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
   * After a hang: reset to a known state — a fresh page when the mission can open one (a hung page
   * may not even navigate), else the same page — re-navigate to the start URL in a NEW Recording
   * segment, and keep hunting. False when the mission cannot continue (an unresponsive page with no
   * way to open a fresh one, or a start page that itself hangs).
   */
  const resetAfterHang = async (h: HangSignal): Promise<{ snapshot: Snapshot; timing: PageTiming } | null> => {
    if (!(await sessions.reset(h))) return null;
    await monitorFor(sessions.page).instrument();
    recorder = new RunRecorder(site, undefined, secrets);
    segments.push(recorder);
    await Navigate.to(params.seedUrl).performAs(sessions.actor);
    recorder.navigate(params.seedUrl, now());
    const back = await perceiveNow();
    recorder.observed(back.snapshot.url, now(), back.timing);
    if (back.hang !== null) {
      await recordHang(back.hang, back.snapshot, back.timing);
      return null;
    }
    return { snapshot: back.snapshot, timing: back.timing };
  };

  /** The run's verdict: every finding kind folded by severity (a confirmed hang dominates). */
  const verdict = (): MissionOutcome =>
    combineOutcomes([
      defects.size > 0 ? "defects-found" : "clean",
      ...[...hangs.values()].map((h): MissionOutcome => (h.reproduction.status === "reproduced" ? "hang" : "intermittent")),
    ]);

  /**
   * The independent oracle for one step: drains the hard signals and checks the user invariant.
   * Returns the transcript reason and the step's findings, or null when nothing broke.
   */
  const adjudicate = async (): Promise<{ reason: string; findings: StepFinding[] } | null> => {
    const invariantResult = params.userInvariant ? await params.userInvariant(sessions.page) : { ok: true };
    // A same-tick console/response event gets one loop tick to land before draining.
    await sessions.page.waitForTimeout(10);
    const hardSignals = collector.drain();
    const url = redactUrl(sessions.page.url());
    const route = normalizeRoute(url);
    const findings: StepFinding[] = [];

    const group = groupStepSignals(hardSignals);
    if (group !== null) {
      findings.push({
        fingerprint: group.fingerprint,
        related: group.related,
        kind: group.primary.kind,
        title: defectTitle(group.primary),
        route,
        url,
        signals: hardSignals,
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
    if (findings.length === 0) return null;
    const reasons = [...hardSignals.map((s) => s.detail), invariantResult.ok ? undefined : invariantResult.reason]
      .filter((r): r is string => Boolean(r))
      .join("; ");
    return { reason: `defect: ${reasons}`, findings };
  };

  /**
   * Signals that land AFTER a step was adjudicated — while the next page loads and settles (a 500
   * fired by the page the action opened) — belong to that step: drained and folded into it, so a
   * late signal is never lost (not even after the last step, or before a reset).
   */
  const drainLate = async (step: number): Promise<void> => {
    const late = collector.drain();
    const group = groupStepSignals(late);
    if (group === null) return;
    const url = redactUrl(sessions.page.url());
    await fold(step, [
      {
        fingerprint: group.fingerprint,
        related: group.related,
        kind: group.primary.kind,
        title: defectTitle(group.primary),
        route: normalizeRoute(url),
        url,
        signals: late,
      },
    ]);
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
    await Navigate.to(params.seedUrl).performAs(sessions.actor);
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
      if (verdict !== null) await fold(step, verdict.findings);
    }

    let lastDecision: MisuseDecision | undefined;
    let lastRecordedTarget: string | null = null;
    let actions = 0;
    let strategySteps = 0;
    let idleStreak = 0;
    const visitedLinks = new Set<string>();
    let stop: AdversarialStop;

    for (;;) {
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

      const decidedOn = snap;
      const decidedOnTiming = snapTiming;
      snapTiming = undefined;
      const decision = pickMisuseAction({ snapshot: snap, strategy, lastDecision, rng: Math.random, visitedLinks });
      let acted = false;
      let control: Control | null = null;
      let actOk = false;
      let actReason: string | undefined = "strategy found no applicable action";
      if (decision) {
        control =
          decision.targetIndex !== undefined
            ? snap.controls.find((c) => c.index === decision.targetIndex) ?? null
            : null;
        const at = now();
        const result = await act(sessions.actor, { op: decision.op, control, value: decision.fillText ?? null });
        actions += 1;
        acted = true;
        actOk = result.ok;
        actReason = result.reason;
        if (result.ok && control !== null) {
          if (decision.op === "click") recorder.click(control.descriptor, at);
          else if (decision.op === "type") recorder.fill(control.descriptor, decision.fillText ?? "", at);
          else if (decision.op === "select") recorder.select(control.descriptor, decision.fillText ?? "", at);
          lastRecordedTarget = JSON.stringify(control.descriptor);
        }
        if (strategy === "visit-route" && control !== null) visitedLinks.add(control.name);
        lastDecision = decision;
      }
      idleStreak = decision ? 0 : idleStreak + 1;

      const step = transcript.nextStep;
      const recordStep = (extra: { reason?: string; judgments?: Record<string, TranscriptJudgment> }): void => {
        const reason = extra.reason ?? actReason;
        transcript.record({
          op: decision ? decision.op : null,
          control,
          confidence: null,
          chosenBy: "strategy",
          strategy,
          actOk,
          ...(reason === undefined ? {} : { reason }),
          snapshot: decidedOn,
          ...(decidedOnTiming === undefined ? {} : { timing: decidedOnTiming }),
          ...(extra.judgments === undefined ? {} : { judgments: extra.judgments }),
        });
      };

      // Independent oracle — runs EVERY step, even when a strategy chose no action: the user
      // invariant is an independent probe of live page state, and hard signals may have accrued.
      const verdict = await adjudicate();
      if (verdict !== null) {
        recordStep({ reason: verdict.reason });
        await fold(step, verdict.findings);
      } else {
        // SOFT augment only (guardrail #4). Jev's "looks broken?" is consulted and recorded in the
        // transcript — it is never read into the defect decision above. Wiring this answer into
        // the defect condition would be the single most dangerous regression this mission can
        // suffer. The state is redacted and carries the prompt-injection guard like every other
        // prompt. It is advisory, so an unavailable judgment is recorded and the run goes on.
        let judgments: Record<string, TranscriptJudgment> | undefined;
        let judgmentNote: string | undefined;
        try {
          const answers = await params.judgment.systemOne({
            state: buildJudgmentState({
              goal: "try to break it",
              url: sessions.page.url(),
              controls: [PROMPT_INJECTION_GUARD, ...snap.controls.map((c) => c.summary)],
              history: [],
            }),
            questions: { looksBroken: { kind: "noul" } },
          });
          const looksBroken = answers.looksBroken;
          if (looksBroken?.kind === "noul") {
            judgments = { looksBroken: { value: looksBroken.value, probability: looksBroken.probability } };
          }
        } catch (e) {
          judgmentNote = `advisory judgment unavailable: ${e instanceof Error ? e.message.split("\n")[0] : String(e)}`;
        }
        recordStep({
          ...(judgments === undefined ? {} : { judgments }),
          ...(judgmentNote === undefined
            ? {}
            : { reason: actReason === undefined ? judgmentNote : `${actReason}; ${judgmentNote}` }),
        });
      }

      if (acted) {
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
        if (next.hang !== null) {
          await recordHang(next.hang, next.snapshot, next.timing);
          // Keep hunting: reset to a known state (a fresh page at the start URL) and go on, within
          // budget. The hung route is not followed again (visit-route remembers it).
          const fresh = await resetAfterHang(next.hang);
          if (fresh === null) {
            stop = "hang";
            break;
          }
          snap = fresh.snapshot;
          snapTiming = fresh.timing;
          lastDecision = undefined;
          continue;
        }
        if (!isAuthorizedExploreTarget(snap.url, params.allowlist)) {
          // Guardrail #1: never act off an authorized origin — go back to the seed and hunt on.
          await Navigate.to(params.seedUrl).performAs(sessions.actor);
          recorder.navigate(params.seedUrl, now());
          const back = await perceiveNow();
          snap = back.snapshot;
          snapTiming = back.timing;
          recorder.observed(snap.url, now(), back.timing);
        }
      }
      if (idleStreak >= params.strategies.length) {
        // A whole cycle of strategies found nothing to do on this page: there is nothing left.
        stop = "strategies-exhausted";
        break;
      }
    }

    // Anything that arrived after the last adjudication still counts.
    await drainLate(Math.max(1, transcript.nextStep - 1));
    return finish(verdict(), stop);
  } catch (e) {
    return finish("crashed", "crashed", describeFailure(e, crashWatch.signals()));
  } finally {
    await sessions.closeOwned();
  }
}
