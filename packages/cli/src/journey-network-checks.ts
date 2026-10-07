/**
 * A Journey's outcome checks, judged over its replay (#322, #400): the end state
 * (`metadata.endState`, plus an older Journey's `metadata.networkChecks`) after the last step, and
 * each step's `expectRequests` over the requests sent from the moment that step began. The SAME
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
import { evaluateNetworkCheck, evaluateOutcomeChecks, monitorFor, type RequestCapture, type SuccessCheckResult } from "@jevitate/explore";

/** How long the network may take to go idle after the last step before the checks read it. */
const SETTLE_CEILING_MS = 5_000;

/** One step's request expectations and the capture started when it began. */
interface StepWindow {
  readonly index: number;
  readonly label: string;
  readonly checks: readonly NetworkCheck[];
  capture?: RequestCapture;
  /** When the step began (the page monitor's clock): a request started earlier is not the step's. */
  startedAt?: number;
}

export class JourneyOutcomeChecks {
  readonly #page: Page;
  readonly #end;
  readonly #steps: StepWindow[];
  readonly #secrets: readonly string[];

  /** `journey` undefined (an anchored prefix run): nothing is judged. */
  constructor(page: Page, journey: Journey | undefined, opts: { readonly secrets?: readonly string[] } = {}) {
    this.#page = page;
    this.#secrets = opts.secrets ?? [];
    this.#end = journey === undefined ? [] : journeyEndState(journey);
    this.#steps = [];
    let i = 0;
    for (const p of journey?.recording.pages ?? []) {
      for (const r of p.steps) {
        if ((r.expectRequests ?? []).length > 0) this.#steps.push({ index: i, label: describeStep(r.step), checks: r.expectRequests ?? [] });
        i += 1;
      }
    }
  }

  get active(): boolean {
    return this.#end.length > 0 || this.#steps.length > 0;
  }

  /** Starts a step's request window as it begins (never changes the replay). */
  observer(): StepObserver | undefined {
    if (this.#steps.length === 0) return undefined;
    return {
      beforeStep: async ({ index }) => {
        const w = this.#steps.find((s) => s.index === index);
        if (w === undefined || w.capture !== undefined) return;
        w.startedAt = clock.now();
        w.capture = monitorFor(this.#page).startCapture();
      },
    };
  }

  /**
   * Runs `replay` with the page's requests captured, then judges the checks. A replay that already
   * failed keeps its own reason. Without checks it just runs `replay`.
   */
  async run(actor: Actor, replay: () => Promise<JourneyRunResult>): Promise<JourneyRunResult> {
    if (!this.active) return replay();
    const monitor = monitorFor(this.#page);
    await monitor.instrument();
    if (this.#end.some((c) => (c.kind === "page" || c.kind === "reloadThen") && c.assertion.kind === "flashed")) {
      await installFlashRecorder(this.#page);
    }
    const capture = monitor.startCapture();
    let result: JourneyRunResult;
    try {
      result = await replay();
      if (result.outcome === "quarantined") return result;
      // A step's postcondition can hold before the write it triggered finished: wait for the network
      // to go idle (bounded) before reading what was sent.
      await monitor.waitSettled({ ceilingMs: SETTLE_CEILING_MS }).catch(() => undefined);
    } finally {
      monitor.stopCapture(capture);
      for (const s of this.#steps) if (s.capture !== undefined) monitor.stopCapture(s.capture);
    }
    // Step windows first (the end state's reload must not count as a step's request).
    const stepFailures = this.#steps.flatMap((s) => {
      // No window (an interpreter that reported no step boundaries): judged over the whole replay.
      const window = s.capture ?? capture;
      // A request still in flight when the step began (the previous step's write) finishes inside
      // this window: only requests SENT from the step's start count.
      const since = s.startedAt;
      const sent = window.sent().filter((r) => since === undefined || (r.startedAt !== undefined && r.startedAt >= since));
      return s.checks
        .map((c) => evaluateNetworkCheck(c, sent, window.truncated))
        .filter((r) => !r.passed)
        .map((r) => `step ${s.index + 1} (${s.label}): ${r.check} — ${r.detail}`);
    });
    let end: SuccessCheckResult[] = [];
    if (this.#end.length > 0) {
      try {
        end = await evaluateOutcomeChecks(this.#end, { actor, page: this.#page, capture, secrets: this.#secrets, settleMs: SETTLE_CEILING_MS });
      } catch (e) {
        // A check that cannot be evaluated (an unusable target) is never a pass.
        return { outcome: "quarantined", reason: `success checks could not be evaluated after the last step: ${e instanceof Error ? e.message : String(e)}` };
      }
    }
    const endFailures = end.filter((r) => !r.passed).map((r) => `${r.check} — ${r.detail}`);
    const reasons = [
      ...(stepFailures.length === 0 ? [] : [`step request check${stepFailures.length === 1 ? "" : "s"} not met: ${stepFailures.join("; ")}`]),
      ...(endFailures.length === 0 ? [] : [`success check${endFailures.length === 1 ? "" : "s"} not met after the last step: ${endFailures.join("; ")}`]),
    ];
    if (reasons.length === 0) return result;
    return { outcome: "quarantined", reason: reasons.join("; ") };
  }
}
