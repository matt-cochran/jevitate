import { Writable } from "node:stream";
import { expect, test } from "vitest";
import { ProfileManager } from "@jevitate/daemon";
import type { CliDeps } from "./program.js";
import { buildProgram } from "./program.js";
import { createMutableEcho } from "./ai-cli.js";

/**
 * Mirrors journey-cli.test.ts's isolation rationale: browser-free, fast,
 * separate from program.test.ts's known flake.
 */

function newProgram(aiDeps?: CliDeps["ai"]) {
  const profiles = new ProfileManager("/unused-in-these-tests");
  const lines: string[] = [];
  const program = buildProgram({ profiles, ai: aiDeps });
  program.configureOutput({ writeOut: (s) => lines.push(s) });
  program.exitOverride();
  return { program, lines };
}

test("ai status --json reports generation/judgment as missing when env is empty (names only)", async () => {
  const { program, lines } = newProgram({ env: {} });
  await program.parseAsync(["ai", "status", "--json"], { from: "user" });
  const parsed = JSON.parse(lines.join(""));

  expect(parsed.ok).toBe(true);
  expect(parsed.data).toEqual({
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

  expect(parsed.data.generation).toEqual({ required: ["OPENROUTER_API_KEY"], missing: [] });
  expect(lines.join("")).not.toContain("sk-or-should-not-appear");
});

test("ai generate form.value --json prints an ok envelope from the fake gateway with a deterministic responseHash", async () => {
  const { program, lines } = newProgram({ env: {} });
  const input = JSON.stringify({ fieldLabel: "email", goal: "log in", visibleContext: "form", history: [] });

  await program.parseAsync(["ai", "generate", "form.value", "--input", input, "--json"], { from: "user" });
  const first = JSON.parse(lines.join(""));
  expect(first.ok).toBe(true);
  expect(first.data.provenance.adapter).toBe("fake");
  const hash1 = first.data.provenance.responseHash;

  const { program: program2, lines: lines2 } = newProgram({ env: {} });
  await program2.parseAsync(["ai", "generate", "form.value", "--input", input, "--json"], { from: "user" });
  const second = JSON.parse(lines2.join(""));
  expect(second.data.provenance.responseHash).toBe(hash1);
});

/**
 * I1 fix verification: `realSecureIO.promptSecret` wires `createMutableEcho`
 * as readline's internal output hook (`_writeToOutput`) and mutes it for the
 * entire duration the user is typing the secret — this is the actual
 * mechanism that decides whether typed characters get echoed to the
 * terminal. Per-keystroke readline/TTY behavior can't be faithfully
 * simulated outside a real terminal in a non-interactive test runner, so
 * this exercises the gate directly: writes made while muted never reach the
 * underlying stream (the secret, however it's chunked), while writes made
 * before muting / after unmuting (the prompt text, the trailing newline) do.
 */
test("createMutableEcho suppresses writes while muted and passes them through otherwise", () => {
  const written: string[] = [];
  const sink = new Writable({
    write(chunk, _enc, cb) {
      written.push(chunk.toString());
      cb();
    },
  });
  const echo = createMutableEcho(sink);

  echo.write("Enter OPENROUTER_API_KEY: ");
  echo.mute();
  for (const ch of "sk-or-super-secret-value") echo.write(ch);
  echo.unmute();
  echo.write("\n");

  expect(written.join("")).toBe("Enter OPENROUTER_API_KEY: \n");
  expect(written.join("")).not.toContain("sk-or-super-secret-value");
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
