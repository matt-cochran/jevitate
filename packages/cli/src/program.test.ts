import { expect, test } from "vitest";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ProfileManager } from "@doit/daemon";
import { buildProgram } from "./program.js";

test("profile create prints a success envelope", async () => {
  const root = await mkdtemp(join(tmpdir(), "doit-cli-"));
  const profiles = new ProfileManager(root);
  const lines: string[] = [];
  const program = buildProgram({ profiles });
  program.configureOutput({ writeOut: (s) => lines.push(s) });
  program.exitOverride();
  await program.parseAsync(["profile", "create", "main", "--json"], { from: "user" });
  const parsed = JSON.parse(lines.join(""));
  expect(parsed).toMatchObject({ v: 1, ok: true, data: { name: "main", exists: true } });
});

test("profile create prints a failure envelope and sets exit code 1 when the action throws", async () => {
  const savedExitCode = process.exitCode;
  try {
    const profiles = {
      create: async () => {
        throw new Error("boom");
      },
      status: async () => {
        throw new Error("not used");
      },
    } as unknown as ProfileManager;
    const lines: string[] = [];
    const program = buildProgram({ profiles });
    program.configureOutput({ writeOut: (s) => lines.push(s) });
    program.exitOverride();
    await program.parseAsync(["profile", "create", "x", "--json"], { from: "user" });
    const parsed = JSON.parse(lines.join(""));
    expect(parsed).toMatchObject({
      v: 1,
      ok: false,
      error: { code: "E_PROFILE_CREATE", message: expect.stringContaining("boom") },
    });
    expect(process.exitCode).toBe(1);
  } finally {
    process.exitCode = savedExitCode;
  }
});
