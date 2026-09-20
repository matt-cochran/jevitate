import { describe, it, expect } from "vitest";
import { envCredentialStore, requireKeys, MissingCredentialError } from "./index.js";

describe("requireKeys (fail-closed)", () => {
  it("throws MissingCredentialError naming the missing key when absent", () => {
    const store = envCredentialStore({}, {});
    expect(() => requireKeys("generation", store)).toThrow(MissingCredentialError);
    try { requireKeys("generation", store); } catch (e) {
      expect((e as MissingCredentialError).missing).toEqual(["OPENROUTER_API_KEY"]);
    }
  });
  it("passes when the key is set in env, and returns names (not values)", () => {
    const store = envCredentialStore({ OPENROUTER_API_KEY: "sk-or-secret" }, {});
    expect(requireKeys("generation", store)).toEqual(["OPENROUTER_API_KEY"]);
  });
  it("reads from local config when env is empty; blank env is treated as unset", () => {
    const store = envCredentialStore({ TYPESAFE_API_KEY: "  " }, { TYPESAFE_API_KEY: "ts-key" });
    expect(store.detect("TYPESAFE_API_KEY")).toBe(true);
    expect(requireKeys("judgment", store)).toEqual(["TYPESAFE_API_KEY"]);
  });
});
