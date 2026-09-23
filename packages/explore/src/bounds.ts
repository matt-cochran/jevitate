/**
 * Hard bounds and no-progress detection for the exploration loop (guardrail
 * #2: bounded + fail-closed). Pure — no I/O, no clock, no page. The loop asks
 * these primitives whether it may continue; they never take an action.
 *
 * The design's defaults (spec §6 / plan Task 1): ~60 actions, ~120 decisions,
 * ≤250 retained candidates. "Actions" are executed mutations/navigations;
 * "decisions" are model round-trips (a `wait`/`blocked`/`done` decision still
 * spends a decision but not necessarily an action). Either ceiling stops the
 * run — whichever is hit first — and the run terminates as `exhausted`, never
 * by guessing one more step.
 */

export interface Bounds {
  /** Max executed mutations/navigations before the run stops as exhausted. */
  readonly maxActions: number;
  /** Max model decision round-trips before the run stops as exhausted. */
  readonly maxDecisions: number;
  /** Max interactive controls retained per snapshot; the rest are truncated
   *  and therefore un-selectable (a target Jev cannot see, it cannot pick). */
  readonly maxCandidates: number;
}

export const DEFAULT_BOUNDS: Bounds = {
  maxActions: 60,
  maxDecisions: 120,
  maxCandidates: 250,
};

/**
 * Validates a partial override into a full `Bounds`, fail-closed: every bound
 * must be a positive integer. A zero/negative/NaN ceiling would either loop
 * forever or refuse to start — both are worse than rejecting the config.
 */
export function resolveBounds(overrides?: Partial<Bounds>): Bounds {
  const merged = { ...DEFAULT_BOUNDS, ...overrides };
  for (const [k, v] of Object.entries(merged)) {
    if (!Number.isInteger(v) || v <= 0) {
      throw new Error(`Bounds.${k} must be a positive integer, got ${String(v)}`);
    }
  }
  return merged;
}

/**
 * The reason a run stopped. `done`/`blocked` come from the decision head;
 * `exhausted` comes from these bounds; `no-progress` from the detector below.
 * `inconclusive` means a required step (the model decision) stayed unavailable;
 * `crashed` means the engine failed (browser/page crash, unexpected exception) —
 * the run returns its partial transcript and Recording instead of throwing.
 * There is no "gave up and guessed" terminal — that is the point.
 */
export type StopReason = "done" | "blocked" | "exhausted" | "no-progress" | "inconclusive" | "crashed";

/**
 * A pure counter the loop increments as it spends actions and decisions.
 * `mayDecide()`/`mayAct()` are checked BEFORE spending, so the ceilings are
 * true maxima (spending the Nth is allowed; the N+1th is refused).
 */
export class BoundsTracker {
  #actions = 0;
  #decisions = 0;
  constructor(readonly bounds: Bounds) {}

  get actions(): number {
    return this.#actions;
  }
  get decisions(): number {
    return this.#decisions;
  }

  /** True while another decision round-trip is within budget. */
  mayDecide(): boolean {
    return this.#decisions < this.bounds.maxDecisions;
  }
  /** True while another executed action is within budget. */
  mayAct(): boolean {
    return this.#actions < this.bounds.maxActions;
  }

  countDecision(): void {
    this.#decisions += 1;
  }
  countAction(): void {
    this.#actions += 1;
  }
}

/**
 * Trips when the run makes N consecutive non-`wait` steps whose semantic
 * freshness signature never changes — the loop is acting but the page is not
 * moving, so continuing would only burn the budget. A `wait` step is a
 * legitimate "let async settle" and never counts toward the streak; any
 * signature change resets it.
 *
 * Pure and caller-fed: the loop passes the op it just executed and the
 * freshness signature it observed AFTER executing it. `note` returns `true`
 * the moment the streak reaches `limit`.
 */
export class NoProgressDetector {
  #streak = 0;
  #lastSignature: string | null = null;
  constructor(readonly limit = 3) {
    if (!Number.isInteger(limit) || limit <= 0) {
      throw new Error(`NoProgressDetector limit must be a positive integer, got ${String(limit)}`);
    }
  }

  get streak(): number {
    return this.#streak;
  }

  /**
   * Records one executed step. Returns `true` once `limit` consecutive
   * non-`wait` steps have left the signature unchanged.
   */
  note(op: string, signature: string): boolean {
    if (op === "wait") {
      // A wait is not "no progress" — it is the loop deliberately doing
      // nothing so the page can settle. It neither advances nor resets the
      // streak's signature baseline.
      this.#lastSignature = signature;
      return false;
    }
    if (this.#lastSignature !== null && signature === this.#lastSignature) {
      this.#streak += 1;
    } else {
      this.#streak = 0;
    }
    this.#lastSignature = signature;
    return this.#streak >= this.limit;
  }
}
