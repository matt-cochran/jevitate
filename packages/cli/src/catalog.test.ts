import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ProfileManager } from "@jevitate/daemon";
import { FakeClock, installClock, resetClock } from "@jevitate/domain";
import { CatalogStatusSchema, FsJourneyStore, JobReviewSchema, JobSchema, PersonaReviewSchema, renderJobStory, type Journey } from "@jevitate/journey";
import { buildProgram } from "./program.js";
import { buildMcpTools, type McpApiDeps } from "./mcp-api.js";
import { makeInProcessCliRunner } from "./mcp-cli-runner.js";
import { CatalogLoader } from "./catalog.js";
import { registerPreApprovalAnalyzer } from "./pre-approval.js";
import { loadPersonasFile } from "./multi-run.js";
import type { CliDeps } from "./cli-shared.js";

/** #433 — catalog sign-off: personas and jobs as human-approved entities linked to Journeys. No browser. */

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

const JOB = { id: "publish-post", trigger: "a draft is ready", motivation: "publish it", outcome: "readers see it", personas: ["editor"], priority: "high" };

let root: string;
let catalogDir: string;
let journeysDir: string;

async function writeCatalog(personas: unknown, jobs: unknown, jobsFile = "jobs.json"): Promise<void> {
  await writeFile(join(catalogDir, "personas.json"), JSON.stringify(personas));
  await mkdir(join(catalogDir, "campaign"), { recursive: true });
  await writeFile(join(catalogDir, jobsFile), JSON.stringify(jobs));
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "jev-433-"));
  catalogDir = join(root, ".jevitate");
  journeysDir = join(catalogDir, "journeys");
  await mkdir(catalogDir, { recursive: true });
  await writeFile(join(catalogDir, "editor.json"), "{}");
  await writeCatalog(
    [
      { name: "editor", description: "writes and publishes posts", role: "editor", storageState: "editor.json" },
      { id: "reader", description: "reads posts", role: "viewer" },
    ],
    [JOB],
  );
  const store = new FsJourneyStore(journeysDir);
  await store.put(journey("publish", { job: "publish-post", persona: "editor" }));
  await store.put(journey("loose", { persona: "someone browsing" }));
  installClock(new FakeClock({ startMs: Date.parse("2026-10-08T12:00:00.000Z") }));
});

afterEach(() => {
  resetClock();
  process.exitCode = undefined;
});

function deps(): CliDeps {
  return { profiles: new ProfileManager(join(root, "profiles")), journeysDir, catalogDir, explore: { targetsConfigPath: join(root, "no-targets.json") } };
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

async function approveAll(): Promise<void> {
  await cli(["persona", "approve", "editor", "--json"]);
  await cli(["job", "approve", "publish-post", "--json"]);
}

async function editJob(patch: Record<string, unknown>): Promise<void> {
  const jobs = JSON.parse(await readFile(join(catalogDir, "jobs.json"), "utf8")) as Record<string, unknown>[];
  await writeFile(join(catalogDir, "jobs.json"), JSON.stringify(jobs.map((j) => (j.id === JOB.id ? { ...j, ...patch } : j))));
}

describe("#433 job schema", () => {
  it.each(["trigger", "motivation", "outcome"])("refuses a job without its %s", (part) => {
    const { [part as "trigger"]: _gone, ...job } = JOB;
    expect(JobSchema.safeParse(job).success).toBe(false);
  });

  it("refuses an empty story part", () => {
    expect(JobSchema.safeParse({ ...JOB, outcome: "  " }).success).toBe(false);
  });

  it("a jobs file with a job missing a part is refused (E_CATALOG_INPUT, exit 64)", async () => {
    await editJob({ trigger: undefined });
    const r = await cli(["catalog", "status", "--json"]);
    expect([r.json.error.code, r.code]).toEqual(["E_CATALOG_INPUT", 64]);
  });

  it("renders the job story template", () => {
    expect(renderJobStory({ trigger: "When a draft is ready", motivation: "I want to publish it", outcome: "so I can reach readers." })).toBe(
      "When a draft is ready, I want to publish it, so I can reach readers.",
    );
  });

  it("still reads .jevitate/campaign/jobs.json when jobs.json does not exist", async () => {
    await rm(join(catalogDir, "jobs.json"));
    await writeFile(join(catalogDir, "campaign", "jobs.json"), JSON.stringify([{ ...JOB, id: "legacy", personas: undefined, persona: "editor", goal: "g" }]));
    const catalog = await new CatalogLoader({ catalogDir, journeysDir }).load();
    expect(catalog.jobs.map((j) => [j.id, j.personas])).toEqual([["legacy", ["editor"]]]);
  });
});

describe("#433 personas file (extended, not a second file)", () => {
  it("a catalog-only persona does not break the run personas (it is skipped)", () => {
    expect(loadPersonasFile(join(catalogDir, "personas.json"), { requireRunnable: false }).map((p) => p.name)).toEqual(["editor"]);
  });

  it("the review sheet shows description, role, jobs and Journeys", async () => {
    const { json } = await cli(["persona", "review", "editor", "--json"]);
    expect(PersonaReviewSchema.parse(json.data)).toMatchObject({ role: "editor", jobs: [{ id: "publish-post" }], journeys: [{ id: "publish" }] });
  });
});

describe("#433 approval is bound to the content hash", () => {
  it("persona approve records {contentHash, at} in personas.json", async () => {
    const hash = (await cli(["persona", "review", "editor", "--json"])).json.data.contentHash;
    await cli(["persona", "approve", "editor", "--json"]);
    const file = JSON.parse(await readFile(join(catalogDir, "personas.json"), "utf8"));
    expect(file[0].approval).toEqual({ contentHash: hash, at: "2026-10-08T12:00:00.000Z" });
  });

  it("job approve records {contentHash, at} in jobs.json", async () => {
    const hash = (await cli(["job", "review", "publish-post", "--json"])).json.data.contentHash;
    await cli(["job", "approve", "publish-post", "--json"]);
    expect(JSON.parse(await readFile(join(catalogDir, "jobs.json"), "utf8"))[0].approval).toEqual({ contentHash: hash, at: "2026-10-08T12:00:00.000Z" });
  });

  it("refuses a reviewed hash the job no longer has (E_CATALOG_REVIEW_STALE)", async () => {
    const hash = (await cli(["job", "review", "publish-post", "--json"])).json.data.contentHash;
    await editJob({ outcome: "readers find it" });
    expect((await cli(["job", "approve", "publish-post", "--reviewed-hash", hash, "--json"])).json.error.code).toBe("E_CATALOG_REVIEW_STALE");
  });

  it("approving does not change the hash it approved", async () => {
    await cli(["job", "approve", "publish-post", "--json"]);
    expect((await cli(["job", "review", "publish-post", "--json"])).json.data.status).toBe("approved");
  });

  it("a map-form personas file keeps its form; a bare path entry gains the approval", async () => {
    await writeFile(join(catalogDir, "personas.json"), JSON.stringify({ editor: "editor.json" }));
    await cli(["persona", "approve", "editor", "--json"]);
    expect(JSON.parse(await readFile(join(catalogDir, "personas.json"), "utf8")).editor.storageState).toBe("editor.json");
  });
});

describe("#433 staleness propagation", () => {
  it("editing an approved job makes it stale", async () => {
    await approveAll();
    await editJob({ outcome: "readers find it" });
    expect((await cli(["job", "review", "publish-post", "--json"])).json.data.needsReReview).toBe(true);
  });

  it("…and every promoted Journey linked to it needs re-review", async () => {
    await approveAll();
    await cli(["journey", "promote", "publish", "--json"]);
    await editJob({ outcome: "readers find it" });
    expect((await cli(["journey", "review", "publish", "--json"])).json.data.catalog.needsReReview).toEqual(["its job 'publish-post' changed since that job's approval"]);
  });

  it("editing a persona's session settings is not a new persona", async () => {
    await approveAll();
    await writeCatalog([{ name: "editor", description: "writes and publishes posts", role: "editor", storageState: "other.json", approval: JSON.parse(await readFile(join(catalogDir, "personas.json"), "utf8"))[0].approval }], [JOB]);
    expect((await cli(["persona", "review", "editor", "--json"])).json.data.status).toBe("approved");
  });

  it("catalog status lists the stale approvals", async () => {
    await approveAll();
    await cli(["journey", "promote", "publish", "--json"]);
    await editJob({ outcome: "readers find it" });
    expect((await cli(["catalog", "status", "--json"])).json.data.stale.map((s: { kind: string; id: string }) => `${s.kind}:${s.id}`)).toEqual(["job:publish-post", "journey:publish"]);
  });

  it("re-approval clears it", async () => {
    await approveAll();
    await cli(["journey", "promote", "publish", "--json"]);
    await editJob({ outcome: "readers find it" });
    await cli(["job", "approve", "publish-post", "--json"]);
    expect((await cli(["catalog", "status", "--json"])).json.data.stale).toEqual([]);
  });
});

describe("#433 journey promote and the catalog", () => {
  it("refuses an unvetted link without a waiver (E_JOURNEY_UNVETTED, exit 1)", async () => {
    const r = await cli(["journey", "promote", "publish", "--json"]);
    expect([r.json.error.code, r.code]).toEqual(["E_JOURNEY_UNVETTED", 1]);
  });

  it("an unvetted refusal promotes nothing", async () => {
    await cli(["journey", "promote", "publish", "--json"]);
    expect((await new FsJourneyStore(journeysDir).get("publish"))?.metadata.promoted).toBe(false);
  });

  it("--accept-unvetted records the waiver in metadata.approval.waivers", async () => {
    await cli(["journey", "promote", "publish", "--accept-unvetted", "pilot run", "--json"]);
    expect((await new FsJourneyStore(journeysDir).get("publish"))?.metadata.approval?.waivers).toEqual([
      { kind: "unvetted", reason: "pilot run", items: ["job:publish-post (draft)", "persona:editor (draft)"] },
    ]);
  });

  it("promotes once the job and persona are approved", async () => {
    await approveAll();
    expect((await cli(["journey", "promote", "publish", "--json"])).json.data.promoted).toBe(true);
  });

  it("a dangling job link is unvetted too", async () => {
    await new FsJourneyStore(journeysDir).put(journey("dangling", { job: "nope", persona: "editor" }));
    expect((await cli(["journey", "promote", "dangling", "--json"])).json.error.code).toBe("E_JOURNEY_UNVETTED");
  });

  it("an unlinked Journey still promotes (opt-in)", async () => {
    expect((await cli(["journey", "promote", "loose", "--json"])).json.data.promoted).toBe(true);
  });

  it("an unlinked Journey's sheet says so", async () => {
    expect((await cli(["journey", "review", "loose"])).out).toContain("not linked to a job/persona");
  });
});

describe("#433 the shared pre-approval pipeline", () => {
  it("a finding that needs an acknowledgment refuses approval (E_APPROVAL_FINDINGS, exit 1)", async () => {
    await editJob({ personas: ["editor", "ghost"] });
    const r = await cli(["job", "approve", "publish-post", "--json"]);
    expect([r.json.error.code, r.code]).toEqual(["E_APPROVAL_FINDINGS", 1]);
  });

  it("--accept-findings records the reason in the approval", async () => {
    await editJob({ personas: ["editor", "ghost"] });
    await cli(["job", "approve", "publish-post", "--accept-findings", "ghost lands next sprint", "--json"]);
    expect(JSON.parse(await readFile(join(catalogDir, "jobs.json"), "utf8"))[0].approval.acceptedFindings).toEqual({
      reason: "ghost lands next sprint",
      findings: ["catalog-links/job.unknown-persona"],
    });
  });

  it("the review sheet shows the findings before the approval line", async () => {
    await editJob({ personas: ["editor", "ghost"] });
    const { out } = await cli(["job", "review", "publish-post"]);
    expect(out.indexOf("job.unknown-persona")).toBeLessThan(out.indexOf("Approve exactly this version"));
  });

  it("journey promote goes through it: a persona its job does not serve needs an acknowledgment", async () => {
    await approveAll();
    await cli(["persona", "approve", "reader", "--json"]);
    await new FsJourneyStore(journeysDir).put(journey("as-reader", { job: "publish-post", persona: "reader" }));
    expect((await cli(["journey", "promote", "as-reader", "--json"])).json.error.code).toBe("E_APPROVAL_FINDINGS");
  });

  it("…and --accept-findings records metadata.approval.acceptedFindings", async () => {
    await approveAll();
    await cli(["persona", "approve", "reader", "--json"]);
    await new FsJourneyStore(journeysDir).put(journey("as-reader", { job: "publish-post", persona: "reader" }));
    await cli(["journey", "promote", "as-reader", "--accept-findings", "readers may publish in beta", "--json"]);
    expect((await new FsJourneyStore(journeysDir).get("as-reader"))?.metadata.approval?.acceptedFindings?.findings).toEqual(["catalog-links/journey.persona-not-served"]);
  });

  it("a registered analyzer's findings gate every approval path (the #434/#435 extension point)", async () => {
    const unregister = registerPreApprovalAnalyzer({
      id: "test-conflicts",
      appliesTo: ["persona"],
      analyze: () => [{ analyzer: "test-conflicts", code: "conflicting", severity: "fail", message: "conflicts with reader", requiresAcknowledgment: true }],
    });
    try {
      expect((await cli(["persona", "approve", "editor", "--json"])).json.error.code).toBe("E_APPROVAL_FINDINGS");
    } finally {
      unregister();
    }
  });

  it("an analyzer that throws fails closed (a finding that needs an acknowledgment)", async () => {
    const unregister = registerPreApprovalAnalyzer({
      id: "test-broken",
      appliesTo: ["job"],
      analyze: () => {
        throw new Error("model offline");
      },
    });
    try {
      expect((await cli(["job", "review", "publish-post", "--json"])).json.data.findings[0]).toMatchObject({ analyzer: "test-broken", requiresAcknowledgment: true });
    } finally {
      unregister();
    }
  });
});

describe("#433 catalog status", () => {
  it("the jobs × personas matrix", async () => {
    await approveAll();
    await cli(["journey", "promote", "publish", "--json"]);
    await editJob({ personas: ["editor", "reader"] });
    const { json } = await cli(["catalog", "status", "--json"]);
    expect(CatalogStatusSchema.parse(json.data).matrix).toEqual([
      { job: "publish-post", cells: { editor: { state: "promoted", journeys: ["publish"] }, reader: { state: "missing", journeys: [] } } },
    ]);
  });

  it("lists approved jobs with no promoted Journey", async () => {
    await approveAll();
    expect((await cli(["catalog", "status", "--json"])).json.data.approvedJobsWithoutPromotedJourney).toEqual(["publish-post"]);
  });

  it("lists Journeys linked to nothing", async () => {
    expect((await cli(["catalog", "status", "--json"])).json.data.unlinkedJourneys).toEqual(["loose"]);
  });

  it("the human report draws the matrix", async () => {
    expect((await cli(["catalog", "status"])).out).toMatch(/publish-post\s+draft\s+·/);
  });

  it("a project without personas/jobs files reports an empty catalog (a job link is then dangling)", async () => {
    await rm(join(catalogDir, "personas.json"));
    await rm(join(catalogDir, "jobs.json"));
    expect((await cli(["catalog", "status", "--json"])).json.data).toMatchObject({ personas: [], jobs: [], matrix: [], unlinkedJourneys: ["loose"], danglingLinks: [
      { journey: "publish", kind: "job", id: "publish-post" },
      { journey: "publish", kind: "persona", id: "editor" },
    ] });
  });
});

describe("#433 MCP: read-only review tools, no approve tool", () => {
  function tools(): Map<string, (args: Record<string, unknown>) => Promise<{ isError: boolean; body: any }>> {
    const mcpDeps: McpApiDeps = { journeysDir, pathRoots: [root], runCli: makeInProcessCliRunner(() => buildProgram(deps())) };
    return new Map(
      buildMcpTools(mcpDeps).map((t) => [
        t.name,
        async (args: Record<string, unknown>) => {
          const r = await t.handler(args);
          return { isError: r.isError === true, body: JSON.parse(r.content[0]!.text) };
        },
      ]),
    );
  }

  it("serves no tool that approves a persona or a job", () => {
    expect([...tools().keys()].filter((n) => /persona|job/.test(n) && /approve/.test(n))).toEqual([]);
  });

  it("review_job returns the CLI's sheet", async () => {
    const cliSheet = (await cli(["job", "review", "publish-post", "--json"])).json.data;
    expect(JobReviewSchema.parse((await tools().get("review_job")!({ id: "publish-post" })).body.data)).toEqual(cliSheet);
  });

  it("review_persona is read-only", async () => {
    await tools().get("review_persona")!({ id: "editor" });
    expect(JSON.parse(await readFile(join(catalogDir, "personas.json"), "utf8"))[0].approval).toBeUndefined();
  });

  it("catalog_status returns the report", async () => {
    expect((await tools().get("catalog_status")!({})).body.data.unlinkedJourneys).toEqual(["loose"]);
  });

  it("promote_journey takes acceptUnvetted (parity with --accept-unvetted)", async () => {
    await tools().get("promote_journey")!({ id: "publish", acceptUnvetted: "agent pilot" });
    expect((await new FsJourneyStore(journeysDir).get("publish"))?.metadata.approval?.waivers?.[0]?.reason).toBe("agent pilot");
  });
});
