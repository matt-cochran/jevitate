import { clock, type HealBudget } from "@jevitate/domain";

export type { HealBudget } from "@jevitate/domain";

/**
 * #453: the budget a change-aware self-heal runs with when the `RunPolicy` names none. One candidate
 * tried = one attempt; wall-clock is the time spent healing (proposing + probing), on `clock`.
 */
export const DEFAULT_HEAL_BUDGET: HealBudget = {
  perStep: { maxAttempts: 2, maxModelCalls: 6, maxMs: 60_000 },
  perRun: { maxAttempts: 4, maxModelCalls: 12, maxMs: 180_000, maxBrokenSteps: 2 },
};

export type HealBudgetDimension = "attempts" | "modelCalls" | "tokens" | "wallClock" | "brokenSteps";

/** Which limit ran out, and at which scope. */
export interface HealExhaustion {
  readonly by: HealBudgetDimension;
  readonly scope: "step" | "run";
  readonly detail: string;
}

/** What a run's heal spent. `ms` is time spent healing, not the run's whole duration. */
export interface HealBudgetUsage {
  attempts: number;
  modelCalls: number;
  tokens: number;
  ms: number;
  brokenSteps: number;
}

/**
 * Meters one run's self-heal against a `HealBudget`. Time is read only through `clock`
 * (`monotonicMs`), so a `FakeClock` drives it in tests. Per step: attempts, model calls, tokens and
 * the time since `beginStep`. Per run: their sums over every step, plus how many steps broke.
 * Attempts and wall-clock are checked BEFORE a candidate is tried (`canAttempt`); model calls before
 * the healer is asked (`canCallModel`) — a candidate already paid for is still tried.
 */
export class HealBudgetMeter {
  #run: HealBudgetUsage = { attempts: 0, modelCalls: 0, tokens: 0, ms: 0, brokenSteps: 0 };
  #step = { attempts: 0, modelCalls: 0, tokens: 0 };
  #stepStartedAt: number | undefined;
  #closedMs = 0;

  constructor(readonly limits: HealBudget) {}

  /**
   * Starts metering a newly broken step (closing the previous one). Returns the exhaustion when the
   * run already healed `perRun.maxBrokenSteps` steps — this one is then never attempted.
   */
  beginStep(_stepIndex: number): HealExhaustion | null {
    this.endStep();
    if (this.#run.brokenSteps >= this.limits.perRun.maxBrokenSteps) {
      return { by: "brokenSteps", scope: "run", detail: `the run already spent its heal budget on ${this.#run.brokenSteps} broken step(s) (perRun.maxBrokenSteps ${this.limits.perRun.maxBrokenSteps})` };
    }
    this.#run.brokenSteps++;
    this.#step = { attempts: 0, modelCalls: 0, tokens: 0 };
    this.#stepStartedAt = clock.monotonicMs();
    return null;
  }

  /** Stops the current step's clock (idempotent). */
  endStep(): void {
    if (this.#stepStartedAt === undefined) return;
    this.#closedMs += clock.monotonicMs() - this.#stepStartedAt;
    this.#stepStartedAt = undefined;
  }

  /** Why one more candidate may NOT be tried, or null when it may. */
  canAttempt(): HealExhaustion | null {
    const { perStep, perRun } = this.limits;
    if (this.#step.attempts >= perStep.maxAttempts) return { by: "attempts", scope: "step", detail: `perStep.maxAttempts ${perStep.maxAttempts} reached` };
    if (this.#run.attempts >= perRun.maxAttempts) return { by: "attempts", scope: "run", detail: `perRun.maxAttempts ${perRun.maxAttempts} reached` };
    return this.#overSpend() ?? this.#overTime();
  }

  /** Why the healer may NOT be asked again, or null when it may. */
  canCallModel(): HealExhaustion | null {
    const { perStep, perRun } = this.limits;
    if (this.#step.modelCalls >= perStep.maxModelCalls) return { by: "modelCalls", scope: "step", detail: `perStep.maxModelCalls ${perStep.maxModelCalls} reached` };
    if (this.#run.modelCalls >= perRun.maxModelCalls) return { by: "modelCalls", scope: "run", detail: `perRun.maxModelCalls ${perRun.maxModelCalls} reached` };
    return this.#overSpend() ?? this.#overTime();
  }

  /** Counts one candidate tried. */
  recordAttempt(): void {
    this.#step.attempts++;
    this.#run.attempts++;
  }

  /** Charges what one healer call reported spending. */
  charge(u: { readonly modelCalls: number; readonly tokens?: number | undefined }): void {
    const calls = Math.max(0, u.modelCalls);
    const tokens = Math.max(0, u.tokens ?? 0);
    this.#step.modelCalls += calls;
    this.#run.modelCalls += calls;
    this.#step.tokens += tokens;
    this.#run.tokens += tokens;
  }

  /** How many more model calls the healer may make for this step (never negative). */
  remainingModelCalls(): number {
    const { perStep, perRun } = this.limits;
    return Math.max(0, Math.min(perStep.maxModelCalls - this.#step.modelCalls, perRun.maxModelCalls - this.#run.modelCalls));
  }

  /** The `clock.now()` instant by which this step's heal must be done (the tighter of step and run). */
  deadlineAtMs(): number {
    const { perStep, perRun } = this.limits;
    const left = Math.min(perStep.maxMs - this.#stepMs(), perRun.maxMs - this.#runMs());
    return clock.now() + Math.max(0, left);
  }

  /** What the run's heal spent so far. */
  usage(): HealBudgetUsage {
    return { ...this.#run, ms: this.#runMs() };
  }

  #stepMs(): number {
    return this.#stepStartedAt === undefined ? 0 : clock.monotonicMs() - this.#stepStartedAt;
  }

  #runMs(): number {
    return this.#closedMs + this.#stepMs();
  }

  #overSpend(): HealExhaustion | null {
    const { perStep, perRun } = this.limits;
    if (perStep.maxTokens !== undefined && this.#step.tokens >= perStep.maxTokens) return { by: "tokens", scope: "step", detail: `perStep.maxTokens ${perStep.maxTokens} reached` };
    if (perRun.maxTokens !== undefined && this.#run.tokens >= perRun.maxTokens) return { by: "tokens", scope: "run", detail: `perRun.maxTokens ${perRun.maxTokens} reached` };
    return null;
  }

  #overTime(): HealExhaustion | null {
    const { perStep, perRun } = this.limits;
    if (this.#stepMs() >= perStep.maxMs) return { by: "wallClock", scope: "step", detail: `perStep.maxMs ${perStep.maxMs} elapsed` };
    if (this.#runMs() >= perRun.maxMs) return { by: "wallClock", scope: "run", detail: `perRun.maxMs ${perRun.maxMs} elapsed` };
    return null;
  }
}
