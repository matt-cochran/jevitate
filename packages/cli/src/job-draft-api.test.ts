import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ProfileManager } from "@jevitate/daemon";
import { JobSchema } from "@jevitate/journey";
import { buildProgram } from "./program.js";
import { buildMcpTools } from "./mcp-api.js";
import { makeInProcessCliRunner } from "./mcp-cli-runner.js";
import type { CliDeps } from "./cli-shared.js";
import { jobContentHash } from "./catalog.js";
import { draftJobOutcomes, type DraftJobOutcomesRequest } from "./job-draft-api.js";

/** #465b — drafting desired outcomes for a job. Fake generator only: no network, no browser. */

const EXISTING = { id: "fast", direction: "minimize", measure: "time", object: "the time to complete the job" };
const BASE_JOB = {
  id: "invite",
  trigger: "a colleague joins my team",
  motivation: "invite them by email",
  outcome: "work together from their first day",
  steps: [{ id: "send", name: "Send the invitation" }],
  desiredOutcomes: [EXISTING],
};

let dir: string;
let jobsFile: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "jev-draft-"));
  await mkdir(join(dir, "journeys"), { recursive: true });
  jobsFile = join(dir, "jobs.json");
});
afterEach(() => rm(dir, { recursive: true, force: true }));

const writeJobs = (job: Record<string, unknown> = BASE_JOB) => writeFile(jobsFile, JSON.stringify([job]));
const readJob = async (): Promise<Record<string, unknown>> => (JSON.parse(await readFile(jobsFile, "utf8")) as Array<Record<string, unknown>>)[0]!;
const approved = (job: Record<string, unknown>) => ({ ...job, approval: { contentHash: jobContentHash(JobSchema.parse(job)), at: "2026-10-09T00:00:00Z" } });
const req = (over: Partial<DraftJobOutcomesRequest> = {}): DraftJobOutcomesRequest => ({
  catalogDir: dir,
  journeysDir: join(dir, "journeys"),
  jobId: "invite",
  count: 3,
  ai: { real: false, fakeAi: true },
  ...over,
});
const deps = {} as CliDeps;

describe("draftJobOutcomes (fake AI)", () => {
  it("drafts the requested number of outcomes", async () => {
    await writeJobs();
    expect((await draftJobOutcomes(req({ count: 2 }), deps)).outcomes).toHaveLength(2);
  });

  it("does not repeat an existing outcome", async () => {
    await writeJobs();
    expect((await draftJobOutcomes(req(), deps)).outcomes.map((o) => o.object)).not.toContain(EXISTING.object);
  });

  it("marks the job ai_draft when it had no provenance", async () => {
    await writeJobs();
    await draftJobOutcomes(req(), deps);
    expect((await readJob()).provenance).toBe("ai_draft");
  });

  it("does not downgrade a stronger job provenance", async () => {
    await writeJobs({ ...BASE_JOB, provenance: "team_hypothesis" });
    await draftJobOutcomes(req(), deps);
    expect((await readJob()).provenance).toBe("team_hypothesis");
  });

  it("lists the drafted outcome ids in the job's draft extension", async () => {
    await writeJobs();
    const r = await draftJobOutcomes(req({ count: 1 }), deps);
    expect((await readJob()).extensions).toEqual({ "jevitate-draft": { outcomes: r.outcomes.map((o) => o.id) } });
  });

  it("keeps the existing outcomes", async () => {
    await writeJobs();
    await draftJobOutcomes(req(), deps);
    expect(((await readJob()).desiredOutcomes as Array<{ id: string }>)[0]!.id).toBe("fast");
  });

  it("gives every outcome a unique id", async () => {
    await writeJobs();
    await draftJobOutcomes(req(), deps);
    const ids = ((await readJob()).desiredOutcomes as Array<{ id: string }>).map((o) => o.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("reports the draft as not approved", async () => {
    await writeJobs();
    expect((await draftJobOutcomes(req(), deps)).approved).toBe(false);
  });

  it("leaves a draft job a draft", async () => {
    await writeJobs();
    expect((await draftJobOutcomes(req(), deps)).approvalStatus).toBe("draft");
  });

  it("turns an approved job stale", async () => {
    await writeJobs(approved(BASE_JOB));
    expect((await draftJobOutcomes(req(), deps)).approvalStatus).toBe("stale");
  });

  it("keeps the old approval record untouched (never re-approves)", async () => {
    const before = approved(BASE_JOB);
    await writeJobs(before);
    await draftJobOutcomes(req(), deps);
    expect((await readJob()).approval).toEqual(before.approval);
  });

  it("refuses an unknown job", async () => {
    await writeJobs();
    await expect(draftJobOutcomes(req({ jobId: "nope" }), deps)).rejects.toThrow(/unknown job 'nope'/);
  });

  it("refuses a count outside 1-3", async () => {
    await writeJobs();
    await expect(draftJobOutcomes(req({ count: 4 }), deps)).rejects.toThrow(/count must be/);
  });

  it("refuses when no gateway is selected", async () => {
    await writeJobs();
    await expect(draftJobOutcomes(req({ ai: { real: false, fakeAi: false } }), deps)).rejects.toThrow(/no gateway selected/);
  });
});

describe("draft_job_outcomes over MCP", () => {
  const tool = () => {
    const cliDeps = { profiles: new ProfileManager(join(dir, "profiles")), dbPath: join(dir, "s.sqlite"), journeysDir: join(dir, "journeys"), catalogDir: dir, missionTargetsDir: join(dir, "t"), inboxDir: join(dir, "i") } as CliDeps;
    const runCli = makeInProcessCliRunner(() => buildProgram(cliDeps));
    return buildMcpTools({ journeysDir: join(dir, "journeys"), pathRoots: [dir], runCli }).find((t) => t.name === "draft_job_outcomes")!;
  };
  const call = async () => {
    const res = await tool().handler({ jobId: "invite", fakeAi: true, count: 2 });
    return JSON.parse(res.content[0]!.text) as { data?: { outcomes: unknown[]; approved: boolean; approvalStatus: string } };
  };

  it("returns the drafted outcomes", async () => {
    await writeJobs();
    expect((await call()).data?.outcomes).toHaveLength(2);
  });

  it("never approves (an approved job comes back stale)", async () => {
    await writeJobs(approved(BASE_JOB));
    expect((await call()).data).toMatchObject({ approved: false, approvalStatus: "stale" });
  });
});
