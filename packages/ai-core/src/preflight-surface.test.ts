import { describe, it, expect, vi } from "vitest";
import {
  withPreflight,
  collectMissingKeys,
  envCredentialStore,
  type SecureKeyIO,
  type SetupRequiredResult,
} from "./index.js";

describe("withPreflight", () => {
  it("returns a setup_required result naming the missing key and never calls handler", async () => {
    const store = envCredentialStore({}, {});
    const handler = vi.fn(async () => ({ text: "should not run" }));
    const wrapped = withPreflight("generation", store, handler);
    const result = (await wrapped()) as SetupRequiredResult;
    expect(result).toEqual({
      ok: false,
      precondition: "setup_required",
      feature: "generation",
      missing: ["OPENROUTER_API_KEY"],
      hint: expect.stringContaining("OPENROUTER_API_KEY"),
    });
    expect(handler).not.toHaveBeenCalled();
  });

  it("calls handler and returns its value when the key is present", async () => {
    const store = envCredentialStore({ OPENROUTER_API_KEY: "sk-or-x" }, {});
    const handler = vi.fn(async () => ({ text: "ok" }));
    const wrapped = withPreflight("generation", store, handler);
    const result = await wrapped();
    expect(result).toEqual({ text: "ok" });
    expect(handler).toHaveBeenCalledTimes(1);
  });
});

describe("collectMissingKeys (out-of-band CLI collection)", () => {
  it("prompts and persists once per missing key without echoing the value", async () => {
    const store = envCredentialStore({}, {});
    const promptSecret = vi.fn(async () => "sk-or-collected");
    const persist = vi.fn(async () => {});
    const io: SecureKeyIO = { promptSecret, persist };
    const missing = await collectMissingKeys("generation", store, io);
    expect(missing).toEqual(["OPENROUTER_API_KEY"]);
    expect(promptSecret).toHaveBeenCalledTimes(1);
    expect(persist).toHaveBeenCalledWith("OPENROUTER_API_KEY", "sk-or-collected");
  });

  it("throws (fail-closed) on blank input and does not persist", async () => {
    const store = envCredentialStore({}, {});
    const io: SecureKeyIO = { promptSecret: vi.fn(async () => "   "), persist: vi.fn(async () => {}) };
    await expect(collectMissingKeys("generation", store, io)).rejects.toThrow(/not provided/);
    expect(io.persist).not.toHaveBeenCalled();
  });
});
