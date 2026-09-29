import { describe, expect, it } from "vitest";
import {
  FAKE_CALL_USAGE,
  GENERATION_PRICE_TABLE,
  JEV_PRICE_TABLE,
  UsageTracker,
  formatUsageLine,
  sumUsage,
  usageCountsFrom,
  usageSidecar,
} from "./usage.js";

describe("UsageTracker — #100 usage accounting", () => {
  it("starts at zero counts, unpriced", () => {
    expect(new UsageTracker().snapshot()).toEqual({ judgments: 0, generations: 0, inputTokens: 0, outputTokens: 0, priced: "none" });
  });

  it("accumulates judgments and generations separately, tokens together", () => {
    const usage = new UsageTracker();
    usage.recordJudgment({ inputTokens: 10, outputTokens: 2 });
    usage.recordJudgment({ inputTokens: 5, outputTokens: 1 });
    usage.recordGeneration({ inputTokens: 100, outputTokens: 20 });
    expect(usage.snapshot()).toEqual({
      judgments: 2,
      generations: 1,
      inputTokens: 115,
      outputTokens: 23,
      priced: "none",
      missing: ["jev: model not reported", "generation: model not reported"],
    });
  });

  it("generationUsd is absent until a call reports one, then accumulates only the reported calls' cost", () => {
    const usage = new UsageTracker();
    usage.recordGeneration({ inputTokens: 1, outputTokens: 1 });
    expect(usage.snapshot().generationUsd).toBeUndefined();
    usage.recordGeneration({ inputTokens: 1, outputTokens: 1, usd: 0.002 });
    usage.recordGeneration({ inputTokens: 1, outputTokens: 1 }); // no cost, no model: never estimated
    usage.recordGeneration({ inputTokens: 1, outputTokens: 1, usd: 0.0035 });
    const s = usage.snapshot();
    expect(s.generationUsd).toBeCloseTo(0.0055, 10);
    expect(s.totalUsd).toBeCloseTo(0.0055, 10);
    expect(s.usd).toBeCloseTo(0.0055, 10); // #100 compat alias
    // #163: two calls are unpriced, so the total is partial — never presented as complete.
    expect(s.priced).toBe("partial");
    expect(s.missing).toEqual(["generation: model not reported"]);
    expect(s.jevUsd).toBeUndefined();
  });
});

describe("UsageTracker — #136 jev (judgment) cost", () => {
  it("without a configured unit price, judgments never contribute usd and pricing is reported none", () => {
    const usage = new UsageTracker();
    usage.recordJudgment({ inputTokens: 10, outputTokens: 10 });
    const s = usage.snapshot();
    expect(s.jevUsd).toBeUndefined();
    expect(s.totalUsd).toBeUndefined();
    expect(s.usd).toBeUndefined();
    expect(s.priced).toBe("none");
  });

  it("with a configured unit price, jevUsd = judgments × price, and the source is labelled", () => {
    const usage = new UsageTracker({ unitPriceUsd: 0.006, source: "env:JEVITATE_JEV_UNIT_PRICE_USD" });
    usage.recordJudgment({ inputTokens: 10, outputTokens: 10 });
    usage.recordJudgment({ inputTokens: 10, outputTokens: 10 });
    usage.recordJudgment({ inputTokens: 10, outputTokens: 10 });
    const s = usage.snapshot();
    expect(s.jevUsd).toBeCloseTo(0.018, 10);
    expect(s.jevPriceSource).toBe("env:JEVITATE_JEV_UNIT_PRICE_USD");
    expect(s.totalUsd).toBeCloseTo(0.018, 10);
    expect(s.priced).toBe("full"); // no generations were made, so nothing there needed pricing
  });

  it("a provider-reported judgment cost wins over the configured unit price, and is labelled as the provider's", () => {
    const usage = new UsageTracker({ unitPriceUsd: 1, source: "config:~/.jevitate/config.json usage.jevUnitPriceUsd" });
    usage.recordJudgment({ inputTokens: 10, outputTokens: 10, usd: 0.001 });
    usage.recordJudgment({ inputTokens: 10, outputTokens: 10, usd: 0.002 });
    const s = usage.snapshot();
    expect(s.jevUsd).toBeCloseTo(0.003, 10);
    expect(s.jevPriceSource).toBe("provider:typesafe");
  });

  it("the split is shown, and priced is partial when one component is priced and the other made calls but couldn't be", () => {
    const usage = new UsageTracker(); // no jev pricing configured
    usage.recordJudgment({ inputTokens: 10, outputTokens: 10 });
    usage.recordGeneration({ inputTokens: 1, outputTokens: 1, usd: 0.002 });
    const s = usage.snapshot();
    expect(s.jevUsd).toBeUndefined();
    expect(s.generationUsd).toBeCloseTo(0.002, 10);
    expect(s.totalUsd).toBeCloseTo(0.002, 10); // as much as is known — never silently dropped
    expect(s.priced).toBe("partial");
  });

  it("priced is full when every component that made calls is priced (jev via unit price, generation via provider)", () => {
    const usage = new UsageTracker({ unitPriceUsd: 0.006, source: "env:JEVITATE_JEV_UNIT_PRICE_USD" });
    usage.recordJudgment({ inputTokens: 10, outputTokens: 10 });
    usage.recordGeneration({ inputTokens: 1, outputTokens: 1, usd: 0.002 });
    const s = usage.snapshot();
    expect(s.priced).toBe("full");
    expect(s.totalUsd).toBeCloseTo(0.008, 10);
  });
});

describe("UsageTracker — #163 full cost by default", () => {
  const jevTable = `table:${JEV_PRICE_TABLE.id} (${JEV_PRICE_TABLE.source})`;
  const genTable = `table:${GENERATION_PRICE_TABLE.id} (${GENERATION_PRICE_TABLE.source})`;

  it("prices a Jev judgment from the built-in table (input tokens only) and names the table and date", () => {
    const usage = new UsageTracker();
    usage.recordJudgment({ inputTokens: 2_000_000, outputTokens: 1_000, model: "jev-1.13.0" });
    const s = usage.snapshot();
    expect(s.jevUsd).toBeCloseTo(0.084, 10);
    expect(s.priced).toBe("full");
    expect(s.priceSource).toEqual([jevTable]);
    expect(JEV_PRICE_TABLE.retrieved).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(jevTable).toContain("2026-09-24");
  });

  it("falls back to the generation table when OpenRouter reports no cost; a reported cost wins", () => {
    const usage = new UsageTracker();
    usage.recordGeneration({ inputTokens: 1_000_000, outputTokens: 1_000_000, model: "openai/gpt-4o-mini", task: "form.value" });
    usage.recordGeneration({ inputTokens: 5, outputTokens: 5, model: "openai/gpt-4o-mini", task: "chat.reply", usd: 0.25 });
    const s = usage.snapshot();
    expect(s.generationUsd).toBeCloseTo(0.75 + 0.25, 10);
    expect(s.priced).toBe("full");
    expect(s.priceSource).toEqual([genTable, "provider:openrouter usage.cost"]);
  });

  it("a configured unit price overrides the Jev table; configured model prices override both tables", () => {
    const unit = new UsageTracker({ jevUnitPrice: { unitPriceUsd: 0.01, source: "env:JEVITATE_JEV_UNIT_PRICE_USD" } });
    unit.recordJudgment({ inputTokens: 1_000_000, outputTokens: 0, model: "jev-1.13.0" });
    expect(unit.snapshot()).toMatchObject({ jevUsd: 0.01, priceSource: ["env:JEVITATE_JEV_UNIT_PRICE_USD"] });

    const cfg = new UsageTracker({ modelPrices: { prices: { "acme/x": { inputUsdPerMtok: 1, outputUsdPerMtok: 2 } }, source: "config:c.json usage.modelPrices" } });
    cfg.recordGeneration({ inputTokens: 1_000_000, outputTokens: 1_000_000, model: "acme/x" });
    expect(cfg.snapshot()).toMatchObject({ generationUsd: 3, priced: "full", priceSource: ["config:c.json usage.modelPrices"] });
  });

  it("an unknown model gives partial and names the missing model", () => {
    const usage = new UsageTracker();
    usage.recordJudgment({ inputTokens: 1_000_000, outputTokens: 0, model: "jev-1.13.0" });
    usage.recordGeneration({ inputTokens: 10, outputTokens: 10, model: "acme/unknown" });
    const s = usage.snapshot();
    expect(s.priced).toBe("partial");
    expect(s.missing).toEqual(["generation: no price for model acme/unknown"]);
    expect(s.totalUsd).toBeCloseTo(0.042, 10);
    expect(formatUsageLine(s)).toContain("(partial: generation: no price for model acme/unknown)");
  });

  it("fake calls are known to cost nothing: full at $0", () => {
    const usage = new UsageTracker();
    usage.recordJudgment(FAKE_CALL_USAGE);
    usage.recordGeneration({ ...FAKE_CALL_USAGE, task: "form.value" });
    expect(usage.snapshot()).toMatchObject({ judgments: 1, generations: 1, totalUsd: 0, priced: "full" });
  });

  it("a failed attempt with token usage is priced; one without usage is unpriced (partial)", () => {
    const usage = new UsageTracker();
    usage.recordGeneration({ inputTokens: 1_000_000, outputTokens: 0, model: "openai/gpt-4o-mini", failure: "AI_NoObjectGeneratedError" });
    usage.recordGeneration({ inputTokens: 1_000_000, outputTokens: 0, model: "openai/gpt-4o-mini" });
    expect(usage.snapshot()).toMatchObject({ generations: 2, generationUsd: 0.3, priced: "full", failedCalls: 1 });
    usage.recordGeneration({ inputTokens: 0, outputTokens: 0, model: "openai/gpt-4o-mini", failure: "http-500" });
    expect(usage.snapshot()).toMatchObject({ generations: 3, priced: "partial", missing: ["generation: failed attempt(s) reported no usage"] });
  });

  it("totalUsd = jevUsd + generationUsd exactly, and the sidecar lists every call (no prompt content fields)", () => {
    const usage = new UsageTracker();
    usage.recordJudgment({ inputTokens: 100, outputTokens: 1, usd: 0.001, model: "jev-1.13.0" });
    usage.recordJudgment({ inputTokens: 100, outputTokens: 1, usd: 0.002, model: "jev-1.13.0" });
    usage.recordGeneration({ inputTokens: 10, outputTokens: 10, usd: 0.03, model: "openai/gpt-4o-mini", task: "form.value" });
    const s = usage.snapshot();
    expect(s.totalUsd).toBeCloseTo(0.033, 12);
    expect(s.totalUsd).toBe((s.jevUsd ?? 0) + (s.generationUsd ?? 0));
    const side = usageSidecar(usage);
    expect(side.calls.map((c) => [c.seq, c.kind, c.task, c.usd])).toEqual([
      [1, "judgment", undefined, 0.001],
      [2, "judgment", undefined, 0.002],
      [3, "generation", "form.value", 0.03],
    ]);
    for (const c of side.calls) {
      expect(Object.keys(c).sort()).toEqual(expect.arrayContaining(["kind", "ok", "seq", "source"]));
      expect(Object.keys(c).every((k) => ["seq", "kind", "task", "model", "ok", "inputTokens", "outputTokens", "usd", "source", "failure"].includes(k))).toBe(true);
    }
  });

  it("scope() is one run's share of a shared tracker", () => {
    const usage = new UsageTracker();
    usage.recordJudgment({ inputTokens: 1, outputTokens: 0, usd: 1 });
    const run = usage.scope();
    usage.recordJudgment({ inputTokens: 1, outputTokens: 0, usd: 2 });
    expect(run.snapshot()).toMatchObject({ judgments: 1, totalUsd: 2 });
    expect(run.calls()).toHaveLength(1);
    expect(usage.snapshot()).toMatchObject({ judgments: 2, totalUsd: 3 });
  });
});

describe("sumUsage — #163 aggregation across runs", () => {
  it("the aggregate equals the sum of its runs", () => {
    const a = new UsageTracker();
    a.recordJudgment({ inputTokens: 1_000_000, outputTokens: 0, model: "jev-1.13.0" });
    a.recordGeneration({ inputTokens: 10, outputTokens: 10, usd: 0.5, model: "openai/gpt-4o-mini" });
    const b = new UsageTracker();
    b.recordJudgment({ inputTokens: 2_000_000, outputTokens: 0, model: "jev-1.13.0" });
    const [sa, sb] = [a.snapshot(), b.snapshot()];
    const agg = sumUsage([sa, sb]);
    expect(agg).toMatchObject({ runs: 2, judgments: 2, generations: 1, tokens: 3_000_020, priced: "full" });
    expect(agg.jevUsd).toBeCloseTo((sa.jevUsd ?? 0) + (sb.jevUsd ?? 0), 12);
    expect(agg.generationUsd).toBeCloseTo(0.5, 12);
    expect(agg.totalUsd).toBeCloseTo((sa.totalUsd ?? 0) + (sb.totalUsd ?? 0), 12);
  });

  it("a partial run, or a run with no usage, makes the aggregate partial and says why", () => {
    const priced = new UsageTracker();
    priced.recordJudgment({ inputTokens: 1_000_000, outputTokens: 0, model: "jev-1.13.0" });
    const unknown = new UsageTracker();
    unknown.recordJudgment({ inputTokens: 1, outputTokens: 0, model: "jev-9" });
    unknown.recordGeneration({ inputTokens: 1, outputTokens: 0, usd: 0.1 });
    const agg = sumUsage([priced.snapshot(), unknown.snapshot(), undefined]);
    expect(agg.priced).toBe("partial");
    expect(agg.missing).toEqual(["jev: no price for model jev-9", "1 run(s) reported no usage"]);
    expect(sumUsage([priced.snapshot(), undefined], { unreported: "ignore" })).toMatchObject({ priced: "full", unreportedRuns: 1 });
  });

  it("round-trips a persisted usage object (untrusted JSON)", () => {
    const u = new UsageTracker();
    u.recordJudgment({ inputTokens: 1_000_000, outputTokens: 0, model: "jev-1.13.0" });
    const back = usageCountsFrom(JSON.parse(JSON.stringify(u.snapshot())));
    expect(back).toMatchObject({ judgments: 1, jevUsd: 0.042, priced: "full" });
    expect(usageCountsFrom({ judgments: "x" })).toBeUndefined();
  });
});
