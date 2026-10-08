import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ProfileManager } from "@jevitate/daemon";
import { FakeClock, installClock, resetClock } from "@jevitate/domain";
import { FAKE_CALL_USAGE, UsageTracker, type Answer, type JudgmentPort, type JudgmentState, type Question } from "@jevitate/ai-core";
import { FsJourneyStore, type Finding, type Journey } from "@jevitate/journey";
import { buildProgram } from "./program.js";
import { buildMcpTools, type McpApiDeps } from "./mcp-api.js";
import { makeInProcessCliRunner } from "./mcp-cli-runner.js";
import { CatalogLoader } from "./catalog.js";
import { APPROVAL_PAIR_CAP, CONFLICT_ACK_THRESHOLD, candidatePairs, writeResource } from "./catalog-analysis.js";
import type { CliDeps } from "./cli-shared.js";

/** #435 — catalog analysis: candidate pairs, Jev classification, the acknowledgment rule, gaps, advice. No browser, no live model. */

/** A scripted judgment client: answers by question name, counts calls, records fake usage. */
class ScriptedJudge implements JudgmentPort {
  calls = 0;
  constructor(
    private readonly answer: (name: string, q: Question, state: JudgmentState) => Answer,
    private readonly usage: UsageTracker,
  ) {}
  async systemOne(args: { state: JudgmentState; questions: Record<string, Question> }): Promise<Record<string, Answer>> {
    this.calls += 1;
    this.usage.recordJudgment(FAKE_CALL_USAGE);
    return Object.fromEntries(Object.entries(args.questions).map(([n, q]) => [n, this.answer(n, q, args.state)]));
  }
}

const noul = (p: number): Answer => ({ kind: "noul", value: p >= 0.5, probability: p });
const compatible: Answer = { kind: "choice", value: "compatible", confidence: 0.9 };

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

const PRIVATE = { id: "keep-private", trigger: "my draft holds customer data", motivation: "restrict who can open it", outcome: "keep my customer data private", personas: ["editor"] };
const SHARE = { id: "share-team", trigger: "my draft holds customer data", motivation: "send it to colleagues", outcome: "share my customer data with my team", personas: ["editor"] };
const READ = { id: "read-post", trigger: "a post is published", motivation: "read it", outcome: "learn the news", personas: ["reader"] };

let root: string;
let catalogDir: string;
let journeysDir: string;
let usage: UsageTracker;
let judge: ScriptedJudge | undefined;
let env: Record<string, string | undefined>;

async function writeJobs(jobs: unknown[]): Promise<void> {
  await writeFile(join(catalogDir, "jobs.json"), JSON.stringify(jobs));
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "jev-435-"));
  catalogDir = join(root, ".jevitate");
  journeysDir = join(catalogDir, "journeys");
  await mkdir(catalogDir, { recursive: true });
  await writeFile(
    join(catalogDir, "personas.json"),
    JSON.stringify([
      { name: "editor", description: "writes and publishes posts", role: "editor" },
      { name: "reader", description: "reads posts", role: "viewer" },
    ]),
  );
  await writeJobs([PRIVATE, SHARE, READ]);
  await new FsJourneyStore(journeysDir).put(journey("publish", { job: "keep-private", persona: "editor" }));
  usage = new UsageTracker();
  judge = undefined;
  env = {};
  installClock(new FakeClock({ startMs: Date.parse("2026-10-08T12:00:00.000Z") }));
});

afterEach(() => {
  resetClock();
  process.exitCode = undefined;
});

/** Jev answers `relation` with this classification, and every readiness question "yes". */
function classify(value: string, confidence: number): ScriptedJudge {
  judge = new ScriptedJudge((_n, q) => (q.kind === "choice" ? { kind: "choice", value, confidence } : noul(0.9)), usage);
  return judge;
}

function deps(): CliDeps {
  return {
    profiles: new ProfileManager(join(root, "profiles")),
    journeysDir,
    catalogDir,
    explore: { targetsConfigPath: join(root, "no-targets.json"), env, localConfig: {}, usage, ...(judge === undefined ? {} : { judge }) },
    // #437: a fixed, marker-free environment — on a CI runner the real one would record channel `ci`.
    approval: { env: {}, stdinIsTTY: () => false, stdoutIsTTY: () => false, user: () => "tester" },
  };
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

async function load() {
  return new CatalogLoader({ catalogDir, journeysDir }).load();
}

const pairKey = (p: { a: string; b: string }) => `${p.a}~${p.b}`;

async function catalogBytes(): Promise<string> {
  const files = [join(catalogDir, "personas.json"), join(catalogDir, "jobs.json"), ...(await readdir(journeysDir)).filter((f) => f.endsWith(".json")).map((f) => join(journeysDir, f))];
  return (await Promise.all(files.map((f) => readFile(f, "utf8")))).join("\n");
}

describe("#435 candidate pairing (deterministic)", () => {
  it("pairs jobs that share a persona", async () => {
    expect(candidatePairs(await load()).find((p) => pairKey(p) === "job:keep-private~job:share-team")?.reasons[0]).toBe("both serve persona 'editor'");
  });

  it("pairs jobs with overlapping trigger/outcome terms even without a shared persona", async () => {
    await writeJobs([PRIVATE, { ...SHARE, personas: ["reader"] }]);
    expect(candidatePairs(await load()).map(pairKey)).toEqual(["job:keep-private~job:share-team"]);
  });

  it("does not pair unrelated jobs", async () => {
    expect(candidatePairs(await load()).some((p) => p.a === "job:read-post" || p.b === "job:read-post")).toBe(false);
  });

  it("pairs personas with the same account role", async () => {
    await writeFile(join(catalogDir, "personas.json"), JSON.stringify([{ name: "editor", role: "editor" }, { name: "author", role: "Editor" }]));
    expect(candidatePairs(await load()).find((p) => p.kind === "persona")?.reasons).toEqual(["same account role 'editor'"]);
  });

  it("pairs Journeys with opposing writes on one resource", async () => {
    const del = journey("delete-post");
    del.recording.pages[0]!.steps[0] = { ...del.recording.pages[0]!.steps[0]!, expectRequests: [{ kind: "responseStatus", method: "DELETE", pathGlob: "/api/publish/42", status: { class: 2 } }] };
    await new FsJourneyStore(journeysDir).put(del);
    expect(candidatePairs(await load()).find((p) => p.kind === "journey")?.reasons[0]).toMatch(/^opposing writes on \/api: DELETE \/api\/publish\/42 vs POST \/api\/publish/);
  });

  it("pairs Journeys doing the same job as the same persona", async () => {
    await new FsJourneyStore(journeysDir).put(journey("publish-2", { job: "keep-private", persona: "editor" }));
    expect(candidatePairs(await load()).find((p) => p.kind === "journey")?.reasons).toContain("both do job 'keep-private' as persona 'editor'");
  });

  it("a write's resource drops ids, wildcards and an action verb", () => {
    expect(writeResource("POST", "https://x.test/api/posts/42/disable?x=1")).toMatchObject({ resource: "/api/posts", action: "disable" });
  });
});

describe("#435 the acknowledgment rule (code over Jev's typed answer)", () => {
  it(`a conflicting classification at p ≥ ${CONFLICT_ACK_THRESHOLD} refuses the approval without --accept-findings`, async () => {
    classify("conflicting", 0.9);
    expect((await cli(["job", "approve", "keep-private", "--real", "--json", "--non-interactive-approval", "test"])).json.error.code).toBe("E_APPROVAL_FINDINGS");
  });

  it("…and exits 1 (a gating finding)", async () => {
    classify("conflicting", 0.9);
    expect((await cli(["job", "approve", "keep-private", "--real", "--json", "--non-interactive-approval", "test"])).code).toBe(1);
  });

  it("with --accept-findings the approval records the reason and the conflict", async () => {
    classify("conflicting", 0.9);
    await cli(["job", "approve", "keep-private", "--real", "--accept-findings", "different data sets", "--json", "--non-interactive-approval", "test"]);
    const jobs = JSON.parse(await readFile(join(catalogDir, "jobs.json"), "utf8")) as Array<{ id: string; approval?: { acceptedFindings?: unknown } }>;
    expect(jobs.find((j) => j.id === "keep-private")?.approval?.acceptedFindings).toMatchObject({ reason: "different data sets", findings: ["catalog-analysis/conflicting:job:share-team"], provenance: { channel: "non-interactive", reason: "test" } });
  });

  it("a conflict below the threshold is informational: the approval goes through", async () => {
    classify("conflicting", 0.6);
    expect((await cli(["job", "approve", "keep-private", "--real", "--json", "--non-interactive-approval", "test"])).json.ok).toBe(true);
  });

  it("a duplicate at p ≥ the threshold also refuses the approval", async () => {
    classify("duplicate", 0.8);
    expect((await cli(["job", "approve", "keep-private", "--real", "--json", "--non-interactive-approval", "test"])).json.error.code).toBe("E_APPROVAL_FINDINGS");
  });

  it("a duplicate below the threshold is informational", async () => {
    classify("duplicate", 0.5);
    expect((await cli(["job", "approve", "keep-private", "--real", "--json", "--non-interactive-approval", "test"])).json.ok).toBe(true);
  });

  it("an overlapping classification never needs an acknowledgment", async () => {
    classify("overlapping", 0.99);
    expect((await cli(["job", "approve", "keep-private", "--real", "--json", "--non-interactive-approval", "test"])).json.ok).toBe(true);
  });

  it("journey promote applies the same rule to the Journey's pairs", async () => {
    await new FsJourneyStore(journeysDir).put(journey("publish-2", { job: "keep-private", persona: "editor" }));
    classify("duplicate", 0.95);
    expect((await cli(["journey", "promote", "publish-2", "--real", "--accept-unvetted", "pilot", "--json", "--non-interactive-approval", "test"])).json.error.code).toBe("E_APPROVAL_FINDINGS");
  });

  it("without --real nothing is classified, so nothing gates on it", async () => {
    expect((await cli(["job", "approve", "keep-private", "--json", "--non-interactive-approval", "test"])).json.ok).toBe(true);
  });

  it("a review sheet shows the conflict without gating (review never refuses)", async () => {
    classify("conflicting", 0.9);
    expect((await cli(["job", "review", "keep-private", "--real", "--json"])).json.data.findings.find((f: Finding) => f.code === "conflicting:job:share-team")?.requiresAcknowledgment).toBe(false);
  });

  it("the finding's reason is grounded in the two items' text", async () => {
    classify("conflicting", 0.9);
    const f = (await cli(["job", "review", "keep-private", "--real", "--json"])).json.data.findings.find((x: Finding) => x.code === "conflicting:job:share-team");
    expect(f.message).toContain('"When my draft holds customer data, I want to send it to colleagues, so I can share my customer data with my team."');
  });
});

describe("#435 bounded cost", () => {
  it("re-approving an unchanged item asks nothing new (cached by the pair's content)", async () => {
    const j = classify("compatible", 0.9);
    await cli(["job", "review", "keep-private", "--readiness", "--real", "--json"]);
    const asked = j.calls;
    await cli(["job", "approve", "keep-private", "--real", "--json", "--non-interactive-approval", "test"]);
    expect(j.calls).toBe(asked);
  });

  it(`judges at most ${APPROVAL_PAIR_CAP} pairs per approval and reports the overflow`, async () => {
    await writeJobs(Array.from({ length: APPROVAL_PAIR_CAP + 2 }, (_, i) => ({ id: `job-${i}`, trigger: `case ${i}`, motivation: "act", outcome: `result ${i}`, personas: ["editor"] })));
    classify("compatible", 0.9);
    expect((await cli(["job", "review", "job-0", "--real", "--json"])).json.data.findings.find((f: Finding) => f.code === "pairs.overflow")?.message).toMatch(/^1 more candidate pair\(s\) were not judged \(cap 8\)/);
  });

  it("catalog analyze --max-pairs lists the pairs over the cap as overflow", async () => {
    await writeJobs(Array.from({ length: 4 }, (_, i) => ({ id: `job-${i}`, trigger: `case ${i}`, motivation: "act", outcome: `result ${i}`, personas: ["editor"] })));
    expect((await cli(["catalog", "analyze", "--max-pairs", "2", "--json"])).json.data.overflow).toHaveLength(4);
  });
});

describe("#435 catalog analyze", () => {
  it("Jev's classifications flow into the report", async () => {
    classify("conflicting", 0.9);
    expect((await cli(["catalog", "analyze", "--real", "--json"])).json.data.pairs[0].classification).toMatchObject({ relation: "conflicting", probability: 0.9 });
  });

  it("a dependent classification is grouped under comprehensible", async () => {
    classify("dependent", 0.8);
    expect((await cli(["catalog", "analyze", "--real", "--json"])).json.data.groups.map((g: { characteristic: string }) => g.characteristic)).toContain("comprehensible");
  });

  it("no judgment key: the deterministic layer only", async () => {
    expect((await cli(["catalog", "analyze", "--real", "--json"])).json.data.jev).toMatchObject({ status: "skipped", reason: expect.stringMatching(/no judgment key/) });
  });

  it("no key: the candidate pairs are listed unclassified", async () => {
    expect((await cli(["catalog", "analyze", "--real", "--json"])).json.data.pairs[0].classification).toBeUndefined();
  });

  it("lists completeness gaps (a persona with no approved job)", async () => {
    const complete = (await cli(["catalog", "analyze", "--json"])).json.data.groups.find((g: { characteristic: string }) => g.characteristic === "complete");
    expect(complete.findings.map((f: Finding) => f.code)).toContain("gap.persona-no-approved-job:reader");
  });

  it("advises re-reviewing an item edited since its approval", async () => {
    await cli(["job", "approve", "read-post", "--json", "--non-interactive-approval", "test"]);
    const jobs = JSON.parse(await readFile(join(catalogDir, "jobs.json"), "utf8")) as Array<Record<string, unknown>>;
    await writeJobs(jobs.map((j) => (j.id === "read-post" ? { ...j, outcome: "learn the latest news" } : j)));
    const correct = (await cli(["catalog", "analyze", "--json"])).json.data.groups.find((g: { characteristic: string }) => g.characteristic === "correct");
    expect(correct.findings.map((f: Finding) => f.code)).toContain("update.stale:job:read-post");
  });

  it("never writes a catalog file", async () => {
    classify("conflicting", 0.9);
    const before = await catalogBytes();
    await cli(["catalog", "analyze", "--real", "--json"]);
    expect(await catalogBytes()).toBe(before);
  });

  it("never fails on its findings (advisory: exit 0)", async () => {
    classify("conflicting", 0.99);
    expect((await cli(["catalog", "analyze", "--real", "--json"])).code).toBe(0);
  });

  it("the text report groups findings by GtWR set characteristic", async () => {
    expect((await cli(["catalog", "analyze"])).out).toMatch(/FINDINGS BY GTWR SET CHARACTERISTIC[\s\S]*GtWR: complete:/);
  });
});

describe("#435 MCP: read-only analyze_catalog", () => {
  function tool(name: string): (args: Record<string, unknown>) => Promise<any> {
    const mcpDeps: McpApiDeps = { journeysDir, pathRoots: [root], runCli: makeInProcessCliRunner(() => buildProgram(deps())) };
    const t = buildMcpTools(mcpDeps).find((x) => x.name === name)!;
    return async (args) => JSON.parse((await t.handler(args)).content[0]!.text);
  }

  it("returns the CLI's report", async () => {
    const fromCli = (await cli(["catalog", "analyze", "--json"])).json.data;
    expect((await tool("analyze_catalog")({})).data).toEqual(fromCli);
  });

  it("is read-only", async () => {
    classify("conflicting", 0.9);
    const before = await catalogBytes();
    await tool("analyze_catalog")({ real: true });
    expect(await catalogBytes()).toBe(before);
  });

  it("review_job takes readiness (parity with --readiness)", async () => {
    expect((await tool("review_job")({ id: "keep-private", readiness: true })).data.findings.some((f: Finding) => f.analyzer === "readiness")).toBe(true);
  });
});
