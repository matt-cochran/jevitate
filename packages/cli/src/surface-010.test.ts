import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Command, CommanderError } from "commander";
import { ProfileManager } from "@jevitate/daemon";
import { ALLOWED_TOOLS, FORBIDDEN_TOOLS } from "@jevitate/mcp-facade";
import { buildProgram, type CliDeps } from "./program.js";
import { buildMcpTools } from "./mcp-api.js";
import { makeInProcessCliRunner } from "./mcp-cli-runner.js";
import { homeDataRoot } from "./project-dir.js";

/**
 * 0.10 surface (d-surface-0): every new command and MCP tool of the release is registered with a
 * typed stub. Until its feature lands, each refuses with E_NOT_IMPLEMENTED (exit 2 — never a pass,
 * never a usage error), identically on the CLI and over MCP; and the security shape of the new MCP
 * surface holds already: no tool takes a key, connecting Journeeze is CLI only, nothing new approves.
 */

let dir: string;
let suite: string;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "jev-surface-010-"));
  mkdirSync(join(dir, "catalog"), { recursive: true });
  suite = join(dir, "valid.suite.json");
  writeFileSync(suite, JSON.stringify({ version: 1, ai: "fake", targets: [{ name: "t", url: "http://127.0.0.1:3999/", missions: [{ strategy: "feature", feature: "f" }] }] }));
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));
afterEach(() => {
  process.exitCode = undefined;
});

function cliDeps(): CliDeps {
  return {
    profiles: new ProfileManager(join(dir, "profiles")),
    dbPath: join(dir, "site.sqlite"),
    journeysDir: join(dir, "journeys"),
    catalogDir: join(dir, "catalog"),
    missionTargetsDir: join(dir, "targets"),
    inboxDir: join(dir, "inbox"),
  } as CliDeps;
}

async function run(argv: readonly string[]): Promise<{ code: number | undefined; out: string; err: string }> {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const program = buildProgram(cliDeps());
  const tree = (c: Command): void => {
    c.exitOverride();
    c.configureOutput({ writeOut: (s) => stdout.push(s), writeErr: (s) => stderr.push(s) });
    c.commands.forEach(tree);
  };
  tree(program);
  process.exitCode = undefined;
  let code: number | undefined;
  try {
    await program.parseAsync([...argv], { from: "user" });
    code = process.exitCode === undefined ? undefined : Number(process.exitCode);
  } catch (err) {
    if (!(err instanceof CommanderError)) throw err;
    code = err.exitCode;
  }
  return { code, out: stdout.join(""), err: stderr.join("") };
}

/** Evaluated lazily (paths exist only after beforeAll); `<dir>`/`<suite>` are placeholders. */
const STUB_COMMANDS: ReadonlyArray<readonly string[]> = [
  ["journey", "migrate", "--step-ids", "--dry-run"],
  ["journey", "review", "--stale"],
  ["locator-health"],
  ["locator-health", "--journey", "checkout"],
  ["check", "--suite", "<suite>", "--out", "<dir>/check", "--max-brittle-steps", "0"],
  ["catalog", "export", "--format", "journeeze-bundle", "--out", "<dir>/bundle"],
  ["connect", "journeeze", "--url", "http://127.0.0.1:3999"],
  ["publish", "journeeze", "--dry-run"],
];

describe("0.10 CLI stubs refuse with E_NOT_IMPLEMENTED (exit 2)", () => {
  it.each(STUB_COMMANDS.map((a) => [a.join(" "), a] as const))("%s", async (_label, raw) => {
    const argv = raw.map((a) => a.replace("<suite>", suite).replace("<dir>", dir));
    const json = await run([...argv, "--json"]);
    expect(json.code, json.err).toBe(2);
    const lines = json.out.trimEnd().split("\n");
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0]!)).toMatchObject({ v: 1, ok: false, error: { code: "E_NOT_IMPLEMENTED" } });
    const human = await run(argv);
    expect(human.code).toBe(2);
    expect(human.out).toBe("");
    expect(human.err).toMatch(/E_NOT_IMPLEMENTED/);
  });

  it("connect journeeze takes no key flag (the key is read from stdin, never argv)", () => {
    const program = buildProgram(cliDeps());
    const connect = program.commands.find((c) => c.name() === "connect")!.commands.find((c) => c.name() === "journeeze")!;
    expect(connect.options.map((o) => o.long).sort()).toEqual(["--json", "--url"]);
    expect(connect.registeredArguments).toEqual([]);
  });
});

describe("0.10 MCP tools: allowlisted, mirrored, stubbed, and key-free", () => {
  const tools = () => {
    const runCli = makeInProcessCliRunner(() => buildProgram(cliDeps()));
    return new Map(buildMcpTools({ journeysDir: join(dir, "journeys"), pathRoots: [dir], runCli }).map((t) => [t.name, t]));
  };
  const body = (r: { content: Array<{ text: string }> }): Record<string, unknown> => JSON.parse(r.content[0]!.text) as Record<string, unknown>;

  const CALLS: ReadonlyArray<readonly [string, Record<string, unknown>]> = [
    ["locator_health", {}],
    ["review_journey", { stale: true }],
    ["run_check", { suite: "valid.suite.json", out: "check", maxBrittleSteps: 2 }],
    ["export_catalog_bundle", { format: "journeeze-bundle", out: "bundle" }],
    ["publish_to_journeeze", { dryRun: true }],
  ];

  it.each(CALLS)("%s → refused E_NOT_IMPLEMENTED (exit 2), never a pass", async (name, args) => {
    const cwd = process.cwd();
    process.chdir(dir); // relative MCP paths resolve against the server's working directory
    try {
      const res = await tools().get(name)!.handler(args);
      expect(res.isError, JSON.stringify(body(res))).toBe(true);
      expect(body(res)).toMatchObject({ error: "refused", code: "E_NOT_IMPLEMENTED", exitCode: 2 });
    } finally {
      process.chdir(cwd);
    }
  });

  it("the new tools are allowlisted and served; connect_journeeze is forbidden and not served", () => {
    const served = tools();
    for (const t of ["draft_job_outcomes", "locator_health", "export_catalog_bundle", "publish_to_journeeze"]) {
      expect(ALLOWED_TOOLS as readonly string[]).toContain(t);
      expect(served.has(t), t).toBe(true);
    }
    expect(FORBIDDEN_TOOLS as readonly string[]).toContain("connect_journeeze");
    expect(served.has("connect_journeeze")).toBe(false);
    expect([...served.keys()].sort()).toEqual([...ALLOWED_TOOLS].sort());
  });

  it("no MCP tool takes a key, token, secret or password argument", () => {
    const offending = [...tools().values()].flatMap((t) =>
      Object.keys(t.inputSchema.properties as Record<string, unknown>)
        .filter((p) => /(^|[^a-z])(api)?key$|token|secret|password|credential|upload/i.test(p))
        .map((p) => `${t.name}.${p}`),
    );
    expect(offending).toEqual([]);
  });

  it("the new tools' arguments are exactly the mirrored flags (closed schemas)", () => {
    const props = (n: string) => Object.keys(tools().get(n)!.inputSchema.properties as Record<string, unknown>).sort();
    expect(props("draft_job_outcomes")).toEqual(["count", "fakeAi", "jobId", "real"]);
    expect(props("locator_health")).toEqual(["journey", "run"]);
    expect(props("export_catalog_bundle")).toEqual(["format", "out"]);
    expect(props("publish_to_journeeze")).toEqual(["dryRun"]);
    expect(props("review_journey")).toContain("stale");
    expect(props("run_check")).toContain("maxBrittleSteps");
  });

  it("export_catalog_bundle writes only inside the project: an out under ~/.jevitate or outside is invalid_args", async () => {
    const served = buildMcpTools({ journeysDir: join(dir, "journeys"), pathRoots: [dir, homeDataRoot()], runCli: makeInProcessCliRunner(() => buildProgram(cliDeps())) });
    const exportTool = served.find((t) => t.name === "export_catalog_bundle")!;
    for (const out of [join(homeDataRoot(), "bundle"), "/etc/jev-bundle", join(dir, "..", "escape")]) {
      const res = await exportTool.handler({ format: "journeeze-bundle", out });
      expect(res.isError, out).toBe(true);
      expect(body(res), out).toMatchObject({ error: "invalid_args" });
    }
  });
});
