import { describe, it, expect, vi } from "vitest";
import { OpenRouterGenerationGateway, envCredentialStore, MissingCredentialError, type OpenRouterCall } from "./index.js";

const catalog = [{ id: "b/cheap-us", promptUsdPer1k: 0.1, completionUsdPer1k: 0.1, regions: ["US"], latencyClass: "fast" as const, capabilities: [] }];
const constraints = { requireRegion: "US", maxPromptUsdPer1k: 1, requiredCapabilities: [] };
const input = { fieldLabel: "email", goal: "log in", visibleContext: "form", history: [] };

it("refuses when the key is absent (fail-closed)", async () => {
  const g = new OpenRouterGenerationGateway({ store: envCredentialStore({}, {}), catalog, constraints, call: vi.fn() as unknown as OpenRouterCall });
  await expect(g.generate("form.value", input)).rejects.toBeInstanceOf(MissingCredentialError);
});

it("sends no key in the body, puts it only in the auth header, and records provenance", async () => {
  const store = envCredentialStore({ OPENROUTER_API_KEY: "sk-or-SECRET" }, {});
  const call: OpenRouterCall = async (args) => {
    expect(JSON.stringify(args.body)).not.toContain("sk-or-SECRET"); // never-to-model
    expect(args.authHeader).toBe("Bearer sk-or-SECRET");
    expect(args.model).toBe("b/cheap-us");
    return { object: { text: "hi" }, latencyMs: 12 };
  };
  const g = new OpenRouterGenerationGateway({ store, catalog, constraints, call });
  const res = await g.generate("form.value", input);
  expect(res.output).toEqual({ text: "hi" });
  expect(res.provenance.model).toBe("b/cheap-us");
  expect(JSON.stringify(res.provenance)).not.toContain("sk-or-SECRET");
});

it("throws when the model's returned object fails the task schema", async () => {
  const store = envCredentialStore({ OPENROUTER_API_KEY: "sk-or-SECRET" }, {});
  const call: OpenRouterCall = async () => ({ object: { wrong: 1 }, latencyMs: 1 });
  const g = new OpenRouterGenerationGateway({ store, catalog, constraints, call });
  await expect(g.generate("form.value", input)).rejects.toBeTruthy();
});
