/** The run state under construction (#500): every `RunContext` field writable while `createRunContext` assembles it. */
import type { RunContext } from "../context.js";

export type MutableRunContext = { -readonly [K in keyof RunContext]: RunContext[K] };

/**
 * #688 — the class a candidate control falls into for actionable-control recovery evidence. The
 * `safe` class is the only one a run may act through; every other class names the concrete reason a
 * naive action would be wrong. `hidden`, `disabled` and `ambiguous` are observed facts about the
 * control; `destructive`, `financial` and `approval` are the shared safety vocabulary's categories.
 */
export type ActionableControlKind = "safe" | "hidden" | "disabled" | "ambiguous" | "destructive" | "financial" | "approval";

/**
 * #688 — the exact identity a recovery resumes from: the page it was observed on, that page state's
 * stable signature (the same freshness identity the loop uses), and the candidate's durable locator.
 * Resuming never guesses: all three must match, or the evidence is stale.
 */
export interface ActionableControlResume {
  /** The page URL the control was observed on. */
  readonly url: string;
  /** The page state's stable freshness signature at observation time. */
  readonly state: string;
  /** The candidate control's durable locator. */
  readonly locator: string;
}

/**
 * #688 — typed, observation-only evidence about one candidate control the run could recover through.
 * It carries how to find the control (`locator`), what it looked like (`screenshot`), the condition
 * under which acting on it is safe (`predicate`), and exactly where to resume (`resume`). Building
 * it never selects, clicks or otherwise executes the control.
 */
export interface ActionableControlEvidence {
  readonly kind: ActionableControlKind;
  /** The control's accessible name (may be empty). */
  readonly name: string;
  /** A durable locator for the control; never a click. */
  readonly locator: string;
  /** A PNG data URL captured for the observation, or null when the capture failed; never a click. */
  readonly screenshot: string | null;
  /** The safety predicate the control must satisfy to be a `safe` recovery; the failing clause otherwise. */
  readonly predicate: string;
  readonly resume: ActionableControlResume;
}
