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

describe("envCredentialStore.read (trims on read)", () => {
  it("trims a padded key so it never produces a malformed Bearer header", () => {
    const store = envCredentialStore({ OPENROUTER_API_KEY: "  key  " }, {});
    expect(store.read("OPENROUTER_API_KEY")).toBe("key");
  });
  it("treats a whitespace-only value as ABSENT, not as an empty/padded key", () => {
    const store = envCredentialStore({ OPENROUTER_API_KEY: "   " }, {});
    expect(store.read("OPENROUTER_API_KEY")).toBeUndefined();
    expect(store.detect("OPENROUTER_API_KEY")).toBe(false);
  });
  it("trims a padded localConfig fallback value too", () => {
    const store = envCredentialStore({}, { OPENROUTER_API_KEY: "  key  " });
    expect(store.read("OPENROUTER_API_KEY")).toBe("key");
  });
});
