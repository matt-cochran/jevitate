import { describe, it, expect } from "vitest";
import {
  envCredentialStore,
  requireKeys,
  MissingCredentialError,
  envAliasesFor,
  resolveJevRoute,
  jevProviderOverride,
  featureKeys,
  JevProviderError,
} from "./index.js";

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

describe("TYPESAFE_JEV_API_KEY env alias (issue #83)", () => {
  it("accepts TYPESAFE_JEV_API_KEY when TYPESAFE_API_KEY is unset", () => {
    const store = envCredentialStore({ TYPESAFE_JEV_API_KEY: "ts-aliased" }, {});
    expect(store.detect("TYPESAFE_API_KEY")).toBe(true);
    expect(store.read("TYPESAFE_API_KEY")).toBe("ts-aliased");
  });
  it("prefers the canonical TYPESAFE_API_KEY over the alias when both are set", () => {
    const store = envCredentialStore({ TYPESAFE_API_KEY: "canonical", TYPESAFE_JEV_API_KEY: "aliased" }, {});
    expect(store.read("TYPESAFE_API_KEY")).toBe("canonical");
  });
  it("trims a padded alias value, and treats a whitespace-only alias as unset", () => {
    expect(envCredentialStore({ TYPESAFE_JEV_API_KEY: "  padded  " }, {}).read("TYPESAFE_API_KEY")).toBe("padded");
    const blank = envCredentialStore({ TYPESAFE_JEV_API_KEY: "   " }, {});
    expect(blank.detect("TYPESAFE_API_KEY")).toBe(false);
  });
  it("has no alias for a key that doesn't declare one", () => {
    expect(envAliasesFor("OPENROUTER_API_KEY")).toEqual([]);
    expect(envAliasesFor("TYPESAFE_API_KEY")).toEqual(["TYPESAFE_JEV_API_KEY"]);
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

describe("Jev route: either key runs judgment (#429)", () => {
  const both = envCredentialStore({}, { TYPESAFE_API_KEY: "ts", OPENROUTER_API_KEY: "or" });
  const orOnly = envCredentialStore({}, { OPENROUTER_API_KEY: "or" });
  const tsOnly = envCredentialStore({}, { TYPESAFE_API_KEY: "ts" });
  const none = envCredentialStore({}, {});

  it("a TypeSafe key alone routes to TypeSafe", () => {
    expect(resolveJevRoute(tsOnly)).toEqual({ provider: "typesafe", key: "TYPESAFE_API_KEY", reason: "precedence" });
  });
  it("an OpenRouter key alone routes to OpenRouter", () => {
    expect(resolveJevRoute(orOnly)).toEqual({ provider: "openrouter", key: "OPENROUTER_API_KEY", reason: "precedence" });
  });
  it("with both keys the TypeSafe key wins", () => {
    expect(resolveJevRoute(both).provider).toBe("typesafe");
  });
  it("an openrouter override beats the TypeSafe key", () => {
    expect(resolveJevRoute(both, "openrouter")).toEqual({ provider: "openrouter", key: "OPENROUTER_API_KEY", reason: "override" });
  });
  it("an override whose key is missing fails closed naming only that key (no quiet switch)", () => {
    expect(() => resolveJevRoute(orOnly, "typesafe")).toThrow(expect.objectContaining({ missing: ["TYPESAFE_API_KEY"], anyOf: false }));
  });
  it("no key: the error names BOTH keys as alternatives", () => {
    expect(() => requireKeys("judgment", none)).toThrow("feature 'judgment' requires one of TYPESAFE_API_KEY or OPENROUTER_API_KEY");
  });
  it("requireKeys(judgment) passes on the OpenRouter key alone", () => {
    expect(requireKeys("judgment", orOnly)).toEqual(["OPENROUTER_API_KEY"]);
  });
  it("featureKeys names the key judgment will use", () => {
    expect(featureKeys("judgment", both, "openrouter")).toEqual(["OPENROUTER_API_KEY"]);
  });
  it("the flag wins over JEVITATE_JEV_PROVIDER", () => {
    expect(jevProviderOverride({ JEVITATE_JEV_PROVIDER: "typesafe" }, "openrouter")).toBe("openrouter");
  });
  it("JEVITATE_JEV_PROVIDER applies when no flag is given", () => {
    expect(jevProviderOverride({ JEVITATE_JEV_PROVIDER: " OpenRouter " })).toBe("openrouter");
  });
  it("an unknown provider is refused, never ignored", () => {
    expect(() => jevProviderOverride({ JEVITATE_JEV_PROVIDER: "anthropic" })).toThrow(JevProviderError);
  });
});
