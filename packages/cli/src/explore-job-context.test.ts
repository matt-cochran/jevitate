import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ProfileManager } from "@jevitate/daemon";
import { FakeGenerationGateway, FakeJudgmentGateway } from "@jevitate/ai-core";
import type { RunExplorationOptions, RunExplorationResult } from "./explore-goal.js";
import { jobContentHash } from "./catalog.js";
import { JOB_CONTEXT_MAX_CHARS, jobContextBrief } from "./explore-job-context.js";

/**
 * #873 — `explore --job <id> --job-context`: the approved job's story, context and constraints
 * reach the goal run as its mission brief. Opt-in, approved-only, size-capped, refused before any
 * run otherwise. `runExploration` is replaced by a capture (no browser).
 */
const calls: RunExplorationOptions[] = [];

vi.mock("./explore-goal.js", async (importOriginal) => {
  const real = await importOriginal<typeof import("./explore-goal.js")>();
  return {
    ...real,
    runExploration: vi.fn(async (opts: RunExplorationOptions): Promise<RunExplorationResult> => {
      calls.push(opts);
      // A real run's journal writes its result before the claims are evaluated (the CLI adds them to it).
      const resultPath = join(dir, `explore-${calls.length}.result.json`);
      writeFileSync(resultPath, `${JSON.stringify({ missionOutcome: "clean", exitCode: 0, result: { strategy: "goal", resultPath } }, null, 2)}\n`);
      return {
        resultPath,
        goalOutcome: "succeeded",
        outcome: "succeeded",
        defectOutcome: { status: "none", byKind: {} },
        stop: "done",
        runOutcome: { status: "completed", verifiedBy: "success-condition" },
        checks: [{ check: "urlIncludes:/done", passed: true, detail: "held" }],
        decisions: 1,
        actions: 1,
        finalUrl: "http://127.0.0.1:3000/done",
      } as unknown as RunExplorationResult;
    }),
  };
});

const { buildProgram } = await import("./program.js");

const STORY = { trigger: "a new colleague joins my team", motivation: "invite them by email", outcome: "work together from their first day" };
const JOB = {
  id: "invite-teammate",
  ...STORY,
  personas: ["admin"],
  context: ["the invite form is under Settings > Team"],
  constraints: ["never invite more than one person per run"],
};

let dir: string;
function writeJobs(jobs: unknown[]): void {
  writeFileSync(join(dir, "jobs.json"), JSON.stringify(jobs, null, 2));
}
const approved = (job: typeof JOB & Record<string, unknown>) => ({
  ...job,
  approval: { contentHash: jobContentHash(job as never), at: "2026-11-18T00:00:00.000Z" },
});

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "jev-job-context-"));
  writeFileSync(join(dir, "personas.json"), JSON.stringify([{ id: "admin", description: "Runs the team", role: "admin" }]));
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));
afterEach(() => {
  calls.length = 0;
  process.exitCode = undefined;
});

async function cli(args: string[]): Promise<{ out: string; exitCode: number | undefined }> {
  const out: string[] = [];
  const program = buildProgram({
    profiles: new ProfileManager("/unused"),
    journeysDir: join(dir, "journeys"),
    catalogDir: dir,
    explore: { judge: new FakeJudgmentGateway({}), gen: new FakeGenerationGateway(), targetsConfigPath: join(dir, "no-targets.json") },
  });
  program.configureOutput({ writeOut: (s) => out.push(s), writeErr: () => undefined });
  const overrideExit = (command: ReturnType<typeof buildProgram>): void => {
    command.exitOverride();
    for (const child of command.commands) overrideExit(child);
  };
  overrideExit(program);
  process.exitCode = undefined;
  await program.parseAsync(args, { from: "user" });
  const exitCode = process.exitCode;
  process.exitCode = undefined;
  return { out: out.join(""), exitCode };
}

const RUN = ["explore", "--url", "http://127.0.0.1:3000/", "--goal", "invite a teammate", "--success", "urlIncludes:/done", "--fake-ai", "--json"];

describe("explore --job --job-context (#873)", () => {
  it("passes the approved job's story to the run as its mission brief", async () => {
    writeJobs([approved(JOB)]);
    await cli([...RUN, "--job", "invite-teammate", "--job-context"]);
    expect(calls[0]?.missionBrief).toContain("When a new colleague joins my team, I want to invite them by email");
  });

  it("includes the job's context", async () => {
    writeJobs([approved(JOB)]);
    await cli([...RUN, "--job", "invite-teammate", "--job-context"]);
    expect(calls[0]?.missionBrief).toContain("the invite form is under Settings > Team");
  });

  it("includes the job's constraints", async () => {
    writeJobs([approved(JOB)]);
    await cli([...RUN, "--job", "invite-teammate", "--job-context"]);
    expect(calls[0]?.missionBrief).toContain("never invite more than one person per run");
  });

  it("without --job-context, --job adds no brief (existing runs unchanged)", async () => {
    writeJobs([approved(JOB)]);
    await cli([...RUN, "--job", "invite-teammate"]);
    expect(calls[0]?.missionBrief).toBeUndefined();
  });

  it("records which job content was supplied (its content hash) in the result", async () => {
    writeJobs([approved(JOB)]);
    const r = await cli([...RUN, "--job", "invite-teammate", "--job-context"]);
    expect(JSON.parse(r.out).data.jobContext).toEqual({ job: "invite-teammate", contentHash: jobContentHash(JOB as never) });
  });

  it("refuses a draft (never approved) job before any run", async () => {
    writeJobs([JOB]);
    const r = await cli([...RUN, "--job", "invite-teammate", "--job-context"]);
    expect(JSON.parse(r.out).error.message).toMatch(/not approved/);
  });

  it("a refused job starts no run", async () => {
    writeJobs([JOB]);
    await cli([...RUN, "--job", "invite-teammate", "--job-context"]);
    expect(calls).toHaveLength(0);
  });

  it("refuses a job that changed since its approval (stale)", async () => {
    writeJobs([{ ...approved(JOB), outcome: "something else entirely" }]);
    const r = await cli([...RUN, "--job", "invite-teammate", "--job-context"]);
    expect(JSON.parse(r.out).error.message).toMatch(/changed since its approval/);
  });

  it("refuses --job-context without --job", async () => {
    writeJobs([approved(JOB)]);
    const r = await cli([...RUN, "--job-context"]);
    expect(JSON.parse(r.out).error.message).toMatch(/--job-context needs --job/);
  });
});

describe("jobContextBrief", () => {
  const job = { ...JOB, story: "When a new colleague joins my team, I want to invite them by email, so I can work together from their first day." };

  it("leaves out empty context and constraints", () => {
    const brief = jobContextBrief({ ...job, context: [], constraints: [] });
    expect(brief.ok && brief.brief).not.toMatch(/context:|constraints/);
  });

  it("refuses a brief over the cap instead of truncating it", () => {
    const brief = jobContextBrief({ ...job, context: ["x".repeat(JOB_CONTEXT_MAX_CHARS)] });
    expect(brief.ok ? "accepted" : brief.message).toMatch(/longer than/);
  });
});

describe("#874 guidance in --job-context", () => {
  const GUIDED = {
    ...JOB,
    guidance: {
      aliases: [{ term: "workspace", uiTerms: ["piece", "draft"] }],
      expectedStates: ["the team page lists the invite as Pending"],
      claims: [{ id: "one-seat", statement: "an invite uses exactly one free seat" }],
    },
  };

  it("tells the model the UI words for the job's terms", async () => {
    writeJobs([approved(GUIDED)]);
    await cli([...RUN, "--job", "invite-teammate", "--job-context"]);
    expect(calls[0]?.missionBrief).toContain('"workspace" may appear as "piece" or "draft"');
  });

  it("tells the model the states the job passes through", async () => {
    writeJobs([approved(GUIDED)]);
    await cli([...RUN, "--job", "invite-teammate", "--job-context"]);
    expect(calls[0]?.missionBrief).toContain("the team page lists the invite as Pending");
  });

  it("never tells the model a claim (claims are checked, not given)", async () => {
    writeJobs([approved(GUIDED)]);
    await cli([...RUN, "--job", "invite-teammate", "--job-context"]);
    expect(calls[0]?.missionBrief).not.toContain("exactly one free seat");
  });

  it("the result carries one verdict per claim", async () => {
    writeJobs([approved(GUIDED)]);
    const r = await cli([...RUN, "--job", "invite-teammate", "--job-context"]);
    expect(JSON.parse(r.out).data.claims.map((c: { id: string }) => c.id)).toEqual(["one-seat"]);
  });

  it("a claim never changes the run's exit code", async () => {
    writeJobs([approved(GUIDED)]);
    const r = await cli([...RUN, "--job", "invite-teammate", "--job-context"]);
    expect(r.exitCode ?? 0).toBe(0);
  });

  it("a job without claims reports no claims section", async () => {
    writeJobs([approved(JOB)]);
    const r = await cli([...RUN, "--job", "invite-teammate", "--job-context"]);
    expect("claims" in JSON.parse(r.out).data).toBe(false);
  });
});
