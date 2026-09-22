import { describe, it, expect } from "vitest";
import {
  envCredentialStore,
  assertNoOutboundCredential,
  CredentialLeakError,
  assertNoSecretInPayload,
  SecretLeakError,
} from "./index.js";

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

describe("assertNoSecretInPayload (general user-secret never-to-model choke point)", () => {
  const secrets = ["hunter2", "otp-998877"];
  it("passes when no registered secret appears in the payload", () => {
    expect(() => assertNoSecretInPayload(
      { goal: "sign in", controls: ["textbox Username", "button Sign in"] }, secrets,
    )).not.toThrow();
  });
  it("passes with an empty secret list (nothing to enforce)", () => {
    expect(() => assertNoSecretInPayload({ anything: "goes" }, [])).not.toThrow();
  });
  it("ignores blank/empty secret entries (a '' would match everything)", () => {
    expect(() => assertNoSecretInPayload({ prompt: "totally fine" }, ["", "   "])).not.toThrow();
  });
  it("REFUSES a payload that embeds a registered secret value", () => {
    expect(() => assertNoSecretInPayload(
      { fieldValue: "hunter2" }, secrets,
    )).toThrow(SecretLeakError);
  });
  it("REFUSES a stringified payload that embeds a secret", () => {
    expect(() => assertNoSecretInPayload("the otp is otp-998877 right now", secrets)).toThrow(
      SecretLeakError,
    );
  });
  it("does not disclose the secret value (or its length) in the error message", () => {
    try {
      assertNoSecretInPayload("...hunter2...", secrets);
    } catch (e) {
      expect((e as Error).message).not.toContain("hunter2");
      expect((e as Error).message).not.toContain("7"); // not even the length
    }
  });
});
