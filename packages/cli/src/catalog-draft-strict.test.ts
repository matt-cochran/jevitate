import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ProfileManager } from "@jevitate/daemon";
import { FakeClock, installClock, resetClock } from "@jevitate/domain";
import { CatalogStatusSchema, FsJourneyStore, type Journey } from "@jevitate/journey";
import { buildProgram } from "./program.js";
import { buildMcpTools, type McpApiDeps } from "./mcp-api.js";
import { makeInProcessCliRunner } from "./mcp-cli-runner.js";
import { CatalogLoader } from "./catalog.js";
import { loadPersonasFile } from "./multi-run.js";
import { formatAuthorJourneyHuman, withLinkWarnings } from "./author-journey-cli.js";
import type { CliDeps } from "./cli-shared.js";

/** #523 — missing job/persona link warnings, `catalog draft`, `catalog status --strict`. No browser. */

function journey(id: string, overrides: Partial<Journey["metadata"]> = {}): Journey {
  return {
    metadata: {
      id,
      name: `Journey ${id}`,
      promoted: false,
      params: [],
      createdAtIso: "2026-09-19T00:00:00Z",
      endState: [{ kind: "reloadThen", assertion: { kind: "textIncludes", target: { testId: "live" }, text: "published" } }],
      ...overrides,
    },
    recording: {
      version: "1.0.0",
      site: "https://example.test",
      pages: [
        {
          url: "/editor",
          steps: [
            {
              step: { kind: "click", target: { testId: "publish" }, expect: { kind: "textIncludes", target: { role: "status" }, text: "Published" } },
              expectRequests: [{ kind: "responseStatus", method: "POST", pathGlob: "/api/publish", status: { class: 2 } }],
            },
          ],
        },
      ],
    },
  };
}

const JOB = { id: "publish-post", trigger: "a draft is ready", motivation: "publish it", outcome: "readers see it", personas: ["editor"] };

let root: string;
let catalogDir: string;
let journeysDir: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "jev-523-"));
  catalogDir = join(root, ".jevitate");
  journeysDir = join(catalogDir, "journeys");
  await mkdir(catalogDir, { recursive: true });
  await writeFile(join(catalogDir, "editor.json"), "{}");
  await writeFile(join(catalogDir, "personas.json"), JSON.stringify([{ name: "editor", description: "writes and publishes posts", role: "editor", storageState: "editor.json" }]));
  await writeFile(join(catalogDir, "jobs.json"), JSON.stringify([JOB]));
  const store = new FsJourneyStore(journeysDir);
  await store.put(journey("publish", { job: "publish-post", persona: "editor", anchors: [{ name: "published", step: 1 }] }));
  await store.put(journey("loose", { persona: "someone browsing" }));
  installClock(new FakeClock({ startMs: Date.parse("2026-10-15T12:00:00.000Z") }));
});

afterEach(async () => {
  resetClock();
  process.exitCode = undefined;
  await rm(root, { recursive: true, force: true });
});

const NOT_A_TTY = { env: {}, stdinIsTTY: () => false, stdoutIsTTY: () => false, user: () => "tester" };

function deps(): CliDeps {
  return { profiles: new ProfileManager(join(root, "profiles")), journeysDir, catalogDir, explore: { targetsConfigPath: join(root, "no-targets.json") }, approval: NOT_A_TTY };
}

async function cli(argv: readonly string[]): Promise<{ out: string; json: any; code: number | undefined }> {
  const lines: string[] = [];
  const program = buildProgram(deps());
  program.configureOutput({ writeOut: (s) => lines.push(s), writeErr: () => {} });
  program.exitOverride();
  process.exitCode = undefined;
  await program.parseAsync([...argv], { from: "user" });
  const out = lines.join("");
  let json: any;
  try {
    json = JSON.parse(out);
  } catch {
    json = undefined;
  }
  return { out, json, code: process.exitCode === undefined ? undefined : Number(process.exitCode) };
}

function mcpTool(name: string): (args: Record<string, unknown>) => Promise<{ isError: boolean; body: any }> {
  const mcpDeps: McpApiDeps = { journeysDir, pathRoots: [root], runCli: makeInProcessCliRunner(() => buildProgram(deps())) };
  const tool = buildMcpTools(mcpDeps).find((t) => t.name === name)!;
  return async (args) => {
    const r = await tool.handler(args);
    return { isError: r.isError === true, body: JSON.parse(r.content[0]!.text) };
  };
}

const loader = () => new CatalogLoader({ catalogDir, journeysDir });
const lintRules = async (id: string): Promise<string[]> => (await cli(["journey", "lint", id, "--json"])).json.data.findings.map((f: { rule: string }) => f.rule);
const lintFix = async (id: string, rule: string): Promise<string> =>
  (await cli(["journey", "lint", id, "--json"])).json.data.findings.find((f: { rule: string }) => f.rule === rule).fix;

describe("#523 journey lint: missing job / persona links", () => {
  it("warns missing-job on a Journey that links no job", async () => {
    expect(await lintRules("loose")).toContain("missing-job");
  });

  it("warns missing-persona on a Journey whose persona is free text", async () => {
    expect(await lintRules("loose")).toContain("missing-persona");
  });

  it("a Journey linking a job and a persona gets neither warning", async () => {
    expect((await lintRules("publish")).filter((r) => r.startsWith("missing-"))).toEqual([]);
  });

  it("the warnings are warnings: lint still exits 0", async () => {
    expect((await cli(["journey", "lint", "loose", "--json"])).code).toBe(0);
  });

  it("the missing-job fix lists the catalog's job ids", async () => {
    expect(await lintFix("loose", "missing-job")).toContain("publish-post");
  });

  it("the missing-job fix prints the draft command", async () => {
    expect(await lintFix("loose", "missing-job")).toContain('jevitate catalog draft job loose --name "');
  });

  it("the missing-persona fix lists the catalog's persona ids", async () => {
    expect(await lintFix("loose", "missing-persona")).toContain("existing persona (editor)");
  });

  it("with an empty catalog the fix offers only the draft", async () => {
    await rm(join(catalogDir, "jobs.json"));
    expect(await lintFix("loose", "missing-job")).toMatch(/^create a draft job: jevitate catalog draft job loose/);
  });

  it("an unreadable catalog never fails lint (the hint just lists no ids)", async () => {
    await writeFile(join(catalogDir, "jobs.json"), "{not json");
    expect((await cli(["journey", "lint", "loose", "--json"])).code).toBe(0);
  });

  it("the human output carries the fix", async () => {
    expect((await cli(["journey", "lint", "loose"])).out).toContain("missing-job");
  });
});

describe("#523 explore-author-journey: the result carries the link warnings", () => {
  const authored = (j: Journey) => ({ outcome: "authored" as const, journey: j }) as unknown as Parameters<typeof withLinkWarnings>[0];

  it("an authored, unlinked Journey gets missing-job and missing-persona", async () => {
    expect(((await withLinkWarnings(authored(journey("new")), catalogDir)).linkWarnings ?? []).map((w) => w.rule)).toEqual(["missing-job", "missing-persona"]);
  });

  it("a not-reached result gets none", async () => {
    const notReached = { outcome: "not-reached", reason: "x" } as unknown as Parameters<typeof withLinkWarnings>[0];
    expect("linkWarnings" in (await withLinkWarnings(notReached, catalogDir))).toBe(false);
  });

  it("the human rendering prints them", async () => {
    expect(formatAuthorJourneyHuman(await withLinkWarnings(authored(journey("new")), catalogDir))).toContain("warning  missing-job");
  });
});

describe("#523 catalog draft", () => {
  it("drafts a persona (status draft)", async () => {
    await cli(["catalog", "draft", "persona", "tester", "--name", "QA tester", "--json"]);
    expect((await loader().loadPersonas()).personas.find((p) => p.id === "tester")?.status).toBe("draft");
  });

  it("a drafted persona carries its name as its role", async () => {
    await cli(["catalog", "draft", "persona", "tester", "--name", "QA tester", "--description", "checks releases", "--json"]);
    expect((await loader().loadPersonas()).personas.find((p) => p.id === "tester")?.role).toBe("QA tester");
  });

  it("a drafted persona carries no approval", async () => {
    await cli(["catalog", "draft", "persona", "tester", "--name", "QA tester", "--json"]);
    expect(JSON.parse(await readFile(join(catalogDir, "personas.json"), "utf8"))[1]).toEqual({ name: "tester", role: "QA tester" });
  });

  it("a drafted, session-less persona does not break the run personas", async () => {
    await cli(["catalog", "draft", "persona", "tester", "--name", "QA tester", "--json"]);
    expect(loadPersonasFile(join(catalogDir, "personas.json")).map((p) => p.name)).toEqual(["editor"]);
  });

  it("drafts a job whose story uses the name as its motivation", async () => {
    await cli(["catalog", "draft", "job", "archive-post", "--name", "archive an old post", "--json"]);
    expect((await loader().loadJobs()).jobs.find((j) => j.id === "archive-post")?.job.motivation).toBe("archive an old post");
  });

  it("a drafted job is status draft", async () => {
    await cli(["catalog", "draft", "job", "archive-post", "--name", "archive an old post", "--json"]);
    expect((await loader().loadJobs()).jobs.find((j) => j.id === "archive-post")?.status).toBe("draft");
  });

  it("a job's --description is its goal", async () => {
    await cli(["catalog", "draft", "job", "archive-post", "--name", "archive an old post", "--description", "old posts leave the front page", "--json"]);
    expect((await loader().loadJobs()).jobs.find((j) => j.id === "archive-post")?.job.goal).toBe("old posts leave the front page");
  });

  it("a job's --trigger and --outcome are its story parts", async () => {
    await cli(["catalog", "draft", "job", "archive-post", "--name", "archive it", "--trigger", "a post is a year old", "--outcome", "keep the front page fresh", "--json"]);
    expect((await loader().loadJobs()).jobs.find((j) => j.id === "archive-post")?.story).toBe("When a post is a year old, I want to archive it, so I can keep the front page fresh.");
  });

  it("creates the jobs file when it does not exist", async () => {
    await rm(join(catalogDir, "jobs.json"));
    await cli(["catalog", "draft", "job", "archive-post", "--name", "archive an old post", "--json"]);
    expect(existsSync(join(catalogDir, "jobs.json"))).toBe(true);
  });

  it("refuses an id the catalog already has (exit 64)", async () => {
    expect((await cli(["catalog", "draft", "job", "publish-post", "--name", "again", "--json"])).code).toBe(64);
  });

  it("…with E_CATALOG_DRAFT_EXISTS", async () => {
    expect((await cli(["catalog", "draft", "persona", "editor", "--name", "again", "--json"])).json.error.code).toBe("E_CATALOG_DRAFT_EXISTS");
  });

  it("…and writes nothing", async () => {
    await cli(["catalog", "draft", "job", "publish-post", "--name", "again", "--json"]);
    expect(JSON.parse(await readFile(join(catalogDir, "jobs.json"), "utf8"))).toEqual([JOB]);
  });

  it("refuses an id off the catalog id rule (exit 64)", async () => {
    expect((await cli(["catalog", "draft", "job", "bad id!", "--name", "x", "--json"])).code).toBe(64);
  });

  it("refuses a kind other than persona or job (exit 64)", async () => {
    expect((await cli(["catalog", "draft", "journey", "x", "--name", "x", "--json"])).code).toBe(64);
  });

  it("refuses job story flags on a persona (exit 64)", async () => {
    expect((await cli(["catalog", "draft", "persona", "x", "--name", "x", "--trigger", "t", "--json"])).code).toBe(64);
  });

  it("the result says how to link, review and approve it", async () => {
    expect((await cli(["catalog", "draft", "job", "archive-post", "--name", "archive it", "--json"])).json.data.next.review).toBe("jevitate job review archive-post");
  });

  it("MCP catalog_draft writes the same draft", async () => {
    await mcpTool("catalog_draft")({ kind: "persona", id: "tester", name: "QA tester" });
    expect((await loader().loadPersonas()).personas.find((p) => p.id === "tester")?.status).toBe("draft");
  });

  it("MCP catalog_draft refuses a kind outside persona | job", async () => {
    expect((await mcpTool("catalog_draft")({ kind: "journey", id: "x", name: "x" })).isError).toBe(true);
  });
});

describe("#523 catalog status --strict", () => {
  const approveAll = async (): Promise<void> => {
    await cli(["persona", "approve", "editor", "--json", "--non-interactive-approval", "test"]);
    await cli(["job", "approve", "publish-post", "--json", "--non-interactive-approval", "test"]);
  };
  const promote = (id: string, ...extra: string[]) => cli(["journey", "promote", id, "--json", "--non-interactive-approval", "test", ...extra]);

  it("passes (exit 0) with nothing promoted and nothing stale", async () => {
    expect((await cli(["catalog", "status", "--strict", "--json"])).code).toBe(0);
  });

  it("without --strict the report has no strict section", async () => {
    expect((await cli(["catalog", "status", "--json"])).json.data.strict).toBeUndefined();
  });

  it("the strict report is schema-checked", async () => {
    expect(CatalogStatusSchema.safeParse((await cli(["catalog", "status", "--strict", "--json"])).json.data).success).toBe(true);
  });

  it("fails (exit 1) on a stale job approval", async () => {
    await approveAll();
    await writeFile(join(catalogDir, "jobs.json"), JSON.stringify([{ ...JSON.parse(await readFile(join(catalogDir, "jobs.json"), "utf8"))[0], outcome: "readers find it" }]));
    expect((await cli(["catalog", "status", "--strict", "--json"])).code).toBe(1);
  });

  it("fails (exit 1) when a promoted Journey links a draft job", async () => {
    await promote("publish", "--accept-unvetted", "pilot");
    expect((await cli(["catalog", "status", "--strict", "--json"])).code).toBe(1);
  });

  it("…naming the draft link", async () => {
    await promote("publish", "--accept-unvetted", "pilot");
    expect((await cli(["catalog", "status", "--strict", "--json"])).json.data.strict.violations).toContainEqual({ kind: "journey", id: "publish", reason: "promoted, but links job 'publish-post', which is a draft (not approved)" });
  });

  it("fails when a promoted Journey links no job and no persona", async () => {
    await approveAll();
    await promote("loose");
    expect((await cli(["catalog", "status", "--strict", "--json"])).json.data.strict.violations.map((v: { reason: string }) => v.reason)).toEqual([
      "promoted, but links no job",
      "promoted, but links no persona",
    ]);
  });

  it("passes once the promoted Journey's links are approved", async () => {
    await approveAll();
    await promote("publish");
    expect((await cli(["catalog", "status", "--strict", "--json"])).code).toBe(0);
  });

  it("an unpromoted Journey's missing links do not fail it", async () => {
    await approveAll();
    expect((await cli(["catalog", "status", "--strict", "--json"])).json.data.strict.violations).toEqual([]);
  });

  it("the human report lists the violations", async () => {
    await promote("publish", "--accept-unvetted", "pilot");
    expect((await cli(["catalog", "status", "--strict"])).out).toContain("--strict violations (exit 1 when any)");
  });

  it("MCP catalog_status strict: true returns the violations", async () => {
    await promote("publish", "--accept-unvetted", "pilot");
    expect((await mcpTool("catalog_status")({ strict: true })).body.data.strict.violations).toHaveLength(2);
  });
});
