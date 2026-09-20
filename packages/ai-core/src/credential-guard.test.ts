import { describe, it, expect } from "vitest";
import { envCredentialStore, assertNoOutboundCredential, CredentialLeakError } from "./index.js";

const store = envCredentialStore({ OPENROUTER_API_KEY: "sk-or-LEAKME-123" }, {});

describe("assertNoOutboundCredential (floor #6 never-to-model)", () => {
  it("passes when the payload contains no key value", () => {
    expect(() => assertNoOutboundCredential(
      { prompt: "draft a reply", meta: { model: "x/y" } }, store,
    )).not.toThrow();
  });
  it("REFUSES a payload that embeds the key value (prompt/tool-arg/log/telemetry)", () => {
    expect(() => assertNoOutboundCredential(
      { prompt: "use sk-or-LEAKME-123 to auth" }, store,
    )).toThrow(CredentialLeakError);
  });
  it("does not disclose the value in the error message", () => {
    try { assertNoOutboundCredential("...sk-or-LEAKME-123...", store); }
    catch (e) { expect((e as Error).message).not.toContain("sk-or-LEAKME-123"); }
  });
});
