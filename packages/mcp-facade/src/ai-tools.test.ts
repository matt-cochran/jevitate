import { describe, it, expect } from "vitest";
import { envCredentialStore, FakeGenerationGateway } from "@doit/ai-core";
import { aiGenerateText } from "./index.js";

const input = { fieldLabel: "email", goal: "log in", visibleContext: "form" };

describe("aiGenerateText (preflight-gated MCP tool)", () => {
  it("returns a setup_required result naming the missing key when the store is empty", async () => {
    const store = envCredentialStore({}, {});
    const gateway = new FakeGenerationGateway();
    const result = await aiGenerateText(store, gateway, input);
    expect(result).toEqual({
      ok: false,
      precondition: "setup_required",
      feature: "generation",
      missing: ["OPENROUTER_API_KEY"],
      hint: expect.stringContaining("OPENROUTER_API_KEY"),
    });
  });

  it("returns the generated text when the key is present and a fake gateway is injected", async () => {
    const store = envCredentialStore({ OPENROUTER_API_KEY: "sk-or-x" }, {});
    const gateway = new FakeGenerationGateway();
    const result = await aiGenerateText(store, gateway, input);
    expect(result).toEqual({ ok: true, text: "value:email" });
  });
});
