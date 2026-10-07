/**
 * The hunt's independent oracle (guardrail #4; #86, #88, #149, #250, #302): the verdicts, the
 * hard-signal / invariant adjudication of a step, and the fingerprint-keyed folding of its findings,
 * moved out of `runAdversarialHunt` unchanged (#232) — the same closures, installed on `ctx`.
 */

import { redactUrl } from "@jevitate/ai-core";
import { combineOutcomes, type MissionOutcome, clock } from "@jevitate/domain";
import {
  defectTitle,
  groupStepSignals,
  invariantFingerprint,
  messageClass,
  normalizeRoute,
  signalFingerprint,
} from "../../adversarial/defect-fingerprint.js";
import { isAdvisoryConsoleError, type DefectSignal } from "../../adversarial/defect-oracle.js";
import type { InvariantAction, InvariantViolation } from "../../declared-invariants.js";
import { hangOutcome } from "../../hang-repro.js";
import { tryTriage } from "../../mission-failure.js";
import { clippingSummary, detectClipping, detectOverflow, shouldCheckOverflow } from "../../overflow.js";
import { RunRecorder } from "../../record.js";
import type { TranscriptEntry } from "../../transcript.js";
import type { AdversarialMissionParams } from "../adversarial.js";
import type { HuntState } from "./context.js";
import { stepAdvisory, type EarlierSubmit, type StepAdvisory, type StepFinding } from "./helpers.js";

/** #403: how a browser reports a fetch/XHR that was aborted before it left (Chromium, Firefox, WebKit). */
const BLOCKED_FETCH_ERROR = /Failed to fetch|NetworkError when attempting to fetch|Load failed|ERR_BLOCKED_BY_CLIENT/i;

/** Installs the oracle's closures (and its fired-action log) on `ctx`. */
export function installOracle(ctx: HuntState, params: AdversarialMissionParams): void {
  /** The run's verdict: every finding kind folded by severity (a confirmed hang dominates). */
  ctx.verdict = (): MissionOutcome =>
    combineOutcomes([
      ctx.defects.size > 0 ? "defects-found" : "clean",
      ...[...ctx.hangs.values()].map((h) => hangOutcome(h.reproduction.status)),
    ]);

  /**
   * #150 — the verdict for a `stop: "budget"` ending: a clean, deliberate stop, so it is never
   * `clean` (the run didn't finish its work) — `inconclusive`, unless a defect was already found,
   * which still wins.
   */
  ctx.budgetVerdict = (): MissionOutcome =>
    combineOutcomes([
      ctx.defects.size > 0 ? "defects-found" : "inconclusive",
      ...[...ctx.hangs.values()].map((h) => hangOutcome(h.reproduction.status)),
    ]);
  /**
   * Horizontal-overflow hard signal (#149) for the CURRENT step, as a `DefectSignal` — pure DOM
   * geometry (`overflow.ts`'s `detectOverflow`), never a Jev judgment. Folded into `hardSignals`
   * alongside the console/network signals; dedup across occurrences is the same fingerprint-keyed
   * `fold()` every other hard signal already goes through.
   */
  ctx.overflowSignals = async (): Promise<DefectSignal[]> => {
    const vp = ctx.sessions.page.viewportSize();
    if (!shouldCheckOverflow(vp?.width, params.overflow?.checkOverflow ?? false)) return [];
    // #302: text cut off vertically, under the same gate — one signal per element.
    const clipped = (
      await detectClipping(ctx.sessions.page, {
        viewport: vp ?? { width: 1280, height: 720 },
        ...(params.overflow?.device === undefined ? {} : { device: params.overflow.device }),
        ...(params.overflow?.ignoreSelectors === undefined ? {} : { ignoreSelectors: params.overflow.ignoreSelectors }),
        ...(params.overflow?.secrets === undefined ? {} : { secrets: params.overflow.secrets }),
      })
    ).map((c): DefectSignal => ({
      kind: "vertical-clipping",
      detail: clippingSummary(c),
      clippedPx: c.clippedPx,
      cause: c.cause,
      route: c.route,
      url: c.url,
      descriptor: c.element.descriptor,
    }));
    const finding = await detectOverflow(ctx.sessions.page, {
      viewport: vp ?? { width: 1280, height: 720 },
      ...(params.overflow?.device === undefined ? {} : { device: params.overflow.device }),
      ...(params.overflow?.toleranceCss === undefined ? {} : { toleranceCss: params.overflow.toleranceCss }),
      ...(params.overflow?.ignoreSelectors === undefined ? {} : { ignoreSelectors: params.overflow.ignoreSelectors }),
      ...(params.overflow?.secrets === undefined ? {} : { secrets: params.overflow.secrets }),
    });
    if (finding === null) return clipped;
    const horizontal: DefectSignal = {
      kind: "horizontal-overflow",
      detail: `horizontal-overflow: ${finding.element.descriptor} overflows the ${finding.viewport.width}px viewport by ${finding.overflowPx}px at ${finding.route}`,
      overflowPx: finding.overflowPx,
      route: finding.route,
      url: finding.url,
      descriptor: finding.element.descriptor,
    };
    return [horizontal, ...clipped];
  };

  /** A declared-invariant violation (#86) as a step finding. */
  ctx.declaredFinding = (v: InvariantViolation): StepFinding => ({
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

  /**
   * The independent oracle for one step: drains the hard signals and checks the user invariants —
   * the code-level `userInvariant` and the declared spec (against the `before` snapshot armed for
   * `action`; with no action only its `never`s apply). Returns the transcript reason and the step's
   * findings, or null when nothing broke.
   */
  ctx.adjudicate = async (
    action: InvariantAction | null = null,
    opts: { readonly identitySwitched?: boolean; readonly earlierSubmit?: EarlierSubmit | null; readonly inFlight?: readonly string[]; readonly blocked?: readonly string[] } = {},
  ): Promise<{ reason: string; findings: StepFinding[]; advisories: StepAdvisory[] } | null> => {
    // #300: after an identity switch no invariant is judged — they were declared for the original
    // identity — and what the monitor observed for this action is dropped. Hard signals still count.
    const skip = opts.identitySwitched === true;
    if (skip) ctx.declared?.discardPending();
    const invariantResult: { ok: boolean; reason?: string } =
      !skip && params.userInvariant ? await params.userInvariant(ctx.sessions.page) : { ok: true };
    // An unsettled sequence's pending submit is judged as its own action now that the sequence
    // settled, against the before-snapshot armed at the sequence's start (never mid-flight).
    const earlier = opts.earlierSubmit ?? null;
    // #406: writes the step started that never ended within its settle ceiling — its invariants are inconclusive.
    const inFlight = {
      ...(opts.inFlight !== undefined && opts.inFlight.length > 0 ? { inFlight: opts.inFlight } : {}),
      // #403: a write jevitate blocked never reached the app — what it set off is not the app's outcome.
      ...(opts.blocked !== undefined && opts.blocked.length > 0 ? { blocked: opts.blocked } : {}),
    };
    const earlierResult =
      ctx.declared === null || skip || earlier === null || !ctx.armed
        ? null
        : await ctx.declared.after(ctx.sessions.actor, earlier.action, { earlier: true, inputsAsOf: earlier.inputs, ...inFlight });
    const declaredResult = ctx.declared === null || skip ? null : await ctx.declared.after(ctx.sessions.actor, ctx.armed ? action : null, inFlight);
    ctx.armed = false;
    // A same-tick console/response event gets one loop tick to land before draining.
    await clock.sleep(10);
    const drained = ctx.collector.drain();
    // #403: the page's own error for a fetch jevitate's guard aborted ("Failed to fetch") is the run's
    // refusal surfacing, never the app's defect — dropped on a step that had a write blocked.
    const hardSignals =
      opts.blocked !== undefined && opts.blocked.length > 0
        ? drained.filter((s) => !((s.kind === "page-error" || s.kind === "console-error") && BLOCKED_FETCH_ERROR.test(s.detail)))
        : drained;
    hardSignals.push(...(await ctx.overflowSignals()));
    const url = redactUrl(ctx.sessions.page.url());
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
    for (const v of earlierResult?.violations ?? []) {
      findings.push({ ...ctx.declaredFinding(v), origin: { step: earlier?.step ?? 0, recordingStepIndex: earlier?.recordingStepIndex ?? 0 } });
    }
    for (const v of declaredResult?.violations ?? []) findings.push(ctx.declaredFinding(v));
    const inconclusive = [...(earlierResult?.inconclusive ?? []), ...(declaredResult?.inconclusive ?? [])].map((i) => i.reason);
    if (findings.length === 0 && stepAdvisories.length === 0) {
      return inconclusive.length === 0 ? null : { reason: inconclusive.join("; "), findings, advisories: stepAdvisories };
    }
    const reasons = [
      ...hardSignals.map((s) => s.detail),
      invariantResult.ok ? undefined : invariantResult.reason,
      ...(earlierResult?.violations ?? []).map((v) => `${v.reason} (the submit at step ${earlier?.step ?? 0}, judged once its sequence settled)`),
      ...(declaredResult?.violations ?? []).map((v) => v.reason),
    ]
      .filter((r): r is string => Boolean(r))
      .join("; ");
    const prefix = findings.length > 0 ? "defect" : "advisory";
    return { reason: [`${prefix}: ${reasons}`, ...inconclusive].join("; "), findings, advisories: stepAdvisories };
  };

  /**
   * Signals that land AFTER a step was adjudicated — while the next page loads and settles (a 500
   * fired by the page the action opened) — belong to that step: drained and folded into it, so a
   * late signal is never lost (not even after the last step, or before a reset).
   */
  ctx.drainLate = async (step: number): Promise<void> => {
    const late = ctx.collector.drain();
    const advisorySignals = late.filter(isAdvisoryConsoleError);
    const forDefect = late.filter((s) => !isAdvisoryConsoleError(s));
    const group = groupStepSignals(forDefect);
    if (group === null && advisorySignals.length === 0) return;
    const url = redactUrl(ctx.sessions.page.url());
    const route = normalizeRoute(url);
    if (group !== null) {
      await ctx.fold(step, [
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
      ctx.foldAdvisories(
        step,
        advisorySignals.map((s) => stepAdvisory(s, route, url)),
      );
    }
  };

  /**
   * Folds one step's advisory signals into the deduped advisory set (mirrors `fold`, but no repro
   * or triage — an advisory is reported, never a defect, so nothing here needs to be reproduced).
   */
  ctx.foldAdvisories = (step: number, list: readonly StepAdvisory[]): void => {
    for (const a of list) {
      const known = ctx.advisories.get(a.fingerprint);
      if (known !== undefined) {
        if (!known.occurrenceSteps.includes(step)) known.occurrenceSteps.push(step);
        continue;
      }
      ctx.advisories.set(a.fingerprint, { ...a, firstSeenStep: step, occurrenceSteps: [step] });
    }
  };

  /**
   * #250 — when each action of the current Recording segment FIRED (wall clock, the signal
   * collector's), with its transcript step and its last Recording step index: an HTTP 5xx is
   * attributed by when its request STARTED (`PageSignalCollector.requestStartOf`), the way
   * `Http5xxOracle` attributes it for the other strategies.
   */
  ctx.fired = new WeakMap<RunRecorder, Array<{ readonly at: number; readonly step: number; readonly index: number }>>();
  ctx.markFired = (at: number, step: number): void => {
    if (ctx.recorder.stepCount === 0) return;
    const list = ctx.fired.get(ctx.recorder) ?? [];
    list.push({ at, step, index: ctx.recorder.stepCount - 1 });
    ctx.fired.set(ctx.recorder, list);
  };
  /** The action whose request an `http-5xx` finding answered; undefined when it cannot tell. */
  ctx.requestOrigin = (f: StepFinding): { readonly step: number; readonly recordingStepIndex: number } | undefined => {
    const own = f.signals.filter((x) => x.kind === "http-5xx");
    const signal = own.find((x) => signalFingerprint(x) === f.fingerprint) ?? (f.kind === "http-5xx" ? own[0] : undefined);
    const started = signal === undefined ? undefined : ctx.collector.requestStartOf(signal);
    if (started === undefined) return undefined;
    const list = ctx.fired.get(ctx.recorder) ?? [];
    let hit: (typeof list)[number] | undefined;
    for (const e of list) if (e.at <= started) hit = e;
    if (hit !== undefined) return { step: hit.step, recordingStepIndex: hit.index };
    // Started before this segment's first action: its page load (the navigation, Recording step 0).
    const first = list[0];
    return first === undefined || ctx.recorder.stepCount === 0 ? undefined : { step: Math.max(1, first.step - 1), recordingStepIndex: 0 };
  };

  /**
   * Folds one step's findings into the deduped defect set — called AFTER the step is in the
   * transcript, so a new defect's repro includes the step that surfaced it. A known fingerprint
   * (or one seen in a known defect's cascade) only counts an occurrence.
   */
  ctx.fold = async (drainedAt: number, findings: readonly StepFinding[]): Promise<void> => {
    for (const f of findings) {
      // #250: an HTTP 5xx belongs to the action whose request it answered, not to the step that
      // drained it (a submit left pending while the next step ran blamed that next step).
      const origin = f.origin ?? ctx.requestOrigin(f);
      const step = origin === undefined ? drainedAt : Math.min(drainedAt, origin.step);
      const known = [...ctx.defects.values()].find((d) => d.fingerprint === f.fingerprint || d.related.has(f.fingerprint));
      if (known !== undefined) {
        if (!known.occurrenceSteps.includes(step)) known.occurrenceSteps.push(step);
        for (const r of f.related) known.related.add(r);
        continue;
      }
      // Guardrail #3: the generation call receives only the redacted hard-signal details (never
      // raw form state) + the URL. A triage failure is data (`unavailable`), never a lost defect.
      const summary =
        f.kind === "invariant" ? (f.invariantReason ?? f.title) : f.kind === "markup-injection" ? f.title : f.signals.map((s) => s.detail).join("; ");
      const triage = await tryTriage(params.generation, { failureSummary: summary, url: f.url });
      const { origin: _origin, ...finding } = f;
      ctx.defects.set(f.fingerprint, {
        ...finding,
        related: new Set(f.related),
        epoch: ctx.segments.indexOf(ctx.recorder),
        firstSeenStep: step,
        occurrenceSteps: [step],
        // The repro is the ordered steps; their timing stays in the run transcript (not copied per defect).
        repro: {
          steps: ctx.transcript
            .entries()
            .filter((e) => e.step <= step)
            .map((e): TranscriptEntry => {
              const { timing: _timing, ...entry } = e;
              return entry;
            }),
          recordingStepIndex: origin?.recordingStepIndex ?? Math.max(0, ctx.recorder.stepCount - 1),
        },
        triage,
      });
    }
  };
}
