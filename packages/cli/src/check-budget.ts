// check-budget.ts — the suite budget meter (#231).
import { type UsageCounts } from "@jevitate/ai-core";
import type { SuiteBudget } from "./check-suite.js";
import { type BudgetReport } from "./check-types.js";

// ── budget ───────────────────────────────────────────────────────────────────

/** Why a spend is not measurable: what could not be priced. */
function unmeasurable(usage: UsageCounts | undefined): string {
  const missing = usage?.missing ?? [];
  return `${usage?.priced === "none" ? "unpriced" : "only partially priced"}${missing.length === 0 ? "" : ` — missing: ${missing.join("; ")}`}`;
}

/** The suite's total budget. Exceeding any limit fails the check (fail closed). */
export class BudgetMeter {
  readonly #limits: SuiteBudget;
  readonly #now: () => number;
  readonly #start: number;
  readonly #costKnownZero: boolean;
  #actions = 0;
  #exceeded: string | undefined;

  constructor(limits: SuiteBudget, opts: { now?: () => number; costKnownZero?: boolean } = {}) {
    this.#limits = limits;
    this.#now = opts.now ?? Date.now;
    this.#start = this.#now();
    this.#costKnownZero = opts.costKnownZero === true;
  }

  get actions(): number {
    return this.#actions;
  }

  /** Actions left (undefined: no action limit). */
  remainingActions(): number | undefined {
    return this.#limits.maxActions === undefined ? undefined : this.#limits.maxActions - this.#actions;
  }

  minutes(): number {
    return (this.#now() - this.#start) / 60_000;
  }

  /**
   * The spend so far: 0 when no model call was made (or the gateways are fakes), the FULL total
   * (Jev + generation, #163) when every call was priced, else undefined — a partial total is not a
   * measurable spend, so a `maxUsd` budget fails closed on it rather than passing on an undercount.
   */
  usd(usage: UsageCounts | undefined): number | undefined {
    if (usage === undefined || usage.judgments + usage.generations === 0) return 0;
    if (this.#costKnownZero) return usage.totalUsd ?? 0;
    return usage.priced === "full" ? (usage.totalUsd ?? 0) : undefined;
  }

  /** Records an item's actions and re-checks every limit. Returns why the budget is now exceeded, if it is. */
  charge(actions: number, usage: UsageCounts | undefined): string | undefined {
    this.#actions += actions;
    const l = this.#limits;
    if (this.#exceeded === undefined && l.maxActions !== undefined && this.#actions > l.maxActions) {
      this.#exceeded = `action budget exceeded: ${this.#actions} > ${l.maxActions}`;
    }
    if (this.#exceeded === undefined && l.maxMinutes !== undefined && this.minutes() > l.maxMinutes) {
      this.#exceeded = `time budget exceeded: ${this.minutes().toFixed(2)} > ${l.maxMinutes} min`;
    }
    if (this.#exceeded === undefined && l.maxUsd !== undefined) {
      const usd = this.usd(usage);
      if (usd === undefined) this.#exceeded = `usd budget set but the model spend is ${unmeasurable(usage)} (spend not measurable)`;
      else if (usd > l.maxUsd) this.#exceeded = `usd budget exceeded: $${usd.toFixed(4)} > $${l.maxUsd}`;
    }
    return this.#exceeded;
  }

  /** Can another item start? Returns why not (the budget is exhausted or already exceeded). */
  blocked(usage: UsageCounts | undefined): string | undefined {
    if (this.#exceeded !== undefined) return this.#exceeded;
    const l = this.#limits;
    if (l.maxActions !== undefined && this.#actions >= l.maxActions) return `action budget exhausted: ${this.#actions}/${l.maxActions}`;
    if (l.maxMinutes !== undefined && this.minutes() >= l.maxMinutes) return `time budget exhausted: ${l.maxMinutes} min`;
    if (l.maxUsd !== undefined) {
      const usd = this.usd(usage);
      if (usd === undefined) return `usd budget set but the model spend is ${unmeasurable(usage)} (spend not measurable)`;
      if (usd >= l.maxUsd) return `usd budget exhausted: $${usd.toFixed(4)}/$${l.maxUsd}`;
    }
    return undefined;
  }

  report(usage: UsageCounts | undefined, exceeded: string | undefined): BudgetReport {
    const usd = this.usd(usage);
    return {
      limits: this.#limits,
      used: { actions: this.#actions, minutes: Number(this.minutes().toFixed(3)), ...(usd === undefined ? {} : { usd }) },
      ...(exceeded === undefined ? {} : { exceeded }),
    };
  }
}
