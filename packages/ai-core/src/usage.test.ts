import { describe, expect, it } from "vitest";
import { UsageTracker } from "./usage.js";

describe("UsageTracker — #100 usage accounting", () => {
  it("starts at zero counts, no usd", () => {
    expect(new UsageTracker().snapshot()).toEqual({ judgments: 0, generations: 0, inputTokens: 0, outputTokens: 0 });
  });

  it("accumulates judgments and generations separately, tokens together", () => {
    const usage = new UsageTracker();
    usage.recordJudgment({ inputTokens: 10, outputTokens: 2 });
    usage.recordJudgment({ inputTokens: 5, outputTokens: 1 });
    usage.recordGeneration({ inputTokens: 100, outputTokens: 20 });
    expect(usage.snapshot()).toEqual({ judgments: 2, generations: 1, inputTokens: 115, outputTokens: 23 });
  });

  it("usd is absent until a call reports one, then accumulates only the reported calls' cost", () => {
    const usage = new UsageTracker();
    usage.recordGeneration({ inputTokens: 1, outputTokens: 1 });
    expect(usage.snapshot().usd).toBeUndefined();
    usage.recordGeneration({ inputTokens: 1, outputTokens: 1, usd: 0.002 });
    usage.recordGeneration({ inputTokens: 1, outputTokens: 1 }); // no cost reported this time — never estimated
    usage.recordGeneration({ inputTokens: 1, outputTokens: 1, usd: 0.0035 });
    expect(usage.snapshot().usd).toBeCloseTo(0.0055, 10);
  });

  it("judgments never contribute usd (only generations can report a provider cost)", () => {
    const usage = new UsageTracker();
    usage.recordJudgment({ inputTokens: 10, outputTokens: 10 });
    expect(usage.snapshot().usd).toBeUndefined();
  });
});
