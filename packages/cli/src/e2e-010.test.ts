import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import Ajv2020 from "ajv/dist/2020.js";
import { ProfileManager } from "@jevitate/daemon";
import { FakeClock, installClock, resetClock } from "@jevitate/domain";
import { FsJourneyStore, type Journey } from "@jevitate/journey";
import { buildProgram } from "./program.js";
import { buildMcpTools } from "./mcp-api.js";
import { makeInProcessCliRunner } from "./mcp-cli-runner.js";
import type { CliDeps } from "./cli-shared.js";
import type { JourneezeHttpRequest } from "./journeeze-connect.js";

/**
 * 0.10 end to end, in process (CLI + MCP), fake AI, no network, no browser: a small project → a job
 * with steps and outcomes → `job draft-outcomes --fake-ai` → a Journey promoted with job-step
 * anchors → `journey migrate --step-ids --dry-run` → `locator-health` → `catalog export` (the bundle
 * validates against the pinned contract schema) → `publish journeeze --dry-run` with an env key
 * against a fake transport that sees only the key check (`GET /whoami`), never an upload. The cases run in order on one project.
 */

const KEY = "jzu_abcdefghijklmnopqrstuvwxyz234567abcdefgh";
const FIXTURES = fileURLToPath(new URL("../test-fixtures/", import.meta.url));
const Ajv = Ajv2020 as unknown as typeof Ajv2020.default;
const validateBundle = new Ajv({ allErrors: true, strict: false }).compile(JSON.parse(readFileSync(join(FIXTURES, "catalog-bundle.v1.json"), "utf8")) as object);

const JOB = {
  id: "invite",
  trigger: "a colleague joins my team",
  motivation: "invite them by email",
  outcome: "work together from their first day",
  personas: ["admin"],
  kind: "core",
  steps: [
    { id: "choose", name: "Choose who to invite", stage: "define" },
    { id: "send", name: "Send the invitation", stage: "execute" },
  ],
  desiredOutcomes: [
    {
      id: "invite-fast",
      step: "send",
      direction: "minimize",
      measure: "time",
      object: "the time it takes to get a teammate invited",
      metric: { kind: "duration", from: "job_start", to: "invite-sent", stat: "p50" },
      target: { op: "<=", value: 60, unit: "s" },
    },
  ],
};

/** The Journey under test: job-step anchors, one test-id target and one positional css target. */
const INVITE: Journey = {
  metadata: {
    id: "invite-admin",
    name: "Invite a teammate",
    promoted: false,
    params: [],
    createdAtIso: "2026-10-09T00:00:00Z",
    job: "invite",
    persona: "admin",
    anchors: [
      { name: "members-open", step: 1, jobStep: "choose", boundary: "start" },
      { name: "invite-sent", step: 3, jobStep: "send", boundary: "end" },
    ],
    serves: ["invite-fast"],
    endState: [{ kind: "reloadThen", assertion: { kind: "textIncludes", target: { testId: "members" }, text: "invited" } }],
  },
  recording: {
    version: "1.0.0",
    site: "https://example.test",
    pages: [
      {
        url: "/members",
        steps: [
          { step: { kind: "navigate", url: "/members", expect: { kind: "urlIncludes", text: "/members" } } },
          { step: { kind: "click", target: { css: "main > div:nth-of-type(2) > button" }, expect: { kind: "textIncludes", target: { testId: "dialog" }, text: "Invite" } } },
          {
            step: { kind: "click", target: { testId: "invite" }, expect: { kind: "textIncludes", target: { role: "status" }, text: "Invited" } },
            expectRequests: [{ kind: "responseStatus", method: "POST", pathGlob: "/api/invite", status: { class: 2 } }],
          },
        ],
      },
    ],
  },
} as Journey;

/** A pre-0.10 Journey: promoted and approved, its steps without ids (what `journey migrate` backfills). */
const LEGACY = {
  metadata: { id: "legacy", name: "Legacy", promoted: true, params: [], createdAtIso: "2026-09-01T00:00:00Z", approval: { contentHash: "0".repeat(64), at: "2026-09-01T00:00:00Z" } },
  recording: { version: "1.0.0", site: "https://example.test", pages: [{ url: "/", steps: [{ step: { kind: "click", target: { testId: "go" }, expect: { kind: "textIncludes", target: { testId: "ok" }, text: "OK" } } }] }] },
};

let root: string;
let catalogDir: string;
let journeysDir: string;
const sent: JourneezeHttpRequest[] = [];

const NOT_A_TTY = { env: {}, stdinIsTTY: () => false, stdoutIsTTY: () => false, user: () => "tester" };

function deps(): CliDeps {
  return {
    profiles: new ProfileManager(join(root, "profiles")),
    journeysDir,
    catalogDir,
    explore: { targetsConfigPath: join(root, "no-targets.json") },
    approval: NOT_A_TTY,
    journeeze: {
      env: { JOURNEEZE_UPLOAD_KEY: KEY },
      homedir: () => join(root, "home"),
      http: async (req) => {
        sent.push(req);
        if (req.method === "GET" && req.url.endsWith("/whoami")) {
          return { status: 200, headers: { get: () => null }, text: async () => JSON.stringify({ product: { id: "p-ledgerly", name: "Ledgerly" }, tenant: { name: "Ledgerly Inc" }, keyPrefix: "jzu_abcd" }) };
        }
        return { status: 500, headers: { get: () => null }, text: async () => "{}" };
      },
    },
  } as CliDeps;
}

async function cli(argv: readonly string[]): Promise<{ json: any; code: number | undefined }> {
  const lines: string[] = [];
  const program = buildProgram(deps());
  program.configureOutput({ writeOut: (s) => lines.push(s), writeErr: () => {} });
  program.exitOverride();
  process.exitCode = undefined;
  await program.parseAsync([...argv], { from: "user" });
  const code = process.exitCode === undefined ? undefined : Number(process.exitCode);
  process.exitCode = undefined;
  return { json: JSON.parse(lines.join("")), code };
}

async function mcp(tool: string, args: Record<string, unknown>): Promise<any> {
  const tools = buildMcpTools({ journeysDir, pathRoots: [root], runCli: makeInProcessCliRunner(() => buildProgram(deps())) });
  const res = await tools.find((t) => t.name === tool)!.handler(args);
  return JSON.parse(res.content[0]!.text);
}

const jobs = async (): Promise<any[]> => JSON.parse(await readFile(join(catalogDir, "jobs.json"), "utf8"));
const stored = async (id: string): Promise<Journey> => (await new FsJourneyStore(journeysDir).get(id))!;

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "jev-e2e-010-"));
  catalogDir = join(root, ".jevitate");
  journeysDir = join(catalogDir, "journeys");
  await mkdir(journeysDir, { recursive: true });
  await writeFile(join(root, "package.json"), JSON.stringify({ name: "ledgerly" }));
  await writeFile(join(catalogDir, "personas.json"), JSON.stringify([{ id: "admin", description: "runs the workspace", role: "admin" }]));
  await writeFile(join(catalogDir, "jobs.json"), JSON.stringify([JOB], null, 2));
  await writeFile(join(journeysDir, "invite-admin.json"), JSON.stringify(INVITE));
  await writeFile(join(journeysDir, "legacy.json"), JSON.stringify(LEGACY));
  installClock(new FakeClock({ startMs: Date.parse("2026-10-09T12:00:00.000Z") }));
});

afterAll(async () => {
  resetClock();
  await rm(root, { recursive: true, force: true });
});

describe("0.10 end to end: catalog → Journey → health → bundle → Journeeze", () => {
  it("job draft-outcomes --fake-ai lists two drafted outcomes under extensions[\"jevitate-draft\"]", async () => {
    await cli(["job", "draft-outcomes", "invite", "--fake-ai", "--count", "2", "--json"]);
    expect((await jobs())[0].extensions["jevitate-draft"].outcomes).toHaveLength(2);
  });

  it("draft_job_outcomes (MCP) never approves", async () => {
    const r = await mcp("draft_job_outcomes", { jobId: "invite", fakeAi: true, count: 1 });
    expect(r.data.approved).toBe(false);
  });

  it("the job and persona are approved by a scripted setup", async () => {
    const codes = [(await cli(["persona", "approve", "admin", "--json", "--non-interactive-approval", "e2e"])).code, (await cli(["job", "approve", "invite", "--json", "--non-interactive-approval", "e2e"])).code];
    expect(codes).toEqual([0, 0]);
  });

  it("journey promote stamps each job-step anchor with its step's stable id", async () => {
    await cli(["journey", "promote", "invite-admin", "--json", "--non-interactive-approval", "e2e"]);
    const j = await stored("invite-admin");
    const ids = j.recording.pages[0]!.steps.map((s) => s.stepId);
    expect(j.metadata.anchors?.map((a) => a.stepId)).toEqual([ids[0], ids[2]]);
  });

  it("journey migrate --step-ids --dry-run reports the legacy Journey's missing ids", async () => {
    const { json } = await cli(["journey", "migrate", "--step-ids", "--dry-run", "--json"]);
    expect(json.data.journeys.filter((j: any) => j.stepsMinted > 0).map((j: any) => j.id)).toEqual(["legacy"]);
  });

  it("journey migrate --dry-run writes nothing", async () => {
    expect((await stored("legacy")).recording.pages[0]!.steps[0]!.stepId).toBeUndefined();
  });

  it("locator_health (MCP) flags the positional css step as the promoted Journey's one brittle step", async () => {
    const r = await mcp("locator_health", { journey: "invite-admin" });
    expect(r.data.summary.brittle).toBe(1);
  });

  it("catalog export writes a bundle that validates against the pinned contract schema", async () => {
    const { json } = await cli(["catalog", "export", "--format", "journeeze-bundle", "--out", join(root, "bundle"), "--product-name", "Ledgerly", "--json"]);
    const bundle = JSON.parse(await readFile(json.data.bundlePath, "utf8"));
    expect(validateBundle(bundle) ? [] : validateBundle.errors).toEqual([]);
  });

  it("export_catalog_bundle (MCP) exports both promoted Journeys and the job", async () => {
    const r = await mcp("export_catalog_bundle", { format: "journeeze-bundle", out: join(root, "bundle-mcp") });
    expect({ journeys: r.data.counts.journeys, jobs: r.data.counts.jobs }).toEqual({ journeys: 2, jobs: 1 });
  });

  it("publish journeeze --dry-run with the env key reports a dry run", async () => {
    const { json } = await cli(["publish", "journeeze", "--dry-run", "--json"]);
    expect(json.data.status).toBe("dry-run");
  });

  it("publish journeeze --dry-run only checks the key and uploads nothing", () => {
    expect(sent.map((r) => r.method)).toEqual(["GET"]);
  });
});
