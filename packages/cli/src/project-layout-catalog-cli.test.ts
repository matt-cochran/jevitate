import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Command, CommanderError } from "commander";
import { ProfileManager } from "@jevitate/daemon";
import { buildProgram } from "./program.js";
import { registerWhere } from "./project-where.js";

/**
 * #585: the catalog/persona/job commands and `journey link` take `--project`/`--journeys-dir` and
 * resolve their catalog with `resolveLayout` (dirMeaning "project", requireProject); `--dir` stays
 * the deprecated alias (docs/contracts/project-layout.md §2). `jevitate where` prints the resolved
 * layout (§5). Each test drives `buildProgram` (or `registerWhere` on a fresh Command) and asserts
 * one public outcome against a temp project — never the real home or the repo's own `.jevitate/`.
 */

const PERSONA = { id: "editor", description: "writes and publishes posts", role: "editor" };
const JOB = { id: "publish-post", trigger: "a draft is ready", motivation: "publish it", outcome: "readers see it", personas: ["editor"] };

function journey(id: string): unknown {
  return {
    metadata: { id, name: id, promoted: true, params: [], createdAtIso: "2026-09-19T00:00:00Z" },
    recording: {
      version: "1.0.0",
      site: "https://example.test",
      pages: [
        {
          url: "/editor",
          steps: [{ step: { kind: "navigate", url: "/editor", expect: { kind: "visible", target: { label: "Editor" } } } }],
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

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "jev-layout-wiring-catalog-"));
  project = join(root, "project");
  projectDir = join(project, ".jevitate");
  journeys = join(projectDir, "journeys");
  mkdirSync(journeys, { recursive: true });
  writeFileSync(join(projectDir, "personas.json"), JSON.stringify([PERSONA]));
  writeFileSync(join(projectDir, "jobs.json"), JSON.stringify([JOB]));
  writeFileSync(join(journeys, "publish.json"), JSON.stringify(journey("publish")));
  elsewhere = join(root, "elsewhere");
  mkdirSync(elsewhere);
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

function capture(program: Command, root: string): { stdout: string[]; stderr: string[] } {
  const stdout: string[] = [];
  const stderr: string[] = [];
  program.configureOutput({ writeOut: (s) => stdout.push(s), writeErr: (s) => stderr.push(s) });
  const override = (command: Command): void => {
    command.exitOverride();
    command.commands.forEach(override);
  };
  override(program);
  return { stdout, stderr };
}

/** `buildProgram`'s stdout/stderr and exit code for one invocation, run from `cwd`. */
async function runFrom(cwd: string, argv: readonly string[]): Promise<Run> {
  const saved = process.cwd();
  process.chdir(cwd);
  const program = buildProgram({ profiles: new ProfileManager(join(root, "profiles")) });
  const { stdout, stderr } = capture(program, root);
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

/** `registerWhere` on a fresh root Command (#585 §5), run from `cwd`. */
async function runWhere(cwd: string, argv: readonly string[]): Promise<Run> {
  const saved = process.cwd();
  process.chdir(cwd);
  const program = new Command();
  program.name("jevitate");
  registerWhere(program, { profiles: new ProfileManager(join(root, "profiles")) });
  const { stdout, stderr } = capture(program, root);
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

describe("catalog commands resolve the project (#585 §2)", () => {
  it("catalog status --project from an unrelated cwd reads that project's catalog", async () => {
    const { out } = await runFrom(elsewhere, ["catalog", "status", "--project", project, "--json"]);
    expect(JSON.parse(out).data.matrix.map((m: { job: string }) => m.job)).toEqual(["publish-post"]);
  });

  it("catalog status outside a project with no --project is refused E_PROJECT_NOT_FOUND", async () => {
    const { out } = await runFrom(elsewhere, ["catalog", "status", "--json"]);
    expect(JSON.parse(out).error.code).toBe("E_PROJECT_NOT_FOUND");
  });

  it("catalog status outside a project with no --project exits 64", async () => {
    const { code } = await runFrom(elsewhere, ["catalog", "status", "--json"]);
    expect(code).toBe(64);
  });

  it("catalog status --dir prints the deprecation line naming --project on stderr", async () => {
    const { err } = await runFrom(elsewhere, ["catalog", "status", "--dir", projectDir, "--json"]);
    expect(err).toContain("--dir is deprecated here; use --project <path> (same meaning)");
  });

  it("catalog status --dir keeps the deprecation line out of the --json stdout envelope", async () => {
    const { out } = await runFrom(elsewhere, ["catalog", "status", "--dir", projectDir, "--json"]);
    expect(out).not.toContain("deprecated");
  });

  it("journey link --project works from an unrelated cwd", async () => {
    const { out } = await runFrom(elsewhere, ["journey", "link", "publish", "--job", "publish-post", "--project", project, "--json"]);
    expect(JSON.parse(out).data.job).toBe("publish-post");
  });
});

describe("jevitate where (#585 §5)", () => {
  it("where --json reports the project named by --project", async () => {
    const { out } = await runWhere(elsewhere, ["where", "--project", project, "--json"]);
    expect(JSON.parse(out).data.projectDir).toBe(projectDir);
  });

  it("where --json reports the project found by discovery", async () => {
    const { out } = await runWhere(project, ["where", "--json"]);
    expect(JSON.parse(out).data.projectDir).toBe(projectDir);
  });
});
