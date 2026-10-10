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
import { exitCodeForError } from "./exit-codes.js";

/**
 * 0.10 surface: every new command and MCP tool of the release is registered and mirrored, and the
 * security shape of the new MCP surface holds: no tool takes a key, connecting Journeeze is CLI only,
 * nothing new approves, a bundle is written only inside the project, and a Journeeze refusal keeps
 * its specific code (and exit class) on both surfaces.
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
    // No key in the environment, an empty HOME (no saved connection), no terminal, no network.
    journeeze: { env: {}, homedir: () => join(dir, "home"), terminal: { isTTY: false } as never, http: async () => Promise.reject(new Error("no network in tests")) },
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

describe("0.10 CLI surface", () => {
  it("catalog export takes the check records and the product name", () => {
    const program = buildProgram(cliDeps());
    const exp = program.commands.find((c) => c.name() === "catalog")!.commands.find((c) => c.name() === "export")!;
    expect(exp.options.map((o) => o.long)).toEqual(expect.arrayContaining(["--check", "--product-name"]));
  });

  it("catalog export refuses a product name that is not one plain line (exit 64)", async () => {
    const res = await run(["catalog", "export", "--format", "journeeze-bundle", "--out", join(dir, "b1"), "--product-name", "a\nb", "--json"]);
    expect({ code: res.code, env: JSON.parse(res.out) }).toMatchObject({ code: 64, env: { error: { code: "E_CATALOG_EXPORT_ARGS" } } });
  });

  it("publish journeeze without a connection refuses with E_JOURNEEZE_NOT_CONNECTED, exit 64", async () => {
    const res = await run(["publish", "journeeze", "--dry-run", "--json"]);
    expect({ code: res.code, env: JSON.parse(res.out) }).toMatchObject({ code: 64, env: { error: { code: "E_JOURNEEZE_NOT_CONNECTED" } } });
  });

  it("connect journeeze without a terminal refuses with E_CONNECT_NEEDS_TTY, exit 64", async () => {
    const res = await run(["connect", "journeeze", "--url", "https://app.journeeze.dev", "--json"]);
    expect({ code: res.code, env: JSON.parse(res.out) }).toMatchObject({ code: 64, env: { error: { code: "E_CONNECT_NEEDS_TTY" } } });
  });

  it("connect journeeze takes no key flag (the key is read from stdin, never argv)", () => {
    const program = buildProgram(cliDeps());
    const connect = program.commands.find((c) => c.name() === "connect")!.commands.find((c) => c.name() === "journeeze")!;
    expect(connect.options.map((o) => o.long).sort()).toEqual(["--json", "--url"]);
    expect(connect.registeredArguments).toEqual([]);
  });
});

describe("0.10 refusal exit classes", () => {
  it("a Journey breaking the anchor rules is a usage refusal (exit 64): fix the Journey", () => {
    expect(exitCodeForError("E_JOURNEY_ANCHOR_RULES")).toBe(64);
  });

  it("a Journeeze server that is busy is inconclusive (exit 2), not a usage error", () => {
    expect(exitCodeForError("E_JOURNEEZE_UNAVAILABLE")).toBe(2);
  });
});

describe("0.10 MCP tools: allowlisted, mirrored and key-free", () => {
  const tools = () => {
    const runCli = makeInProcessCliRunner(() => buildProgram(cliDeps()));
    return new Map(buildMcpTools({ journeysDir: join(dir, "journeys"), pathRoots: [dir], runCli }).map((t) => [t.name, t]));
  };
  const body = (r: { content: Array<{ text: string }> }): Record<string, unknown> => JSON.parse(r.content[0]!.text) as Record<string, unknown>;

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
    expect(props("locator_health")).toEqual(["baseline", "journey", "run"]);
    expect(props("export_catalog_bundle")).toEqual(["check", "format", "out", "productName"]);
    expect(props("publish_to_journeeze")).toEqual(["dryRun", "productName"]);
    expect(props("review_journey")).toContain("stale");
    expect(props("run_check")).toContain("appVersion");
    expect(props("run_check")).toContain("maxBrittleSteps");
  });

  it("publish_to_journeeze without a connection carries E_JOURNEEZE_NOT_CONNECTED and exit 64", async () => {
    const res = await tools().get("publish_to_journeeze")!.handler({ dryRun: true });
    expect(body(res)).toMatchObject({ code: "E_JOURNEEZE_NOT_CONNECTED", exitCode: 64 });
  });

  it("export_catalog_bundle confines check paths: one outside the project is invalid_args", async () => {
    const res = await tools().get("export_catalog_bundle")!.handler({ format: "journeeze-bundle", out: join(dir, "b2"), check: ["/etc/passwd"] });
    expect(body(res)).toMatchObject({ error: "invalid_args" });
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
