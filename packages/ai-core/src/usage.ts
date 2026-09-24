/**
 * Usage accounting (#100): a `--real` run makes real Jev-judgment and generation-model calls, but
 * jevitate reported no cost anywhere — a caller had to instrument the target app itself to
 * attribute spend to a run. `UsageTracker` accumulates counts across a run; a CLI command builds
 * ONE per invocation and hands it to the live seams (`realJevClientCall`, the OpenRouter call) and
 * to the fake gateways, so every path (real, retried, fake) reports the same shape.
 *
 * Counting happens at the innermost seam — the actual SDK/HTTP call, not the `JudgmentPort` /
 * `GenerationPort` method — so a transient failure retried by `RetryingJudgmentPort` /
 * `RetryingGenerationPort` (retry.ts) counts every attempt, not just the one that finally succeeded.
 *
 * `usd` is populated ONLY when the provider itself reports cost (OpenRouter's usage-accounting
 * `cost`, when enabled) — never estimated or derived from a price table, so it is absent whenever
 * the provider doesn't say.
 */

export interface UsageCounts {
  readonly judgments: number;
  readonly generations: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
  /** Only present when at least one call reported a provider-supplied cost. */
  readonly usd?: number;
}

export interface UsageSink {
  recordJudgment(usage: { inputTokens: number; outputTokens: number }): void;
  recordGeneration(usage: { inputTokens: number; outputTokens: number; usd?: number }): void;
}

/** Mutable accumulator — the concrete `UsageSink` every CLI command constructs once per run. */
export class UsageTracker implements UsageSink {
  #judgments = 0;
  #generations = 0;
  #inputTokens = 0;
  #outputTokens = 0;
  #usd = 0;
  #hasUsd = false;

  recordJudgment(usage: { inputTokens: number; outputTokens: number }): void {
    this.#judgments += 1;
    this.#inputTokens += usage.inputTokens;
    this.#outputTokens += usage.outputTokens;
  }

  recordGeneration(usage: { inputTokens: number; outputTokens: number; usd?: number }): void {
    this.#generations += 1;
    this.#inputTokens += usage.inputTokens;
    this.#outputTokens += usage.outputTokens;
    if (usage.usd !== undefined) {
      this.#usd += usage.usd;
      this.#hasUsd = true;
    }
  }

  snapshot(): UsageCounts {
    return {
      judgments: this.#judgments,
      generations: this.#generations,
      inputTokens: this.#inputTokens,
      outputTokens: this.#outputTokens,
      ...(this.#hasUsd ? { usd: this.#usd } : {}),
    };
  }
}
