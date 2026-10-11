import { describe, expect, it } from "vitest";
import { UsageTracker } from "@jevitate/ai-core";
import { openRouterCallWith, type GenerateTextFn } from "./openrouter-call.js";

const provider = () => (model: string) => ({ model });
const args = { model: "openai/gpt-4o-mini", schema: {} as never, body: { task: "form.value" }, authHeader: "Bearer sk-or-secret", task: "form.value" };

/** A stub seam that records the settings it was called with and resolves the given result slice. */
function stub(result: { output?: unknown; usage?: unknown; providerMetadata?: unknown } = { output: { text: "x" } }): { gen: GenerateTextFn; seen: Array<Record<string, unknown>> } {
  const seen: Array<Record<string, unknown>> = [];
  return { gen: async (a) => { seen.push(a); return result; }, seen };
}

describe("openRouterCallWith — structured output via generateText (#489)", () => {
  it("returns the object parsed by the generateText output field", async () => {
    const result = await openRouterCallWith(stub({ output: { text: "x" } }).gen, provider)(args);
    expect(result.object).toEqual({ text: "x" });
  });

  it("disables the SDK's hidden retries", async () => {
    const { gen, seen } = stub();
    await openRouterCallWith(gen, provider)(args);
    expect(seen[0]?.maxRetries).toBe(0);
  });

  it("requests OpenRouter usage accounting in providerOptions", async () => {
    const { gen, seen } = stub();
    await openRouterCallWith(gen, provider)(args);
    expect(seen[0]?.providerOptions).toEqual({ openrouter: { usage: { include: true } } });
  });

  it("passes a pinned temperature through to the model call", async () => {
    const { gen, seen } = stub();
    await openRouterCallWith(gen, provider)({ ...args, temperature: 0 });
    expect(seen[0]?.temperature).toBe(0);
  });
});

describe("openRouterCallWith — #163 every generation attempt is accounted", () => {
  it("records the provider-reported cost with task and model for a successful call", async () => {
    const usage = new UsageTracker();
    await openRouterCallWith(stub({ output: { text: "x" }, usage: { inputTokens: 120, outputTokens: 7 }, providerMetadata: { openrouter: { usage: { cost: 0.0042 } } } }).gen, provider, usage)(args);
    expect(usage.calls()).toEqual([
      { seq: 1, kind: "generation", task: "form.value", model: "openai/gpt-4o-mini", ok: true, inputTokens: 120, outputTokens: 7, usd: 0.0042, source: "provider:openrouter usage.cost" },
    ]);
  });

  it("prices a successful call from the per-model table when no cost is reported", async () => {
    const usage = new UsageTracker();
    await openRouterCallWith(stub({ output: { text: "x" }, usage: { inputTokens: 1_000_000, outputTokens: 1_000_000 } }).gen, provider, usage)(args);
    expect(usage.snapshot()).toMatchObject({ generationUsd: 0.75, priced: "full" });
  });

  it("never persists a failed attempt's error message", async () => {
    const usage = new UsageTracker();
    const invalid: GenerateTextFn = async () => {
      throw Object.assign(new Error("No object generated: response did not match schema, text=sk-or-secret"), { name: "AI_NoObjectGeneratedError", usage: { inputTokens: 1_000_000, outputTokens: 0 } });
    };
    await openRouterCallWith(invalid, provider, usage)(args).catch(() => undefined);
    expect(JSON.stringify(usage.calls())).not.toContain("sk-or-secret");
  });

  it("records a failed attempt that reported usage as a priced generation call", async () => {
    const usage = new UsageTracker();
    const invalid: GenerateTextFn = async () => {
      throw Object.assign(new Error("No object generated"), { name: "AI_NoObjectGeneratedError", usage: { inputTokens: 1_000_000, outputTokens: 0 } });
    };
    await openRouterCallWith(invalid, provider, usage)(args).catch(() => undefined);
    expect(usage.calls()[0]?.usd).toBe(0.15);
  });

  it("records a failed attempt that reported no usage as unpriced", async () => {
    const usage = new UsageTracker();
    const http: GenerateTextFn = async () => {
      throw Object.assign(new Error("Service Unavailable"), { statusCode: 503 });
    };
    await openRouterCallWith(http, provider, usage)(args).catch(() => undefined);
    expect(usage.calls()[0]?.usd).toBeUndefined();
  });

  it("propagates a generation failure to the caller", async () => {
    const invalid: GenerateTextFn = async () => {
      throw new Error("No object generated");
    };
    await expect(openRouterCallWith(invalid, provider)(args)).rejects.toThrow(/No object generated/);
  });
});
