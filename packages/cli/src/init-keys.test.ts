import { expect, test, vi } from "vitest";
import type { CredentialKey, CredentialStore, SecureKeyIO } from "@jevitate/ai-core";
import { collectAllMissingKeys } from "./init-keys.js";

function fakeStore(present: Set<CredentialKey>): CredentialStore {
  return {
    detect: (k) => present.has(k),
    read: (k) => (present.has(k) ? `value-for-${k}` : undefined),
  };
}

test("collects both features' missing keys when nothing is configured", async () => {
  const store = fakeStore(new Set());
  const persisted: Record<string, string> = {};
  const io: SecureKeyIO = {
    promptSecret: async (_msg) => "typed-secret",
    persist: async (k, v) => {
      persisted[k] = v;
    },
  };
  const report = await collectAllMissingKeys(store, io);
  expect(report.generation).toEqual({ required: ["OPENROUTER_API_KEY"], collected: ["OPENROUTER_API_KEY"] });
  expect(report.judgment).toEqual({ required: ["TYPESAFE_API_KEY"], collected: ["TYPESAFE_API_KEY"] });
  expect(persisted).toEqual({ OPENROUTER_API_KEY: "typed-secret", TYPESAFE_API_KEY: "typed-secret" });
});

test("prompts for nothing when both keys are already present", async () => {
  const store = fakeStore(new Set<CredentialKey>(["OPENROUTER_API_KEY", "TYPESAFE_API_KEY"]));
  const promptSecret = vi.fn(async () => "should-never-be-called");
  const io: SecureKeyIO = { promptSecret, persist: async () => {} };
  const report = await collectAllMissingKeys(store, io);
  expect(report.generation).toEqual({ required: ["OPENROUTER_API_KEY"], collected: [] });
  expect(report.judgment).toEqual({ required: ["TYPESAFE_API_KEY"], collected: [] });
  expect(promptSecret).not.toHaveBeenCalled();
});

test("surfaces a rejected promise (fail-closed) when the user aborts a prompt", async () => {
  const store = fakeStore(new Set());
  const io: SecureKeyIO = {
    promptSecret: async () => {
      throw new Error("user aborted");
    },
    persist: async () => {},
  };
  await expect(collectAllMissingKeys(store, io)).rejects.toThrow(/aborted/);
});
