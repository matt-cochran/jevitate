import { expect, test } from "vitest";
import { mkdtemp, writeFile } from "node:fs/promises";
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

test("site policy set then site policy get --json round-trips via a temp --db", async () => {
  const root = await mkdtemp(join(tmpdir(), "doit-cli-"));
  const profiles = new ProfileManager(root);
  const dbPath = join(root, "db.sqlite");
  const policyPath = join(root, "policy.json");
  const policy = {
    version: "1",
    interaction: { typing: { charsPerSecond: 5, perKeyJitter: 0.1 } },
  };
  await writeFile(policyPath, JSON.stringify(policy));

  const setLines: string[] = [];
  const setProgram = buildProgram({ profiles });
  setProgram.configureOutput({ writeOut: (s) => setLines.push(s) });
  setProgram.exitOverride();
  await setProgram.parseAsync(
    ["site", "policy", "set", "example.com", "--file", policyPath, "--db", dbPath, "--json"],
    { from: "user" }
  );
  const setParsed = JSON.parse(setLines.join(""));
  expect(setParsed).toMatchObject({ v: 1, ok: true, data: { site: "example.com", version: "1" } });

  const getLines: string[] = [];
  const getProgram = buildProgram({ profiles });
  getProgram.configureOutput({ writeOut: (s) => getLines.push(s) });
  getProgram.exitOverride();
  await getProgram.parseAsync(
    ["site", "policy", "get", "example.com", "--db", dbPath, "--json"],
    { from: "user" }
  );
  const getParsed = JSON.parse(getLines.join(""));
  expect(getParsed).toMatchObject({ v: 1, ok: true, data: { version: "1" } });
});

test("site policy get --json succeeds when the --db parent directory does not yet exist", async () => {
  const root = await mkdtemp(join(tmpdir(), "doit-cli-"));
  const profiles = new ProfileManager(root);
  // Only `root` exists; `nested/subdir` must be created by the command itself,
  // matching ProfileManager.create()'s mkdir(dir, { recursive: true }) pattern.
  const dbPath = join(root, "nested", "subdir", "db.sqlite");

  const lines: string[] = [];
  const program = buildProgram({ profiles });
  program.configureOutput({ writeOut: (s) => lines.push(s) });
  program.exitOverride();
  await program.parseAsync(
    ["site", "policy", "get", "example.com", "--db", dbPath, "--json"],
    { from: "user" }
  );
  const parsed = JSON.parse(lines.join(""));
  expect(parsed).toMatchObject({ v: 1, ok: true, data: null });
});

test("site policy get --json reports null data when no policy is stored", async () => {
  const root = await mkdtemp(join(tmpdir(), "doit-cli-"));
  const profiles = new ProfileManager(root);
  const dbPath = join(root, "db.sqlite");

  const lines: string[] = [];
  const program = buildProgram({ profiles });
  program.configureOutput({ writeOut: (s) => lines.push(s) });
  program.exitOverride();
  await program.parseAsync(
    ["site", "policy", "get", "nosite.com", "--db", dbPath, "--json"],
    { from: "user" }
  );
  const parsed = JSON.parse(lines.join(""));
  expect(parsed).toMatchObject({ v: 1, ok: true, data: null });
});

test("site simulate prints a timing profile with totalMs, using an empty interaction when no policy is stored", async () => {
  const root = await mkdtemp(join(tmpdir(), "doit-cli-"));
  const profiles = new ProfileManager(root);
  const dbPath = join(root, "db.sqlite");
  const scriptPath = join(root, "script.json");
  const script = [
    { kind: "click", label: "open menu" },
    { kind: "type", label: "search box", text: "hello" },
  ];
  await writeFile(scriptPath, JSON.stringify(script));

  const lines: string[] = [];
  const program = buildProgram({ profiles });
  program.configureOutput({ writeOut: (s) => lines.push(s) });
  program.exitOverride();
  await program.parseAsync(
    ["site", "simulate", "example.com", "--script", scriptPath, "--db", dbPath, "--json"],
    { from: "user" }
  );
  const parsed = JSON.parse(lines.join(""));
  expect(parsed.ok).toBe(true);
  expect(parsed.data).toMatchObject({ totalMs: expect.any(Number) });
  expect(Array.isArray(parsed.data.steps)).toBe(true);
  expect(parsed.data.steps).toHaveLength(2);
  // no stored policy => empty interaction => zero delay
  expect(parsed.data.totalMs).toBe(0);
});

test("site simulate --seed abc returns a failure envelope and sets exit code 1 (invalid seed must not silently become 0)", async () => {
  const savedExitCode = process.exitCode;
  try {
    const root = await mkdtemp(join(tmpdir(), "doit-cli-"));
    const profiles = new ProfileManager(root);
    const dbPath = join(root, "db.sqlite");
    const scriptPath = join(root, "script.json");
    const script = [{ kind: "click", label: "open menu" }];
    await writeFile(scriptPath, JSON.stringify(script));

    const lines: string[] = [];
    const program = buildProgram({ profiles });
    program.configureOutput({ writeOut: (s) => lines.push(s) });
    program.exitOverride();
    await program.parseAsync(
      ["site", "simulate", "example.com", "--script", scriptPath, "--db", dbPath, "--seed", "abc", "--json"],
      { from: "user" }
    );
    const parsed = JSON.parse(lines.join(""));
    expect(parsed).toMatchObject({ v: 1, ok: false, error: { code: "E_INVALID_SEED" } });
    expect(process.exitCode).toBe(1);
  } finally {
    process.exitCode = savedExitCode;
  }
});
