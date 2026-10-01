import { expect, test } from "vitest";
import { ProfileManager } from "@jevitate/daemon";
import type { CliDeps } from "./program.js";
import { buildProgram } from "./program.js";
import { realSecureIO } from "./ai-cli.js";

test("realSecureIO is exported so jevitate init can reuse the same masked-prompt implementation", () => {
  expect(typeof realSecureIO).toBe("function");
  const io = realSecureIO();
  expect(typeof io.promptSecret).toBe("function");
  expect(typeof io.persist).toBe("function");
});

/**
 * Mirrors journey-cli.test.ts's isolation rationale: browser-free, fast,
 * separate from program.test.ts's known flake.
 */

function newProgram(aiDeps?: CliDeps["ai"]) {
  const profiles = new ProfileManager("/unused-in-these-tests");
  const lines: string[] = [];
  // Hermetic by default: the real store falls back to ~/.jevitate/credentials.json, so a test that
  // does not inject `localConfig` would read whatever keys the developer's machine has saved.
  // #291: the live key check is stubbed (every key "valid") — a test never touches the network.
  const verifyFetch = async () => ({ status: 200 });
  const ai = aiDeps ? { localConfig: {}, verifyFetch, ...aiDeps } : { localConfig: {}, verifyFetch };
  const program = buildProgram({ profiles, ai });
  program.configureOutput({ writeOut: (s) => lines.push(s) });
  program.exitOverride();
  return { program, lines };
}

test("ai status --json reports generation/judgment as missing when env is empty (names only)", async () => {
  const { program, lines } = newProgram({ env: {} });
  await program.parseAsync(["ai", "status", "--json"], { from: "user" });
  const parsed = JSON.parse(lines.join(""));

  expect(parsed.ok).toBe(true);
  expect(parsed.data).toMatchObject({
    generation: { required: ["OPENROUTER_API_KEY"], missing: ["OPENROUTER_API_KEY"] },
    judgment: { required: ["TYPESAFE_API_KEY"], missing: ["TYPESAFE_API_KEY"] },
  });
  // never leaks a value, even if one happened to be set alongside others
  expect(lines.join("")).not.toMatch(/sk-|ts-/);
});

test("ai status --json reports a feature as satisfied when its key is present", async () => {
  const { program, lines } = newProgram({ env: { OPENROUTER_API_KEY: "sk-or-should-not-appear" } });
  await program.parseAsync(["ai", "status", "--json"], { from: "user" });
  const parsed = JSON.parse(lines.join(""));

  expect(parsed.data.generation).toMatchObject({ required: ["OPENROUTER_API_KEY"], missing: [] });
  expect(lines.join("")).not.toContain("sk-or-should-not-appear");
});

test("ai generate form.value --fake --json prints an ok envelope from the fake gateway with a deterministic responseHash", async () => {
  const { program, lines } = newProgram({ env: {} });
  const input = JSON.stringify({ fieldLabel: "email", goal: "log in", visibleContext: "form", history: [] });

  await program.parseAsync(["ai", "generate", "form.value", "--input", input, "--fake", "--json"], { from: "user" });
  const first = JSON.parse(lines.join(""));
  expect(first.ok).toBe(true);
  expect(first.data.provenance.adapter).toBe("fake");
  const hash1 = first.data.provenance.responseHash;

  const { program: program2, lines: lines2 } = newProgram({ env: {} });
  await program2.parseAsync(["ai", "generate", "form.value", "--input", input, "--fake", "--json"], { from: "user" });
  const second = JSON.parse(lines2.join(""));
  expect(second.data.provenance.responseHash).toBe(hash1);
});

test("ai generate with neither --real nor --fake and no key fails closed with E_AI_SETUP_REQUIRED (no silent fake default)", async () => {
  const { program, lines } = newProgram({ env: {} });
  const input = JSON.stringify({ fieldLabel: "email", goal: "log in", visibleContext: "form", history: [] });

  await program.parseAsync(["ai", "generate", "form.value", "--input", input, "--json"], { from: "user" });
  const parsed = JSON.parse(lines.join(""));

  expect(parsed.ok).toBe(false);
  expect(parsed.error.code).toBe("E_AI_SETUP_REQUIRED");
  expect(parsed.error.message).toMatch(/ai setup|--fake/);
});

test("ai generate with neither --real nor --fake but a key configured still fails closed (explicit choice required)", async () => {
  const { program, lines } = newProgram({ env: { OPENROUTER_API_KEY: "sk-or-configured" } });
  const input = JSON.stringify({ fieldLabel: "email", goal: "log in", visibleContext: "form", history: [] });

  await program.parseAsync(["ai", "generate", "form.value", "--input", input, "--json"], { from: "user" });
  const parsed = JSON.parse(lines.join(""));

  expect(parsed.ok).toBe(false);
  expect(parsed.error.code).toBe("E_AI_SETUP_REQUIRED");
  expect(lines.join("")).not.toContain("sk-or-configured");
});

test("ai generate --real sanitizes a provider error so the raw message (and any embedded key) never reaches the CLI envelope", async () => {
  const gateway = {
    generate: async () => {
      throw new Error("upstream 401: Authorization: Bearer sk-or-FAKE-LEAK-KEY rejected");
    },
  };
  const { program, lines } = newProgram({ env: { OPENROUTER_API_KEY: "sk-or-FAKE-LEAK-KEY" }, gateway });
  const input = JSON.stringify({ fieldLabel: "email", goal: "log in", visibleContext: "form", history: [] });

  await program.parseAsync(["ai", "generate", "form.value", "--input", input, "--real", "--json"], { from: "user" });
  const parsed = JSON.parse(lines.join(""));

  expect(parsed.ok).toBe(false);
  expect(parsed.error.code).toBe("E_AI_GENERATE");
  expect(lines.join("")).not.toContain("sk-or-FAKE-LEAK-KEY");
  expect(parsed.error.message).not.toContain("Authorization");
});

test("ai setup generation persists the prompted key via an injected secure IO without echoing it", async () => {
  const persisted: Array<{ key: string; value: string }> = [];
  const secureIO = {
    promptSecret: async () => "sk-or-collected-secret",
    persist: async (key: string, value: string) => {
      persisted.push({ key, value });
    },
  };
  const { program, lines } = newProgram({ env: {}, secureIO });
  await program.parseAsync(["ai", "setup", "generation", "--json"], { from: "user" });
  const parsed = JSON.parse(lines.join(""));

  expect(parsed.ok).toBe(true);
  expect(persisted).toEqual([{ key: "OPENROUTER_API_KEY", value: "sk-or-collected-secret" }]);
  expect(lines.join("")).not.toContain("sk-or-collected-secret");
});
