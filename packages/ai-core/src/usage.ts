/**
 * Usage accounting (#100, #136, #163): a `--real` run makes real Jev-judgment and generation-model
 * calls, and every one of them costs money. `UsageTracker` records EACH call (kind, task, model,
 * tokens, cost, and where that cost came from) and derives the run's totals from those calls. A
 * CLI command builds ONE tracker per invocation and hands it to the live seams (`realJevClientCall`,
 * the OpenRouter call) and to the fake gateways, so every path (real, retried, failed, fake)
 * reports the same shape.
 *
 * Counting happens at the innermost seam — the actual SDK/HTTP call, not the `JudgmentPort` /
 * `GenerationPort` method — so a transient failure retried by `RetryingJudgmentPort` /
 * `RetryingGenerationPort` (retry.ts) counts every attempt, not just the one that finally succeeded.
 *
 * Each call is priced, in order (#163):
 *  1. the cost the provider itself reported for the call (OpenRouter's usage-accounting `cost`; a
 *     future TypeSafe SDK field) — always wins;
 *  2. a failed attempt that reported no usage stays UNPRICED (never assumed free);
 *  3. judgments only: a CALLER-CONFIGURED per-judgment unit price (#136; env/config, resolved by the
 *     CLI — this package never reads either);
 *  4. a caller-configured per-model token price (config `usage.modelPrices`);
 *  5. the built-in, versioned default price tables below (`JEV_PRICE_TABLE`,
 *     `GENERATION_PRICE_TABLE`), each naming its source and retrieval date;
 *  6. otherwise UNPRICED: the model is named in `missing`, and `priced` is `partial`/`none`.
 * A price is never invented and a call is never silently zero: `totalUsd` is the sum of the calls
 * that COULD be priced, and `priced` says whether that is all of them.
 */

/** Where a judgment's unit price came from, so `jevUsd` is never an unexplained number. */
export interface JevPricing {
  readonly unitPriceUsd: number;
  /** e.g. `"config:~/.jevitate/config.json usage.jevUnitPriceUsd"` or `"env:JEVITATE_JEV_UNIT_PRICE_USD"`. */
  readonly source: string;
}

/** A per-token price, in USD per million tokens. */
export interface ModelPrice {
  readonly inputUsdPerMtok: number;
  readonly outputUsdPerMtok: number;
}

/** A versioned price table: `id` and `retrieved` date it, `source` says where the numbers came from. */
export interface PriceTable {
  readonly id: string;
  /** ISO date the prices were read from `source`. */
  readonly retrieved: string;
  readonly source: string;
  readonly models: Readonly<Record<string, ModelPrice>>;
}

const JEV_1_13: ModelPrice = { inputUsdPerMtok: 0.042, outputUsdPerMtok: 0 };

/**
 * Jev (TypeSafe `systemOne`) prices, from TypeSafe's own model page: Jev 1.13 is "$42 / $0.042"
 * per Btok / per Mtok, "Charged per input token. Output tokens are free." The SDK response names
 * the VERSIONED model that answered (`jev-1.13.0`), which is what a call is priced by; the aliases
 * are listed for a response that does not name one (they pointed at `jev-1.13.0` on `retrieved`,
 * and an alias moves when a new release ships — update this table with it).
 */
export const JEV_PRICE_TABLE: PriceTable = {
  id: "typesafe-models@2026-09-24",
  retrieved: "2026-09-24",
  source: "https://docs.typesafe.ai/models.md",
  models: { "jev-1.13.0": JEV_1_13, "jev-latest": JEV_1_13, "jev-preview": JEV_1_13 },
};

/**
 * Generation-model fallback prices — used only when OpenRouter reports no `cost` for a call. From
 * OpenRouter's model catalog (`pricing.prompt` / `pricing.completion`, USD per token, × 1e6 here).
 * Only the models jevitate's built-in catalog selects are listed; any other model is unpriced (and
 * named in `missing`) unless configured via `usage.modelPrices`.
 */
export const GENERATION_PRICE_TABLE: PriceTable = {
  id: "openrouter-models@2026-09-24",
  retrieved: "2026-09-24",
  source: "https://openrouter.ai/api/v1/models",
  models: { "openai/gpt-4o-mini": { inputUsdPerMtok: 0.15, outputUsdPerMtok: 0.6 } },
};

/** Caller-configured per-model token prices (they override the built-in tables). */
export interface ConfiguredModelPrices {
  readonly prices: Readonly<Record<string, ModelPrice>>;
  readonly source: string;
}

export interface UsagePricing {
  /** A configured per-judgment price (#136) — overrides the Jev table. */
  readonly jevUnitPrice?: JevPricing;
  /** Configured per-model token prices — override both tables. */
  readonly modelPrices?: ConfiguredModelPrices;
  /** Defaults to `JEV_PRICE_TABLE` (a test seam). */
  readonly jevTable?: PriceTable;
  /** Defaults to `GENERATION_PRICE_TABLE` (a test seam). */
  readonly generationTable?: PriceTable;
}

/** Whether `totalUsd` reflects every call that needed pricing. */
export type UsagePriced = "full" | "partial" | "none";

export type UsageCallKind = "judgment" | "generation";

/** One model call, as the per-run `<run>.usage.json` sidecar lists it. Never prompt contents. */
export interface UsageCall {
  /** 1-based order within the tracker. */
  readonly seq: number;
  readonly kind: UsageCallKind;
  /** The generation task (`form.value`, `chat.reply`, …); absent for judgments. */
  readonly task?: string;
  readonly model?: string;
  /** False for an attempt that threw (it is still counted: retries and failures cost money). */
  readonly ok: boolean;
  readonly inputTokens: number;
  readonly outputTokens: number;
  /** Absent = this call could not be priced (see `source`). */
  readonly usd?: number;
  /** Where `usd` came from (`provider:…`, `config:…`, `table:…`), or why it is unpriced (`unpriced:…`). */
  readonly source: string;
  /** For a failed attempt: a short error class (e.g. `http-429`) — never an error message. */
  readonly failure?: string;
}

export interface UsageCounts {
  readonly judgments: number;
  readonly generations: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
  /** Judgment (Jev) cost of the calls that could be priced. */
  readonly jevUsd?: number;
  /** Generation cost of the calls that could be priced. */
  readonly generationUsd?: number;
  /** `jevUsd + generationUsd`, present whenever at least one call was priced. */
  readonly totalUsd?: number;
  /**
   * `"full"` — every call has a known cost (or nothing needed pricing and something was priced);
   * `"partial"` — some calls priced, at least one not (see `missing`);
   * `"none"` — nothing could be priced (or no calls were made). Read this before treating
   * `totalUsd` as the run's real cost.
   */
  readonly priced: UsagePriced;
  /** Every distinct price source used (`provider:…`, `config:…`, `table:<id> (<source>)`). */
  readonly priceSource?: readonly string[];
  /** What could not be priced, e.g. `jev: no price for model jev-9.0.0`. Present when `priced` isn't full. */
  readonly missing?: readonly string[];
  /** Attempts that threw (counted in `judgments`/`generations`). */
  readonly failedCalls?: number;
  /** The Jev price source(s), joined — #136 compat; prefer `priceSource`. */
  readonly jevPriceSource?: string;
  /** @deprecated Alias for `totalUsd` (#100 compat). Prefer `totalUsd` + `priced`. */
  readonly usd?: number;
}

/** What a seam reports for one call. */
export interface UsageRecord {
  readonly inputTokens: number;
  readonly outputTokens: number;
  /** A cost the provider reported for this call. */
  readonly usd?: number;
  /** Labels a reported `usd` (default `provider:typesafe` / `provider:openrouter usage.cost`). */
  readonly source?: string;
  readonly model?: string;
  readonly task?: string;
  /** Set for an attempt that threw. */
  readonly failure?: string;
}

/** The model name fake gateways record: no model ran, so (unless a price is configured) it costs $0. */
export const FAKE_MODEL = "fake";

/** What a fake gateway records per call. */
export const FAKE_CALL_USAGE: UsageRecord = { inputTokens: 0, outputTokens: 0, model: FAKE_MODEL };

export interface UsageSink {
  recordJudgment(usage: UsageRecord): void;
  recordGeneration(usage: UsageRecord): void;
}

/** A read-only view over some calls: what a run's result and sidecar are built from. */
export interface UsageLedger {
  snapshot(): UsageCounts;
  calls(): readonly UsageCall[];
}

/** The `<run>.usage.json` sidecar: the run's totals plus every call behind them. */
export interface UsageSidecar {
  readonly version: 1;
  readonly usage: UsageCounts;
  readonly calls: readonly UsageCall[];
}

export function usageSidecar(ledger: UsageLedger): UsageSidecar {
  return { version: 1, usage: ledger.snapshot(), calls: ledger.calls() };
}

function tablePrice(table: PriceTable, model: string): ModelPrice | undefined {
  return Object.prototype.hasOwnProperty.call(table.models, model) ? table.models[model] : undefined;
}

/** Only the prefix of an error class is kept: `http-<status>` or the error's `name` — never its message. */
export function failureClass(e: unknown): string {
  if (typeof e === "object" && e !== null) {
    const o = e as Record<string, unknown>;
    const status = typeof o.status === "number" ? o.status : typeof o.statusCode === "number" ? o.statusCode : undefined;
    if (status !== undefined) return `http-${status}`;
    if (typeof o.name === "string" && /^[A-Za-z0-9_]{1,64}$/.test(o.name)) return o.name;
  }
  return "error";
}

function byTokens(p: ModelPrice, r: UsageRecord): number {
  return (r.inputTokens * p.inputUsdPerMtok + r.outputTokens * p.outputUsdPerMtok) / 1_000_000;
}

function tableLabel(t: PriceTable): string {
  return `table:${t.id} (${t.source})`;
}

/** Prices one call (see the module doc for the order). Pure. */
export function priceCall(kind: UsageCallKind, r: UsageRecord, pricing: UsagePricing = {}): { usd?: number; source: string; missing?: string } {
  if (r.usd !== undefined) {
    return { usd: r.usd, source: r.source ?? (kind === "judgment" ? "provider:typesafe" : "provider:openrouter usage.cost") };
  }
  const label = kind === "judgment" ? "jev" : "generation";
  if (r.failure !== undefined && r.inputTokens + r.outputTokens === 0) {
    return { source: "unpriced:failed attempt reported no usage", missing: `${label}: failed attempt(s) reported no usage` };
  }
  if (kind === "judgment" && pricing.jevUnitPrice !== undefined) {
    return { usd: pricing.jevUnitPrice.unitPriceUsd, source: pricing.jevUnitPrice.source };
  }
  if (r.model === undefined) return { source: "unpriced:model not reported", missing: `${label}: model not reported` };
  const cfg = pricing.modelPrices;
  if (cfg !== undefined && Object.prototype.hasOwnProperty.call(cfg.prices, r.model)) {
    const p = cfg.prices[r.model];
    if (p !== undefined) return { usd: byTokens(p, r), source: cfg.source };
  }
  if (r.model === FAKE_MODEL) return { usd: 0, source: "fake:no model call" };
  const table = kind === "judgment" ? (pricing.jevTable ?? JEV_PRICE_TABLE) : (pricing.generationTable ?? GENERATION_PRICE_TABLE);
  const p = tablePrice(table, r.model);
  if (p !== undefined) return { usd: byTokens(p, r), source: tableLabel(table) };
  return { source: `unpriced:no price for model ${r.model}`, missing: `${label}: no price for model ${r.model}` };
}

function uniq(xs: Iterable<string>): string[] {
  return [...new Set(xs)];
}

function derivePriced(calls: number, unpriced: number, anyPriced: boolean): UsagePriced {
  if (calls === 0) return "none";
  if (unpriced === 0) return "full";
  return anyPriced ? "partial" : "none";
}

/** Totals over a list of calls (the tracker's, or a run's slice of it). Pure. */
export function summarizeCalls(calls: readonly UsageCall[], missing: readonly string[] = []): UsageCounts {
  let judgments = 0;
  let generations = 0;
  let inputTokens = 0;
  let outputTokens = 0;
  let jevUsd: number | undefined;
  let generationUsd: number | undefined;
  let unpriced = 0;
  let failed = 0;
  const sources: string[] = [];
  const jevSources: string[] = [];
  const gaps: string[] = [...missing];
  for (const c of calls) {
    if (c.kind === "judgment") judgments += 1;
    else generations += 1;
    inputTokens += c.inputTokens;
    outputTokens += c.outputTokens;
    if (!c.ok) failed += 1;
    if (c.usd === undefined) {
      unpriced += 1;
      continue;
    }
    sources.push(c.source);
    if (c.kind === "judgment") {
      jevUsd = (jevUsd ?? 0) + c.usd;
      jevSources.push(c.source);
    } else {
      generationUsd = (generationUsd ?? 0) + c.usd;
    }
  }
  const totalUsd = jevUsd === undefined && generationUsd === undefined ? undefined : (jevUsd ?? 0) + (generationUsd ?? 0);
  const priced = derivePriced(judgments + generations, unpriced, totalUsd !== undefined);
  const gapList = uniq(gaps);
  const jevSourceList = uniq(jevSources);
  return {
    judgments,
    generations,
    inputTokens,
    outputTokens,
    ...(jevUsd === undefined ? {} : { jevUsd }),
    ...(generationUsd === undefined ? {} : { generationUsd }),
    ...(totalUsd === undefined ? {} : { totalUsd }),
    priced,
    ...(sources.length === 0 ? {} : { priceSource: uniq(sources) }),
    ...(gapList.length === 0 ? {} : { missing: gapList }),
    ...(failed === 0 ? {} : { failedCalls: failed }),
    ...(jevSourceList.length === 0 ? {} : { jevPriceSource: jevSourceList.join(" + ") }),
    ...(totalUsd === undefined ? {} : { usd: totalUsd }),
  };
}

interface Entry {
  readonly call: UsageCall;
  readonly missing?: string;
}

/** Mutable accumulator — the concrete `UsageSink` every CLI command constructs once per run. */
export class UsageTracker implements UsageSink, UsageLedger {
  readonly #entries: Entry[] = [];
  readonly #pricing: UsagePricing;

  /**
   * `pricing` (#136, #163): configured prices (they override the built-in tables). A bare
   * `JevPricing` is the #136 shape: a configured per-judgment unit price.
   */
  constructor(pricing?: JevPricing | UsagePricing) {
    this.#pricing = pricing === undefined ? {} : "unitPriceUsd" in pricing ? { jevUnitPrice: pricing } : pricing;
  }

  #record(kind: UsageCallKind, r: UsageRecord): void {
    const priced = priceCall(kind, r, this.#pricing);
    const call: UsageCall = {
      seq: this.#entries.length + 1,
      kind,
      ...(r.task === undefined ? {} : { task: r.task }),
      ...(r.model === undefined ? {} : { model: r.model }),
      ok: r.failure === undefined,
      inputTokens: r.inputTokens,
      outputTokens: r.outputTokens,
      ...(priced.usd === undefined ? {} : { usd: priced.usd }),
      source: priced.source,
      ...(r.failure === undefined ? {} : { failure: r.failure }),
    };
    this.#entries.push({ call, ...(priced.missing === undefined ? {} : { missing: priced.missing }) });
  }

  recordJudgment(usage: UsageRecord): void {
    this.#record("judgment", usage);
  }

  recordGeneration(usage: UsageRecord): void {
    this.#record("generation", usage);
  }

  #view(from: number): UsageLedger {
    const entries = (): Entry[] => this.#entries.slice(from);
    return {
      snapshot: () => {
        const es = entries();
        return summarizeCalls(
          es.map((e) => e.call),
          es.flatMap((e) => (e.missing === undefined ? [] : [e.missing])),
        );
      },
      calls: () => entries().map((e) => e.call),
    };
  }

  snapshot(): UsageCounts {
    return this.#view(0).snapshot();
  }

  calls(): readonly UsageCall[] {
    return this.#view(0).calls();
  }

  /**
   * A view over the calls recorded from now on — one run's share of a tracker shared by several
   * sequential runs (a `check` suite's items, a queue drain), so each run's `usage` and sidecar are
   * its own, never the running total.
   */
  scope(): UsageLedger {
    return this.#view(this.#entries.length);
  }
}

// ---------- aggregation across runs ----------

/** Usage summed over several runs (#163): multi-run, `check --suite`, `jevitate report`. */
export interface UsageAggregate extends UsageCounts {
  readonly runs: number;
  /** `inputTokens + outputTokens`. */
  readonly tokens: number;
  /** Runs that carried no `usage` at all. */
  readonly unreportedRuns?: number;
}

function finiteNumber(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

function stringList(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((s): s is string => typeof s === "string") : [];
}

/** Reads a persisted `usage` object back (untrusted JSON). Undefined when it isn't one. */
export function usageCountsFrom(raw: unknown): UsageCounts | undefined {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const o = raw as Record<string, unknown>;
  const judgments = finiteNumber(o.judgments);
  const generations = finiteNumber(o.generations);
  if (judgments === undefined || generations === undefined) return undefined;
  const priced: UsagePriced = o.priced === "full" || o.priced === "partial" ? o.priced : "none";
  const jevUsd = finiteNumber(o.jevUsd);
  const generationUsd = finiteNumber(o.generationUsd);
  const totalUsd = finiteNumber(o.totalUsd) ?? finiteNumber(o.usd);
  const priceSource = stringList(o.priceSource);
  const missing = stringList(o.missing);
  const failedCalls = finiteNumber(o.failedCalls);
  return {
    judgments,
    generations,
    inputTokens: finiteNumber(o.inputTokens) ?? 0,
    outputTokens: finiteNumber(o.outputTokens) ?? 0,
    ...(jevUsd === undefined ? {} : { jevUsd }),
    ...(generationUsd === undefined ? {} : { generationUsd }),
    ...(totalUsd === undefined ? {} : { totalUsd }),
    priced,
    ...(priceSource.length === 0 ? {} : { priceSource }),
    ...(missing.length === 0 ? {} : { missing }),
    ...(failedCalls === undefined ? {} : { failedCalls }),
  };
}

/**
 * Sums runs' usage. The aggregate is `full` only when every run that made calls was fully priced;
 * a run that carried no usage is counted in `unreportedRuns` and — when `unreported` is `"partial"`
 * (runs this process launched, whose spend is unknown) — makes the aggregate partial.
 */
export function sumUsage(
  runs: ReadonlyArray<UsageCounts | undefined>,
  opts: { unreported?: "partial" | "ignore" } = {},
): UsageAggregate {
  let judgments = 0;
  let generations = 0;
  let inputTokens = 0;
  let outputTokens = 0;
  let jevUsd: number | undefined;
  let generationUsd: number | undefined;
  let failed = 0;
  let unreportedRuns = 0;
  let incomplete = false;
  const sources: string[] = [];
  const missing: string[] = [];
  for (const u of runs) {
    if (u === undefined) {
      unreportedRuns += 1;
      continue;
    }
    judgments += u.judgments;
    generations += u.generations;
    inputTokens += u.inputTokens;
    outputTokens += u.outputTokens;
    failed += u.failedCalls ?? 0;
    if (u.jevUsd !== undefined) jevUsd = (jevUsd ?? 0) + u.jevUsd;
    if (u.generationUsd !== undefined) generationUsd = (generationUsd ?? 0) + u.generationUsd;
    // A #100-era result has `usd` but no split: count it as generation (the only priced kind then).
    if (u.jevUsd === undefined && u.generationUsd === undefined && u.totalUsd !== undefined) generationUsd = (generationUsd ?? 0) + u.totalUsd;
    sources.push(...(u.priceSource ?? []));
    missing.push(...(u.missing ?? []));
    if (u.judgments + u.generations > 0 && u.priced !== "full") {
      incomplete = true;
      if ((u.missing ?? []).length === 0) missing.push("a run's usage was not fully priced");
    }
  }
  if (unreportedRuns > 0 && opts.unreported !== "ignore") {
    incomplete = true;
    missing.push(`${unreportedRuns} run(s) reported no usage`);
  }
  const totalUsd = jevUsd === undefined && generationUsd === undefined ? undefined : (jevUsd ?? 0) + (generationUsd ?? 0);
  const calls = judgments + generations;
  const priced: UsagePriced = calls === 0 && !incomplete ? "none" : incomplete ? (totalUsd === undefined ? "none" : "partial") : totalUsd === undefined ? "none" : "full";
  const gapList = uniq(missing);
  const sourceList = uniq(sources);
  return {
    runs: runs.length,
    judgments,
    generations,
    inputTokens,
    outputTokens,
    tokens: inputTokens + outputTokens,
    ...(jevUsd === undefined ? {} : { jevUsd }),
    ...(generationUsd === undefined ? {} : { generationUsd }),
    ...(totalUsd === undefined ? {} : { totalUsd }),
    priced,
    ...(sourceList.length === 0 ? {} : { priceSource: sourceList }),
    ...(gapList.length === 0 ? {} : { missing: gapList }),
    ...(failed === 0 ? {} : { failedCalls: failed }),
    ...(unreportedRuns === 0 ? {} : { unreportedRuns }),
    ...(totalUsd === undefined ? {} : { usd: totalUsd }),
  };
}

/** A tracker's (suite-wide) snapshot as an aggregate over `runs` runs. */
export function aggregateOf(counts: UsageCounts, runs: number): UsageAggregate {
  return { ...counts, runs, tokens: counts.inputTokens + counts.outputTokens };
}

function money(usd: number): string {
  return `$${usd.toFixed(usd !== 0 && usd < 0.01 ? 6 : 4)}`;
}

/**
 * The one-line human summary (#163): the full cost, flagged when it is incomplete, e.g.
 * `cost $0.0312 (jev $0.0203 + generation $0.0109) · 398 judgments, 12 generations, 705,112 tokens`
 * or `… (partial: jev: no price for model jev-9.0.0)`.
 */
export function formatUsageLine(u: UsageCounts): string {
  const tokens = (u.inputTokens + u.outputTokens).toLocaleString("en-US");
  const counts = `${u.judgments} judgment${u.judgments === 1 ? "" : "s"}, ${u.generations} generation${u.generations === 1 ? "" : "s"}, ${tokens} tokens`;
  const split = `jev ${u.jevUsd === undefined ? "unpriced" : money(u.jevUsd)} + generation ${u.generationUsd === undefined ? "unpriced" : money(u.generationUsd)}`;
  const cost = u.totalUsd === undefined ? "cost unknown" : `cost ${money(u.totalUsd)}`;
  const flag =
    u.priced === "full" || u.judgments + u.generations === 0
      ? ""
      : ` (${u.priced === "partial" ? "partial" : "unpriced"}: ${(u.missing ?? ["not every call could be priced"]).join("; ")})`;
  return `${cost}${flag} (${split}) · ${counts}`;
}
