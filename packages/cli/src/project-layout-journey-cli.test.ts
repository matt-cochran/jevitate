import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Command, CommanderError } from "commander";
import { ProfileManager } from "@jevitate/daemon";
import { buildProgram } from "./program.js";

/**
 * #585: every `journey` command under `journey-cli/` takes `--project`/`--journeys-dir` and resolves
 * its store with `resolveLayout` (dirMeaning "journeys"); `--dir` stays as the deprecated alias
 * (docs/contracts/project-layout.md §2). Each test drives `buildProgram` and asserts one public
 * outcome against a temp project — never the real home or the repo's own `.jevitate/`.
 */

function journey(id: string): unknown {
  return {
    metadata: { id, name: id, promoted: true, params: [], createdAtIso: "2026-09-19T00:00:00Z" },
    recording: {
      version: "1.0.0",
      site: "https://example.test",
      pages: [
        {
          url: "/login",
          steps: [{ step: { kind: "navigate", url: "/login", expect: { kind: "visible", target: { label: "Username" } } } }],
        },
      ],
    },
  };
}

let root: string;
let project: string;
let projectDir: string;
let journeys: string;
let elsewhere: string;
let otherStore: string;
let missing: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "jev-layout-wiring-journey-"));
  project = join(root, "project");
  projectDir = join(project, ".jevitate");
  journeys = join(projectDir, "journeys");
  mkdirSync(journeys, { recursive: true });
  writeFileSync(join(journeys, "login.json"), JSON.stringify(journey("login")));
  elsewhere = join(root, "elsewhere");
  mkdirSync(elsewhere);
  otherStore = join(root, "other-store");
  mkdirSync(otherStore);
  writeFileSync(join(otherStore, "other.json"), JSON.stringify(journey("other")));
  missing = join(root, "missing-store");
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
  process.exitCode = undefined;
});

interface Run {
  readonly code: number | undefined;
  readonly out: string;
  readonly err: string;
}

/** The program's stdout/stderr and exit code for one invocation, run from `cwd`. */
async function runFrom(cwd: string, argv: readonly string[]): Promise<Run> {
  const saved = process.cwd();
  process.chdir(cwd);
  const stdout: string[] = [];
  const stderr: string[] = [];
  const program = buildProgram({ profiles: new ProfileManager(join(root, "profiles")) });
  program.configureOutput({ writeOut: (s) => stdout.push(s), writeErr: (s) => stderr.push(s) });
  const override = (command: Command): void => {
    command.exitOverride();
    command.commands.forEach(override);
  };
  override(program);
  process.exitCode = undefined;
  let code: number | undefined;
  try {
    await program.parseAsync([...argv], { from: "user" });
    code = process.exitCode === undefined ? undefined : Number(process.exitCode);
  } catch (err) {
    if (!(err instanceof CommanderError)) throw err;
    code = err.exitCode;
  } finally {
    process.chdir(saved);
  }
  return { code, out: stdout.join(""), err: stderr.join("") };
}

describe("journey commands resolve the project store (#585 §2)", () => {
  it("journey list --project from an unrelated cwd lists the project's Journeys", async () => {
    const { out } = await runFrom(elsewhere, ["journey", "list", "--project", project, "--json"]);
    expect(JSON.parse(out).data.map((m: { id: string }) => m.id)).toEqual(["login"]);
  });

  it("journey list --journeys-dir lists the named store's Journeys", async () => {
    const { out } = await runFrom(elsewhere, ["journey", "list", "--journeys-dir", otherStore, "--json"]);
    expect(JSON.parse(out).data.map((m: { id: string }) => m.id)).toEqual(["other"]);
  });

  it("journey list --dir still resolves the named store", async () => {
    const { out } = await runFrom(elsewhere, ["journey", "list", "--dir", otherStore, "--json"]);
    expect(JSON.parse(out).data.map((m: { id: string }) => m.id)).toEqual(["other"]);
  });

  it("journey list --dir prints the deprecation line on stderr", async () => {
    const { err } = await runFrom(elsewhere, ["journey", "list", "--dir", otherStore, "--json"]);
    expect(err).toContain("--dir is deprecated here; use --journeys-dir <path> (same meaning)");
  });

  it("journey list --dir keeps the deprecation line out of the --json stdout envelope", async () => {
    const { out } = await runFrom(elsewhere, ["journey", "list", "--dir", otherStore, "--json"]);
    expect(out).not.toContain("deprecated");
  });

  it("journey list --dir with --project is refused E_PROJECT_ARGS", async () => {
    const { out } = await runFrom(elsewhere, ["journey", "list", "--dir", otherStore, "--project", project, "--json"]);
    expect(JSON.parse(out).error.code).toBe("E_PROJECT_ARGS");
  });

  it("journey list --dir with --project exits 64", async () => {
    const { code } = await runFrom(elsewhere, ["journey", "list", "--dir", otherStore, "--project", project, "--json"]);
    expect(code).toBe(64);
  });

  it("journey list with a missing --journeys-dir is refused E_PROJECT_DIR_MISSING", async () => {
    const { out } = await runFrom(elsewhere, ["journey", "list", "--journeys-dir", missing, "--json"]);
    expect(JSON.parse(out).error.code).toBe("E_PROJECT_DIR_MISSING");
  });

  it("journey list with a missing --journeys-dir names the next action", async () => {
    const { out } = await runFrom(elsewhere, ["journey", "list", "--journeys-dir", missing, "--json"]);
    expect(JSON.parse(out).error.message).toMatch(/--journeys-dir|jevitate init/);
  });

  it("journey list with a missing --journeys-dir exits 64", async () => {
    const { code } = await runFrom(elsewhere, ["journey", "list", "--journeys-dir", missing, "--json"]);
    expect(code).toBe(64);
  });

  it("journey review --json content hash is identical from the project dir and an unrelated cwd", async () => {
    const discovered = await runFrom(project, ["journey", "review", "login", "--json"]);
    const viaFlag = await runFrom(elsewhere, ["journey", "review", "login", "--project", project, "--json"]);
    expect(JSON.parse(discovered.out).data.contentHash).toBe(JSON.parse(viaFlag.out).data.contentHash);
  });
});
