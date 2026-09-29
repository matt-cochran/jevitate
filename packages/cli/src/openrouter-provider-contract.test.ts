import { describe, expect, it } from "vitest";
import { generateObject, jsonSchema } from "ai";
import { createOpenRouter } from "@openrouter/ai-sdk-provider";
import { openRouterProviderSettings } from "@jevitate/ai-core";

/**
 * Regression (live adversarial run, 2026-09-23): the CLI's OpenRouter seam passed the key as a
 * custom `Authorization` header; the real provider ignores that and reads ONLY `apiKey` (or the
 * env var), so every live generation failed with "OpenRouter API key is missing". This pins the
 * contract against the REAL provider: the key from `openRouterProviderSettings` reaches the wire
 * as the Bearer header. No network — the provider's `fetch` is captured.
 */
describe("OpenRouter provider contract", () => {
  it("sends the gateway key as the Authorization bearer (never needs OPENROUTER_API_KEY)", async () => {
    let auth: string | null = null;
    const fetchSpy: typeof fetch = async (_input, init) => {
      auth = new Headers(init?.headers).get("authorization");
      return new Response(JSON.stringify({ error: { message: "stop here", code: 400 } }), {
        status: 400,
        headers: { "content-type": "application/json" },
      });
    };
    const saved = process.env.OPENROUTER_API_KEY;
    delete process.env.OPENROUTER_API_KEY;
    try {
      const openrouter = createOpenRouter({ ...openRouterProviderSettings("Bearer sk-or-contract"), fetch: fetchSpy });
      await expect(
        generateObject({ model: openrouter("openai/gpt-4o-mini"), schema: jsonSchema<{ a: string }>({ type: "object", properties: { a: { type: "string" } }, required: ["a"] }), prompt: "x", maxRetries: 0 }),
      ).rejects.toThrow();
      expect(auth).toBe("Bearer sk-or-contract");
    } finally {
      if (saved !== undefined) process.env.OPENROUTER_API_KEY = saved;
    }
  });
});
