/**
 * Loop-cycle detection (#367) — independent code, never the model.
 *
 * The no-progress detector (`NoProgressDetector`, #2/#172/#303) counts steps that left the page
 * UNCHANGED. A run that alternates between two controls changes the page on every step and is
 * never caught by it: a link to page B and its "Back" link to page A (A→B→A→B…), a disclosure
 * toggled open and shut (▾/▴), or scrolls flipping down and up between the same two positions. Each
 * step is a "change", yet the run only revisits what it has already seen and burns its whole
 * decision budget.
 *
 * This detector looks at what the run DID instead: over the last `repeats × maxPeriod` steps
 * (4 × 2 = 8 by default), when every step was one of at most `maxPeriod` actions and landed on one
 * of at most `maxPeriod` page states, the run is going round a cycle of period ≤ 2 that it has
 * repeated `repeats` times — no progress. A page state is the page signature (url, viewport,
 * control set and values), a hash of the visible text and the scroll position, so an action that
 * reveals new content, changes a value or reaches a new scroll position is not a repeat.
 *
 * What is progress (resets the window): a step that sent a write request (code's write classifier,
 * the page's background traffic excluded). Waits are not steps here (the caller skips them).
 *
 * The degenerate case — ONE action that lands on ONE state, i.e. a step that changed nothing — is
 * left to `NoProgressDetector` (it owns the last-chance turn and the `ui-no-progress` hang check).
 */

/** Cycle repetitions (a full A→B round trip counts once) before the run stops as no-progress. */
export const CYCLE_REPEATS = 4;
/** The longest cycle period detected (how many distinct actions / states a cycle may span). */
export const CYCLE_MAX_PERIOD = 2;

/** One executed step as the detector sees it. */
export interface CycleStep {
  /** The action's identity: op + target (two steps with the same `action` did the same thing). */
  readonly action: string;
  /** How the action is named in the stop reason (`click "Back"`, `scroll down`). */
  readonly label: string;
  /** The page state the step landed on (see the module doc). */
  readonly state: string;
  /** The step made progress the state cannot show: it sent a write request. */
  readonly progress: boolean;
}

/** A detected cycle: the actions it alternates between, and how often it went round. */
export interface CycleVerdict {
  /** The distinct actions of the cycle, in the order the window first took them. */
  readonly labels: readonly string[];
  /** The distinct page states the cycle visits. */
  readonly states: number;
  /** The cycle's period (distinct actions, or states when there are more of those). */
  readonly period: number;
  /** Steps the window spans. */
  readonly steps: number;
}

export class LoopCycleDetector {
  #window: CycleStep[] = [];
  constructor(
    readonly repeats = CYCLE_REPEATS,
    readonly maxPeriod = CYCLE_MAX_PERIOD,
  ) {
    if (!Number.isInteger(repeats) || repeats < 2) throw new Error(`LoopCycleDetector repeats must be an integer >= 2, got ${String(repeats)}`);
    if (!Number.isInteger(maxPeriod) || maxPeriod < 1) throw new Error(`LoopCycleDetector maxPeriod must be a positive integer, got ${String(maxPeriod)}`);
  }

  /** The steps the current window holds (since the last progress). */
  get size(): number {
    return this.#window.length;
  }

  /** Forget the window (a step made progress, or the run's situation changed). */
  reset(): void {
    this.#window = [];
  }

  /** Records one executed step; returns the cycle once the window is one, else null. */
  note(step: CycleStep): CycleVerdict | null {
    if (step.progress) {
      this.reset();
      return null;
    }
    const span = this.repeats * this.maxPeriod;
    this.#window.push(step);
    if (this.#window.length > span) this.#window.splice(0, this.#window.length - span);
    if (this.#window.length < span) return null;
    const labels = new Map<string, string>();
    const states = new Set<string>();
    for (const s of this.#window) {
      if (!labels.has(s.action)) labels.set(s.action, s.label);
      states.add(s.state);
    }
    if (labels.size > this.maxPeriod || states.size > this.maxPeriod) return null;
    // One action, one state: a step that changed nothing — NoProgressDetector's case.
    if (labels.size === 1 && states.size === 1) return null;
    return { labels: [...labels.values()], states: states.size, period: Math.max(labels.size, states.size), steps: span };
  }
}

/** The no-progress reason for a detected cycle (#367): the loop named, and why it is no progress. */
export function describeCycle(v: CycleVerdict, repeats = CYCLE_REPEATS): string {
  const loop = v.labels.length === 1 ? `${v.labels[0]!} over and over` : v.labels.join(" ↔ ");
  return `no progress: the run went round a loop — ${loop} — ${repeats} times (${v.steps} steps between the same ${v.states} page states, no request sent, nothing new on the page)`;
}
