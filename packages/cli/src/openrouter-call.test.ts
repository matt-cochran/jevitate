import { describe, expect, it } from "vitest";
import { UsageTracker } from "@jevitate/ai-core";
import { openRouterCallWith, type GenerateObjectFn } from "./openrouter-call.js";

const provider = () => (model: string) => ({ model });
const args = { model: "openai/gpt-4o-mini", schema: {} as never, body: { task: "form.value" }, authHeader: "Bearer sk-or-secret", task: "form.value" };

describe("openRouterCallWith — #163 every generation attempt is accounted", () => {
  it("records the provider-reported cost with task and model, and disables the SDK's hidden retries", async () => {
    const seen: Array<Record<string, unknown>> = [];
    const gen: GenerateObjectFn = async (a) => {
      seen.push(a);
      return { object: { text: "x" }, usage: { inputTokens: 120, outputTokens: 7 }, providerMetadata: { openrouter: { usage: { cost: 0.0042 } } } };
    };
    const usage = new UsageTracker();
    await openRouterCallWith(gen, provider, usage)(args);
    expect(seen[0]?.maxRetries).toBe(0);
    expect(usage.calls()).toEqual([
      { seq: 1, kind: "generation", task: "form.value", model: "openai/gpt-4o-mini", ok: true, inputTokens: 120, outputTokens: 7, usd: 0.0042, source: "provider:openrouter usage.cost" },
    ]);
  });

  it("with no reported cost, prices from the per-model table", async () => {
    const gen: GenerateObjectFn = async () => ({ object: { text: "x" }, usage: { inputTokens: 1_000_000, outputTokens: 1_000_000 } });
    const usage = new UsageTracker();
    await openRouterCallWith(gen, provider, usage)(args);
    expect(usage.snapshot()).toMatchObject({ generationUsd: 0.75, priced: "full" });
  });

  it("a failed attempt is recorded (its reported tokens priced; an error message never kept) and rethrown", async () => {
    const usage = new UsageTracker();
    const invalid: GenerateObjectFn = async () => {
      throw Object.assign(new Error("No object generated: response did not match schema, text=sk-or-secret"), { name: "AI_NoObjectGeneratedError", usage: { inputTokens: 1_000_000, outputTokens: 0 } });
    };
    await expect(openRouterCallWith(invalid, provider, usage)(args)).rejects.toThrow(/No object generated/);
    const http: GenerateObjectFn = async () => {
      throw Object.assign(new Error("Service Unavailable"), { statusCode: 503 });
    };
    await expect(openRouterCallWith(http, provider, usage)(args)).rejects.toThrow("Service Unavailable");
    const calls = usage.calls();
    expect(calls.map((c) => [c.ok, c.failure, c.usd])).toEqual([
      [false, "AI_NoObjectGeneratedError", 0.15],
      [false, "http-503", undefined],
    ]);
    expect(JSON.stringify(calls)).not.toContain("sk-or-secret");
    expect(usage.snapshot()).toMatchObject({ generations: 2, failedCalls: 2, priced: "partial", missing: ["generation: failed attempt(s) reported no usage"] });
  });
});
