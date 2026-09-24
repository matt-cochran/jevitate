import { describe, expect, it } from "vitest";
import { UsageTracker } from "./usage.js";

describe("UsageTracker — #100 usage accounting", () => {
  it("starts at zero counts, unpriced", () => {
    expect(new UsageTracker().snapshot()).toEqual({ judgments: 0, generations: 0, inputTokens: 0, outputTokens: 0, priced: "none" });
  });

  it("accumulates judgments and generations separately, tokens together", () => {
    const usage = new UsageTracker();
    usage.recordJudgment({ inputTokens: 10, outputTokens: 2 });
    usage.recordJudgment({ inputTokens: 5, outputTokens: 1 });
    usage.recordGeneration({ inputTokens: 100, outputTokens: 20 });
    expect(usage.snapshot()).toEqual({ judgments: 2, generations: 1, inputTokens: 115, outputTokens: 23, priced: "none" });
  });

  it("generationUsd is absent until a call reports one, then accumulates only the reported calls' cost", () => {
    const usage = new UsageTracker();
    usage.recordGeneration({ inputTokens: 1, outputTokens: 1 });
    expect(usage.snapshot().generationUsd).toBeUndefined();
    usage.recordGeneration({ inputTokens: 1, outputTokens: 1, usd: 0.002 });
    usage.recordGeneration({ inputTokens: 1, outputTokens: 1 }); // no cost reported this time — never estimated
    usage.recordGeneration({ inputTokens: 1, outputTokens: 1, usd: 0.0035 });
    const s = usage.snapshot();
    expect(s.generationUsd).toBeCloseTo(0.0055, 10);
    expect(s.totalUsd).toBeCloseTo(0.0055, 10);
    expect(s.usd).toBeCloseTo(0.0055, 10); // #100 compat alias
    // Generation-only, provider-priced, no judgments to price: fully priced.
    expect(s.priced).toBe("full");
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

  it("a provider-reported judgment cost wins over the configured unit price, and carries no price-source label", () => {
    const usage = new UsageTracker({ unitPriceUsd: 1, source: "config:~/.jevitate/config.json usage.jevUnitPriceUsd" });
    usage.recordJudgment({ inputTokens: 10, outputTokens: 10, usd: 0.001 });
    usage.recordJudgment({ inputTokens: 10, outputTokens: 10, usd: 0.002 });
    const s = usage.snapshot();
    expect(s.jevUsd).toBeCloseTo(0.003, 10);
    expect(s.jevPriceSource).toBeUndefined();
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
