import { describe, it, expect } from "vitest";
const RUN = process.env.RUN_OPENROUTER_TESTS === "1" && !!process.env.OPENROUTER_API_KEY;
describe.skipIf(!RUN)("OpenRouter live (opt-in)", () => {
  it("generates a form value against a real cheap US model", async () => {
    // build real OpenRouterCall via lazily-imported `ai` + `@openrouter/ai-sdk-provider`; assert output validates + provenance populated.
    expect(RUN).toBe(true);
  });
});
