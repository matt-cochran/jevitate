/**
 * A Journey's outcome checks, judged over its replay (#322, #400): the end state
 * (`metadata.endState`, plus an older Journey's `metadata.networkChecks`) after the last step, and
 * each step's `expectRequests` over the requests THAT step sent (#526: from the moment it began until
 * it ended — a later step's request to the same endpoint is never the step's), judged as the step
 * ends, once its own requests were answered (bounded), so the next step (a navigation) cannot
 * abandon a write before its response is seen. The SAME
 * evaluator a live goal mission's verdict uses (`evaluateOutcomeChecks`: page checks on the final
 * page, one reload for the `reloadThen` checks, network checks over the page-monitor capture). A
 * replay whose steps all passed but whose outcome is absent is a failed run, never `ok`.
 */
import type { Page } from "playwright";
import { journeyEndState, type Journey } from "@jevitate/journey";
import type { NetworkCheck } from "@jevitate/recording";
import type { JourneyRunResult } from "@jevitate/runtime";
import type { Actor } from "@jevitate/screenplay";
import { installFlashRecorder, type StepObserver } from "@jevitate/interpreter";
import { describeStep } from "@jevitate/journey";
import { clock } from "@jevitate/domain";
import { DEFAULT_STEP_RESPONSE_TIMEOUT_MS, evaluateNetworkCheckAwaiting, evaluateOutcomeChecks, type SlowStepFinding, monitorFor, type RequestCapture, type SuccessCheckResult } from "@jevitate/explore";

/** #486/L2: the largest `--step-response-timeout` / `stepResponseTimeoutMs` accepted (5 minutes): a step never waits longer. */
export const MAX_STEP_RESPONSE_TIMEOUT_MS = 300_000;

/** How long the network may take to go idle after the last step before the checks read it. */
const SETTLE_CEILING_MS = 5_000;

/**
 * #402: one failed assertion site from the last `run`, as structured data. The same sites the joined
 * `reason` string names, so a mutation proof can see WHICH expectation a mutation broke.
 *
 * `step` is 1-based (`s.index + 1`); `checkIndex` is the check's position in that step's
 * `expectRequests`. `index` is the position in the end-state list the class was constructed with —
 * `journeyEndState(journey)` order: `metadata.endState` first, then a legacy `metadata.networkChecks`.
 */
export type OutcomeCheckFailure =
  | { readonly where: "step-request"; readonly step: number; readonly checkIndex: number; readonly detail: string }
  | { readonly where: "end-state"; readonly index: number; readonly detail: string }
  | { readonly where: "unevaluable"; readonly detail: string };

/** #486: an advisory `slow-step` finding — a step's response was late but 2xx (never a quarantine). */
export interface SlowStep extends SlowStepFinding {
  /** 1-based step number. */
  readonly step: number;
}

/** One step's request expectations and the capture started when it began. */
interface StepWindow {
  readonly index: number;
  readonly label: string;
  readonly checks: readonly NetworkCheck[];
  /** #486: the step's own response bound (ms), when it sets one. */
  readonly responseTimeoutMs?: number;
  capture?: RequestCapture;
  /** When the step began (the page monitor's clock): a request started earlier is not the step's. */
  startedAt?: number;
  /** #526: when the step's window closed (it ended, or the next step began): a request started later is not the step's. */
  until?: number;
  /** #526: the step's checks, judged as it ended (absent when no step end was reported). */
  judged?: readonly JudgedCheck[];
}

/** #526: one check of a step, judged as the step ended. */
interface JudgedCheck {
  readonly result: SuccessCheckResult;
  readonly slowStep?: SlowStepFinding;
}

export class JourneyOutcomeChecks {
  readonly #page: Page;
  readonly #end;
  readonly #steps: StepWindow[];
  readonly #secrets: readonly string[];
  readonly #responseTimeoutMs: number;
  #lastFailures: readonly OutcomeCheckFailure[] = [];
  #slowSteps: SlowStep[] = [];

  /** `journey` undefined (an anchored prefix run): nothing is judged. */
  constructor(page: Page, journey: Journey | undefined, opts: { readonly secrets?: readonly string[]; readonly stepResponseTimeoutMs?: number } = {}) {
    this.#page = page;
    this.#responseTimeoutMs = opts.stepResponseTimeoutMs ?? DEFAULT_STEP_RESPONSE_TIMEOUT_MS;
    this.#secrets = opts.secrets ?? [];
    this.#end = journey === undefined ? [] : journeyEndState(journey);
    this.#steps = [];
    let i = 0;
    for (const p of journey?.recording.pages ?? []) {
      for (const r of p.steps) {
        if ((r.expectRequests ?? []).length > 0) this.#steps.push({ index: i, label: describeStep(r.step), checks: r.expectRequests ?? [], ...(r.responseTimeoutMs === undefined ? {} : { responseTimeoutMs: r.responseTimeoutMs }) });
        i += 1;
      }
    }
  }

  get active(): boolean {
    return this.#end.length > 0 || this.#steps.length > 0;
  }

  /** #486: advisory `slow-step` findings of the last `run` (empty when every response came promptly). */
  get slowSteps(): readonly SlowStep[] {
    return this.#slowSteps;
  }

  /** #402: the failed assertion sites of the last `run` (empty when every check held, or none ran). */
  get lastFailures(): readonly OutcomeCheckFailure[] {
    return this.#lastFailures;
  }

  /**
   * Starts a step's request window as it begins (never changes the replay). #453: the window
   * RESTARTS each time the step runs again — a failed original attempt or a rejected heal probe's
   * requests never satisfy the expectations of the attempt that finally passed.
   *
   * #526: the window CLOSES when the step ends. Its checks are judged then, over the requests it
   * sent: after the network settled (bounded) and, for a request still awaiting its response, after
   * that response (bounded by the step's response timeout, #486) — before the next step acts, so a
   * following navigation or write can neither abandon the step's request nor be counted for it.
   */
  observer(): StepObserver | undefined {
    if (this.#steps.length === 0) return undefined;
    return {
      beforeStep: async ({ index }) => {
        const now = clock.now();
        // A window still open (its step reported no end) closes as the next step begins.
        for (const s of this.#steps) if (s.index !== index && s.startedAt !== undefined && s.until === undefined) s.until = now;
        const w = this.#steps.find((s) => s.index === index);
        if (w === undefined) return;
        const monitor = monitorFor(this.#page);
        if (w.capture !== undefined) monitor.stopCapture(w.capture);
        w.startedAt = now;
        delete w.until;
        delete w.judged;
        w.capture = monitor.startCapture();
      },
      afterStep: async ({ index, outcome }) => {
        const w = this.#steps.find((s) => s.index === index);
        if (w?.capture === undefined || outcome !== "done") return;
        // A step's write can be sent a moment after its action (a lazily loaded handler): let it go out.
        await monitorFor(this.#page).waitSettled({ ceilingMs: SETTLE_CEILING_MS }).catch(() => undefined);
        w.until = clock.now();
        w.judged = await this.#judge(w);
      },
    };
  }

  /** The step's checks over the requests it sent in its window (the capture stays live for their responses). */
  async #judge(s: StepWindow, fallback?: RequestCapture): Promise<JudgedCheck[]> {
    const window = s.capture ?? fallback;
    if (window === undefined) return [];
    const since = s.startedAt;
    const until = s.until;
    const out: JudgedCheck[] = [];
    for (const c of s.checks) {
      // #486: a request still awaiting its response (a cold start) is waited for, up to the bound.
      out.push(
        await evaluateNetworkCheckAwaiting(
          c,
          () => ({
            requests: window
              .sent()
              .filter((q) => (since === undefined || (q.startedAt !== undefined && q.startedAt >= since)) && (until === undefined || (q.startedAt !== undefined && q.startedAt <= until))),
            truncated: window.truncated,
          }),
          s.responseTimeoutMs ?? this.#responseTimeoutMs,
        ),
      );
    }
    return out;
  }

  #stopCaptures(monitor: ReturnType<typeof monitorFor>, capture: RequestCapture): void {
    monitor.stopCapture(capture);
    for (const s of this.#steps) if (s.capture !== undefined) monitor.stopCapture(s.capture);
  }

  /**
   * Runs `replay` with the page's requests captured, then judges the checks. A replay that already
   * failed keeps its own reason. Without checks it just runs `replay`.
   */
  async run(actor: Actor, replay: () => Promise<JourneyRunResult>): Promise<JourneyRunResult> {
    this.#lastFailures = [];
    this.#slowSteps = [];
    if (!this.active) return replay();
    // A step's window and verdict belong to one run.
    for (const s of this.#steps) {
      if (s.capture !== undefined) monitorFor(this.#page).stopCapture(s.capture);
      delete s.capture;
      delete s.startedAt;
      delete s.until;
      delete s.judged;
    }
    const monitor = monitorFor(this.#page);
    await monitor.instrument();
    if (this.#end.some((c) => (c.kind === "page" || c.kind === "reloadThen") && c.assertion.kind === "flashed")) {
      await installFlashRecorder(this.#page);
    }
    const capture = monitor.startCapture();
    let result: JourneyRunResult;
    try {
      result = await replay();
      if (result.outcome === "quarantined" || result.outcome === "heal-exhausted") {
        this.#stopCaptures(monitor, capture);
        return result;
      }
      // A step's postcondition can hold before the write it triggered finished: wait for the network
      // to go idle (bounded) before reading what was sent.
      await monitor.waitSettled({ ceilingMs: SETTLE_CEILING_MS }).catch(() => undefined);
    } catch (e) {
      this.#stopCaptures(monitor, capture);
      throw e;
    }
    // Step windows first (the end state's reload must not count as a step's request).
    const stepFailureSites: OutcomeCheckFailure[] = [];
    const stepFailureReasons: string[] = [];
    for (const s of this.#steps) {
      // Judged as the step ended (#526); else now — over the whole replay when the interpreter
      // reported no step boundaries. A request in flight when the step began (the previous step's
      // write) finishes inside its window: only requests SENT within the window count.
      const judged = s.judged ?? (await this.#judge(s, capture));
      for (const [checkIndex, { result: r, slowStep }] of judged.entries()) {
        if (slowStep !== undefined) this.#slowSteps.push({ ...slowStep, step: s.index + 1 });
        if (r.passed) continue;
        stepFailureSites.push({ where: "step-request", step: s.index + 1, checkIndex, detail: `${r.check} — ${r.detail}` });
        stepFailureReasons.push(`step ${s.index + 1} (${s.label}): ${r.check} — ${r.detail}`);
      }
    }
    // The captures stay live through the waits above (#486): a pending request's response lands in them.
    this.#stopCaptures(monitor, capture);
    let end: SuccessCheckResult[] = [];
    if (this.#end.length > 0) {
      try {
        end = await evaluateOutcomeChecks(this.#end, { actor, page: this.#page, capture, secrets: this.#secrets, settleMs: SETTLE_CEILING_MS });
      } catch (e) {
        // A check that cannot be evaluated (an unusable target) is never a pass.
        const detail = `success checks could not be evaluated after the last step: ${e instanceof Error ? e.message : String(e)}`;
        this.#lastFailures = [{ where: "unevaluable", detail }];
        return { outcome: "quarantined", reason: detail };
      }
    }
    // `evaluateOutcomeChecks` keeps the checks' order, which is `journeyEndState`: `endState` then
    // legacy `networkChecks` — so an index here is that list's own position.
    const endFailureSites: OutcomeCheckFailure[] = end.flatMap((r, index) =>
      r.passed ? [] : [{ where: "end-state" as const, index, detail: `${r.check} — ${r.detail}` }],
    );
    this.#lastFailures = [...stepFailureSites, ...endFailureSites];
    const endFailures = endFailureSites.map((f) => f.detail);
    const reasons = [
      ...(stepFailureReasons.length === 0 ? [] : [`step request check${stepFailureReasons.length === 1 ? "" : "s"} not met: ${stepFailureReasons.join("; ")}`]),
      ...(endFailures.length === 0 ? [] : [`success check${endFailures.length === 1 ? "" : "s"} not met after the last step: ${endFailures.join("; ")}`]),
    ];
    if (reasons.length === 0) return result;
    // #453: a healed run whose end state does not hold proposes nothing — it is a failure.
    if (result.outcome === "healed-pending-review") {
      return { outcome: "quarantined", reason: `the healed run's end state differs from the Journey's assertions: ${reasons.join("; ")}`, ...(result.heal === undefined ? {} : { heal: result.heal }) };
    }
    return { outcome: "quarantined", reason: reasons.join("; ") };
  }
}
