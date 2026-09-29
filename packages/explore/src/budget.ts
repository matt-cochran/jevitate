import type { Page } from "playwright";
import type { BudgetDeclaration, BudgetGuard, ObservedValue } from "@jevitate/recording";

/**
 * Mission spend budgets (#150): a cumulative cap on the change of an app-declared observable (e.g.
 * credits) from the run's baseline reading. Two hook points, mirroring #86's `InvariantMonitor`:
 *
 *  - `baseline`     — read once, at run start, before any action;
 *  - `afterSettle`  — re-read after each settled step; crossing `maxDelta` stops the mission
 *                      CLEANLY, before its next action (never folded into a "clean"/"done" run);
 *  - `guard`        — an optional PRE-action hook: refuses a paid control (#116) whose declared
 *                      cost estimate would cross what remains of the budget.
 *
 * Code enforces, the model never decides: the limit, the reads and the stop are mechanical, same as
 * a declared invariant. An observable that cannot be read fails closed by default (`onUnreadable:
 * "stop"`) — unknown spend is never treated as zero spend.
 */

/** Minimal reader a `BudgetMonitor` needs: mechanically reads one named observable (never a model). */
export interface ObservableReader {
  readObservable(page: Page, name: string): Promise<{ value: ObservedValue | null; unreadable: boolean; evidence?: string }>;
}

export interface BudgetStepEvidence {
  readonly step: number;
  readonly before: number | null;
  readonly after: number | null;
}

export interface BudgetRefusal {
  readonly step: number;
  readonly estimate: number;
}

/** One declared budget's full trajectory — the `budget` field of a mission result. */
export interface BudgetTrajectory {
  readonly observe: string;
  readonly limit: number;
  readonly baseline: number | null;
  readonly final: number | null;
  readonly delta: number | null;
  readonly perAction: BudgetStepEvidence[];
  readonly refused?: BudgetRefusal;
  /** The baseline, or a later read, could not be obtained (numeric) — see `onUnreadable`. */
  readonly unreadable?: boolean;
}

export interface BudgetSettleResult {
  readonly crossed: boolean;
  readonly reason?: string;
}

export interface BudgetGuardResult {
  readonly refuse: boolean;
  readonly reason?: string;
}

export interface BudgetActionInfo {
  readonly op: string;
  readonly control: string;
  /** Is this control flagged paid by the #116 safety policy? The guard only ever refuses a paid action. */
  readonly paid: boolean;
}

interface TrackedBudget {
  readonly decl: BudgetDeclaration;
  baseline: number | null;
  baselineUnreadable: boolean;
  current: number | null;
  lastUnreadable: boolean;
  step: number;
  readonly perAction: BudgetStepEvidence[];
  refused?: BudgetRefusal;
}

const DEFAULT_GUARD_FACTOR = 1;

/** Does `delta` cross `maxDelta`? Negative caps spend (delta must not fall below it); positive caps growth. */
function crosses(delta: number, maxDelta: number): boolean {
  return maxDelta < 0 ? delta <= maxDelta : delta >= maxDelta;
}

function onUnreadablePolicy(decl: BudgetDeclaration): "stop" | "continue" {
  return decl.onUnreadable ?? "stop";
}

export class BudgetMonitor {
  readonly #reader: ObservableReader;
  readonly #tracked: TrackedBudget[];

  constructor(declarations: readonly BudgetDeclaration[], reader: ObservableReader) {
    this.#reader = reader;
    this.#tracked = declarations.map((decl) => ({
      decl,
      baseline: null,
      baselineUnreadable: false,
      current: null,
      lastUnreadable: false,
      step: 0,
      perAction: [],
    }));
  }

  /** True when at least one budget was declared (a no-op monitor still exists, for uniform wiring). */
  get declared(): boolean {
    return this.#tracked.length > 0;
  }

  /**
   * Reads every declared observable's baseline. Called once, before the run's first action. A budget
   * whose baseline cannot be read fails closed by default (`onUnreadable: "stop"`): the run refuses
   * to make progress against a budget it cannot see.
   */
  async baseline(page: Page): Promise<BudgetSettleResult> {
    for (const t of this.#tracked) {
      const r = await this.#reader.readObservable(page, t.decl.observe);
      if (r.unreadable || typeof r.value !== "number") {
        t.baselineUnreadable = true;
        if (onUnreadablePolicy(t.decl) === "stop") {
          return { crossed: true, reason: `budget observable "${t.decl.observe}" could not be read at run start (fail closed)` };
        }
        continue;
      }
      t.baseline = r.value;
      t.current = r.value;
    }
    return { crossed: false };
  }

  /**
   * Pre-action hook: refuses a PAID action whose declared cost estimate (`guard.estimate`, scaled by
   * `guard.factor`) would cross what remains of the budget. A guard with no readable estimate refuses
   * rather than treating the missing estimate as zero cost (fail closed). Never gates a non-paid
   * action, or a budget with no `guard` declared.
   */
  async guard(page: Page, action: BudgetActionInfo): Promise<BudgetGuardResult> {
    if (!action.paid) return { refuse: false };
    for (const t of this.#tracked) {
      if (t.decl.guard === undefined) continue;
      if (t.baseline === null) continue; // an unreadable baseline already ended (or is skipped by) the run
      const est = await this.#estimate(page, t.decl.guard);
      if (est === null) {
        return {
          refuse: true,
          reason: `budget guard: no cost estimate could be read for "${action.control}" — refused (a missing estimate never counts as zero)`,
        };
      }
      const factor = t.decl.guard.factor ?? DEFAULT_GUARD_FACTOR;
      const direction = t.decl.maxDelta < 0 ? -1 : 1;
      const projected = (t.current ?? t.baseline) - t.baseline + direction * est * factor;
      if (crosses(projected, t.decl.maxDelta)) {
        t.refused = { step: t.step, estimate: est };
        return {
          refuse: true,
          reason: `budget guard: "${action.control}" (≈${est}${factor === 1 ? "" : ` × ${factor}`}) would cross "${t.decl.observe}"'s budget (maxDelta ${t.decl.maxDelta})`,
        };
      }
    }
    return { refuse: false };
  }

  /**
   * Post-settle hook: re-reads every declared observable after a settled step and checks whether its
   * cumulative delta from baseline has crossed `maxDelta`. Returns `crossed: true` the first time any
   * budget does — the caller stops the mission cleanly, before its next action.
   */
  async afterSettle(page: Page, step: number): Promise<BudgetSettleResult> {
    for (const t of this.#tracked) {
      t.step = step;
      if (t.baseline === null && !t.baselineUnreadable) continue;
      const r = await this.#reader.readObservable(page, t.decl.observe);
      if (r.unreadable || typeof r.value !== "number") {
        t.lastUnreadable = true;
        t.perAction.push({ step, before: t.current, after: null });
        if (onUnreadablePolicy(t.decl) === "stop") {
          return { crossed: true, reason: `budget observable "${t.decl.observe}" became unreadable at step ${step} (fail closed)` };
        }
        continue;
      }
      t.lastUnreadable = false;
      const before = t.current;
      t.current = r.value;
      t.perAction.push({ step, before, after: r.value });
      if (t.baseline === null) continue;
      const delta = r.value - t.baseline;
      if (crosses(delta, t.decl.maxDelta)) {
        return {
          crossed: true,
          reason: `budget "${t.decl.observe}" crossed maxDelta ${t.decl.maxDelta} (baseline ${t.baseline}, now ${r.value}, delta ${delta}) at step ${step}`,
        };
      }
    }
    return { crossed: false };
  }

  /**
   * Drain: after the loop ends (for any reason), keep re-reading declared budgets that have a
   * `settle` window, to catch a charge that lands after the last action (#150's async case). An
   * overrun seen during drain is still reported (`crossed: true`).
   */
  async drain(page: Page, step: number, sleep: (ms: number) => Promise<void> = defaultSleep): Promise<BudgetSettleResult> {
    const withSettle = this.#tracked.filter((t) => t.decl.settle !== undefined);
    if (withSettle.length === 0) return { crossed: false };
    const withinMs = Math.max(...withSettle.map((t) => t.decl.settle?.withinMs ?? 0));
    const pollMs = Math.min(...withSettle.map((t) => t.decl.settle?.pollMs ?? 1000));
    const start = Date.now();
    let result: BudgetSettleResult = { crossed: false };
    while (Date.now() - start < withinMs) {
      await sleep(Math.max(0, Math.min(pollMs, withinMs - (Date.now() - start))));
      result = await this.afterSettle(page, step);
      if (result.crossed) return result;
    }
    return result;
  }

  /** Every declared budget's trajectory so far — attached to the mission result whatever the outcome. */
  trajectory(): BudgetTrajectory[] {
    return this.#tracked.map((t) => ({
      observe: t.decl.observe,
      limit: t.decl.maxDelta,
      baseline: t.baseline,
      final: t.current,
      delta: t.baseline === null || t.current === null ? null : t.current - t.baseline,
      perAction: [...t.perAction],
      ...(t.refused === undefined ? {} : { refused: t.refused }),
      ...(t.baselineUnreadable || t.lastUnreadable ? { unreadable: true } : {}),
    }));
  }

  async #estimate(page: Page, guard: BudgetGuard): Promise<number | null> {
    if (typeof guard.estimate === "number") return guard.estimate;
    const r = await this.#reader.readObservable(page, guard.estimate);
    if (r.unreadable || typeof r.value !== "number") return null;
    return r.value;
  }
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
