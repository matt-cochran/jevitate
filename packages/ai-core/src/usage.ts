/**
 * Usage accounting (#100, #136): a `--real` run makes real Jev-judgment and generation-model calls,
 * but jevitate reported no cost anywhere — a caller had to instrument the target app itself to
 * attribute spend to a run. `UsageTracker` accumulates counts across a run; a CLI command builds
 * ONE per invocation and hands it to the live seams (`realJevClientCall`, the OpenRouter call) and
 * to the fake gateways, so every path (real, retried, fake) reports the same shape.
 *
 * Counting happens at the innermost seam — the actual SDK/HTTP call, not the `JudgmentPort` /
 * `GenerationPort` method — so a transient failure retried by `RetryingJudgmentPort` /
 * `RetryingGenerationPort` (retry.ts) counts every attempt, not just the one that finally succeeded.
 *
 * `generationUsd` is populated ONLY when the provider itself reports cost (OpenRouter's
 * usage-accounting `cost`, when enabled) — never estimated. `jevUsd` (#136, a follow-up to #100) is
 * priced the same way when a future SDK reports a per-call cost; today's SDK (`@typesafe-ai/sdk`
 * 0.6) never does, so `jevUsd` instead falls back to `judgments × a CALLER-CONFIGURED unit price`
 * (the CLI resolves this from `~/.jevitate/config.json` or an env var — this package never reads
 * either) — every judgment costs the model an extra question beyond generation, so leaving it
 * unpriced by default materially understates a run's real cost. `priced` says which of `jevUsd` /
 * `generationUsd` are known, so `totalUsd` — when present — is never silently incomplete.
 */

/** Where a judgment's unit price came from, so `jevUsd` is never an unexplained number. */
export interface JevPricing {
  readonly unitPriceUsd: number;
  /** e.g. `"config:~/.jevitate/config.json usage.jevUnitPriceUsd"` or `"env:JEVITATE_JEV_UNIT_PRICE_USD"`. */
  readonly source: string;
}

/** Whether `totalUsd` reflects every component that needed pricing. */
export type UsagePriced = "full" | "partial" | "none";

export interface UsageCounts {
  readonly judgments: number;
  readonly generations: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
  /** Judgment (Jev) cost: a provider-reported cost, or `judgments × the configured unit price`. */
  readonly jevUsd?: number;
  /** Generation cost: provider-reported only — never estimated, so it may be absent even when
   * `generations > 0` (the provider simply didn't say). */
  readonly generationUsd?: number;
  /** `jevUsd + generationUsd`, present whenever at least one of them is known. */
  readonly totalUsd?: number;
  /**
   * `"full"` — every component that made calls has a known cost (or nothing needed pricing);
   * `"partial"` — at least one priced, at least one made calls but couldn't be priced;
   * `"none"` — nothing could be priced. Read this before treating `totalUsd` as the run's real cost.
   */
  readonly priced: UsagePriced;
  /** Where `jevUsd`'s unit price came from — present only when the unit-price fallback priced it. */
  readonly jevPriceSource?: string;
  /** @deprecated Alias for `totalUsd` (#100 compat). Prefer `totalUsd` + `priced`. */
  readonly usd?: number;
}

export interface UsageSink {
  recordJudgment(usage: { inputTokens: number; outputTokens: number; usd?: number }): void;
  recordGeneration(usage: { inputTokens: number; outputTokens: number; usd?: number }): void;
}

function componentPriced(calls: number, usd: number | undefined): "known" | "unpriced" | "n/a" {
  if (calls === 0) return "n/a";
  return usd === undefined ? "unpriced" : "known";
}

/** Mutable accumulator — the concrete `UsageSink` every CLI command constructs once per run. */
export class UsageTracker implements UsageSink {
  #judgments = 0;
  #generations = 0;
  #inputTokens = 0;
  #outputTokens = 0;
  #generationUsd = 0;
  #hasGenerationUsd = false;
  /** Provider-reported judgment cost, summed as it arrives (today's SDK never reports one). */
  #jevProviderUsd = 0;
  #hasJevProviderUsd = false;
  readonly #jevPricing?: JevPricing;

  /**
   * `jevPricing` (#136): the CLI-resolved unit price for a judgment whose call reported no cost of
   * its own. Absent = `jevUsd` is priced only from what the provider actually reports (today, never).
   */
  constructor(jevPricing?: JevPricing) {
    this.#jevPricing = jevPricing;
  }

  recordJudgment(usage: { inputTokens: number; outputTokens: number; usd?: number }): void {
    this.#judgments += 1;
    this.#inputTokens += usage.inputTokens;
    this.#outputTokens += usage.outputTokens;
    if (usage.usd !== undefined) {
      this.#jevProviderUsd += usage.usd;
      this.#hasJevProviderUsd = true;
    }
  }

  recordGeneration(usage: { inputTokens: number; outputTokens: number; usd?: number }): void {
    this.#generations += 1;
    this.#inputTokens += usage.inputTokens;
    this.#outputTokens += usage.outputTokens;
    if (usage.usd !== undefined) {
      this.#generationUsd += usage.usd;
      this.#hasGenerationUsd = true;
    }
  }

  snapshot(): UsageCounts {
    // Provider-reported judgment cost always wins over the unit-price fallback; the fallback only
    // fills the gap when the provider never said (today, always — see the module doc).
    let jevUsd: number | undefined = this.#hasJevProviderUsd ? this.#jevProviderUsd : undefined;
    let jevPriceSource: string | undefined;
    if (jevUsd === undefined && this.#judgments > 0 && this.#jevPricing !== undefined) {
      jevUsd = this.#judgments * this.#jevPricing.unitPriceUsd;
      jevPriceSource = this.#jevPricing.source;
    }
    const generationUsd = this.#hasGenerationUsd ? this.#generationUsd : undefined;

    const jevState = componentPriced(this.#judgments, jevUsd);
    const genState = componentPriced(this.#generations, generationUsd);
    const anyUnpriced = jevState === "unpriced" || genState === "unpriced";
    const anyKnown = jevState === "known" || genState === "known";
    const priced: UsagePriced = anyUnpriced ? (anyKnown ? "partial" : "none") : anyKnown ? "full" : "none";

    const totalUsd = jevUsd === undefined && generationUsd === undefined ? undefined : (jevUsd ?? 0) + (generationUsd ?? 0);

    return {
      judgments: this.#judgments,
      generations: this.#generations,
      inputTokens: this.#inputTokens,
      outputTokens: this.#outputTokens,
      ...(jevUsd === undefined ? {} : { jevUsd }),
      ...(generationUsd === undefined ? {} : { generationUsd }),
      ...(totalUsd === undefined ? {} : { totalUsd }),
      priced,
      ...(jevPriceSource === undefined ? {} : { jevPriceSource }),
      ...(totalUsd === undefined ? {} : { usd: totalUsd }),
    };
  }
}
