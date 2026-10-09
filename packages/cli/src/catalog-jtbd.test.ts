import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ProfileManager } from "@jevitate/daemon";
import { FakeClock, installClock, resetClock } from "@jevitate/domain";
import { FsJourneyStore, JobReviewSchema, type Journey } from "@jevitate/journey";
import { buildProgram } from "./program.js";
import type { CliDeps } from "./cli-shared.js";

/** #465 — job steps, desired outcomes and reference checks through the catalog commands. No browser. */

const JOB = {
  id: "invite",
  trigger: "a colleague joins my team",
  motivation: "invite them by email",
  outcome: "work together from their first day",
  personas: ["admin"],
  priority: "high",
  kind: "core",
  context: ["team plan"],
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
      gulf: "execution",
      metric: { kind: "duration", from: "members-open", to: "invite-sent", stat: "p50" },
      target: { op: "<=", value: 60, unit: "s" },
      guardrail: false,
      priority: "high",
    },
    { id: "invite-right", direction: "minimize", measure: "likelihood", object: "the likelihood of inviting the wrong person", metric: { kind: "error", at: "invite-sent" }, guardrail: true },
  ],
  constraints: ["SSO-only workspaces cannot invite by email"],
  provenance: "team_hypothesis",
  revision: 3,
  lastValidated: "2026-10-09",
  extensions: { journeeze: { board: "growth" } },
};

function journey(id: string, meta: Record<string, unknown> = {}): Journey {
  return {
    metadata: {
      id,
      name: `Journey ${id}`,
      promoted: false,
      params: [],
      createdAtIso: "2026-10-09T00:00:00Z",
      job: "invite",
      persona: "admin",
      anchors: [
        { name: "members-open", step: 1, jobStep: "choose", boundary: "start" },
        { name: "invite-sent", step: 2, jobStep: "send", boundary: "end" },
      ],
      serves: ["invite-fast"],
      endState: [{ kind: "reloadThen", assertion: { kind: "textIncludes", target: { testId: "members" }, text: "invited" } }],
      ...meta,
    },
    recording: {
      version: "1.0.0",
      site: "https://example.test",
      pages: [
        {
          url: "/members",
          steps: [
            { step: { kind: "navigate", url: "/members", expect: { kind: "urlIncludes", text: "/members" } } },
            {
              step: { kind: "click", target: { testId: "invite" }, expect: { kind: "textIncludes", target: { role: "status" }, text: "Invited" } },
              expectRequests: [{ kind: "responseStatus", method: "POST", pathGlob: "/api/invite", status: { class: 2 } }],
            },
          ],
        },
      ],
    },
  } as Journey;
}

let root: string;
let catalogDir: string;
let journeysDir: string;

async function writeJobs(jobs: unknown): Promise<void> {
  await writeFile(join(catalogDir, "jobs.json"), JSON.stringify(jobs, null, 2));
}

async function readJobs(): Promise<Record<string, unknown>[]> {
  return JSON.parse(await readFile(join(catalogDir, "jobs.json"), "utf8")) as Record<string, unknown>[];
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "jev-465-"));
  catalogDir = join(root, ".jevitate");
  journeysDir = join(catalogDir, "journeys");
  await mkdir(catalogDir, { recursive: true });
  await writeFile(join(catalogDir, "personas.json"), JSON.stringify([{ id: "admin", description: "runs the workspace", role: "admin" }]));
  await writeJobs([JOB]);
  await new FsJourneyStore(journeysDir).put(journey("invite-admin"));
  installClock(new FakeClock({ startMs: Date.parse("2026-10-09T12:00:00.000Z") }));
});

afterEach(() => {
  resetClock();
  process.exitCode = undefined;
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

const approveJob = () => cli(["job", "approve", "invite", "--json", "--non-interactive-approval", "test"]);
const BROKEN = { ...JOB, parent: "nobody" };
const refCodes = (issues: { code: string; path: string }[]) => issues.map((i) => `${i.code} ${i.path}`);

describe("#465 reference problems are warnings on load", () => {
  it("catalog status loads a job with a broken reference and lists it", async () => {
    await writeJobs([BROKEN]);
    const r = await cli(["catalog", "status", "--json"]);
    expect({ code: r.code, refs: refCodes(r.json.data.refIssues) }).toEqual({ code: 0, refs: ["job.unknown-parent parent"] });
  });

  it("they are warnings", async () => {
    await writeJobs([BROKEN]);
    expect((await cli(["catalog", "status", "--json"])).json.data.refIssues[0].severity).toBe("warning");
  });

  it("the status report has a reference checks section", async () => {
    await writeJobs([BROKEN]);
    expect((await cli(["catalog", "status"])).out).toContain("job invite · parent: parent 'nobody' is not a declared job");
  });

  it("a clean catalog reports none", async () => {
    expect((await cli(["catalog", "status", "--json"])).json.data.refIssues).toEqual([]);
  });

  it("catalog analyze reports them as findings", async () => {
    await writeJobs([BROKEN]);
    const groups = (await cli(["catalog", "analyze", "--json"])).json.data.groups as { findings: { code: string }[] }[];
    expect(groups.flatMap((g) => g.findings.map((f) => f.code))).toContain("ref.job.unknown-parent:invite:parent");
  });

  it("a Journey serving an unknown outcome is reported on the Journey", async () => {
    await new FsJourneyStore(journeysDir).put(journey("invite-admin", { serves: ["nope"] }));
    expect(refCodes((await cli(["catalog", "status", "--json"])).json.data.refIssues)).toEqual(["journey.unknown-serves metadata.serves[0]"]);
  });
});

describe("#465 the job review sheet", () => {
  it("carries the jtbd fields", async () => {
    const { json } = await cli(["job", "review", "invite", "--json"]);
    const { kind, context, steps, desiredOutcomes, constraints, provenance, revision, lastValidated, extensions } = JOB;
    expect(JobReviewSchema.parse(json.data)).toMatchObject({ kind, context, steps, desiredOutcomes, constraints, provenance, revision, lastValidated, extensions });
  });

  it("carries the parent", async () => {
    await writeJobs([{ ...JOB, parent: "grow-team" }, { id: "grow-team", trigger: "the team grows", motivation: "add people", outcome: "ship more" }]);
    expect((await cli(["job", "review", "invite", "--json"])).json.data.parent).toBe("grow-team");
  });

  it("renders each step with its stage", async () => {
    expect((await cli(["job", "review", "invite"])).out).toMatch(/choose.*Choose who to invite.*\(define\)/);
  });

  it("renders a desired outcome with its metric and target", async () => {
    expect((await cli(["job", "review", "invite"])).out).toMatch(/invite-fast.*minimize time.*duration p50 from members-open to invite-sent.*target <= 60 s/);
  });

  it("marks a guardrail", async () => {
    expect((await cli(["job", "review", "invite"])).out).toMatch(/invite-right.*GUARDRAIL/);
  });

  it("renders the extensions by namespace", async () => {
    expect((await cli(["job", "review", "invite"])).out).toContain('journeeze: {"board":"growth"}');
  });

  it("lists the job's reference problems", async () => {
    await writeJobs([BROKEN]);
    expect(refCodes((await cli(["job", "review", "invite", "--json"])).json.data.refIssues)).toEqual(["job.unknown-parent parent"]);
  });

  it("…and those of the Journeys linked to it", async () => {
    await new FsJourneyStore(journeysDir).put(journey("invite-admin", { anchors: [{ name: "members-open", step: 1, jobStep: "nope" }, { name: "invite-sent", step: 2 }] }));
    expect(refCodes((await cli(["job", "review", "invite", "--json"])).json.data.refIssues)).toEqual(["journey.unknown-job-step metadata.anchors[0].jobStep"]);
  });

  it("the text sheet shows them", async () => {
    await writeJobs([BROKEN]);
    expect((await cli(["job", "review", "invite"])).out).toMatch(/reference checks[\s\S]*parent 'nobody' is not a declared job/i);
  });
});

describe("#465 approval", () => {
  it("refuses a job with a broken reference (E_JOB_BROKEN_REF, exit 64)", async () => {
    await writeJobs([BROKEN]);
    const r = await approveJob();
    expect([r.json.error.code, r.code]).toEqual(["E_JOB_BROKEN_REF", 64]);
  });

  it("…says which reference", async () => {
    await writeJobs([BROKEN]);
    expect((await approveJob()).json.error.message).toContain("parent 'nobody' is not a declared job");
  });

  it("…and records no approval", async () => {
    await writeJobs([BROKEN]);
    await approveJob();
    expect((await readJobs())[0]!.approval).toBeUndefined();
  });

  it("an unmeasurable metric does not block it (a gap, not an error)", async () => {
    await writeJobs([{ ...JOB, desiredOutcomes: [{ ...JOB.desiredOutcomes[1], metric: { kind: "abandon", at: "no-such-anchor" } }] }]);
    await approveJob();
    expect((await cli(["job", "review", "invite", "--json"])).json.data.status).toBe("approved");
  });

  it("a Journey with a broken serves id still promotes (a warning in 0.10)", async () => {
    await new FsJourneyStore(journeysDir).put(journey("invite-admin", { serves: ["nope"] }));
    await cli(["persona", "approve", "admin", "--json", "--non-interactive-approval", "test"]);
    await approveJob();
    expect((await cli(["journey", "promote", "invite-admin", "--json", "--non-interactive-approval", "test"])).json.data.promoted).toBe(true);
  });
});

describe("#465 jobs.json round trip and the content hash", () => {
  it("approving keeps every jtbd field verbatim", async () => {
    await approveJob();
    const { approval: _a, ...rest } = (await readJobs())[0]!;
    expect(rest).toEqual(JOB);
  });

  it("the hash ignores key order", async () => {
    await approveJob();
    const [saved] = await readJobs();
    await writeJobs([Object.fromEntries(Object.entries(saved!).reverse())]);
    expect((await cli(["job", "review", "invite", "--json"])).json.data.status).toBe("approved");
  });

  it("changing an extension makes the approval stale", async () => {
    await approveJob();
    const [saved] = await readJobs();
    await writeJobs([{ ...saved, extensions: { journeeze: { board: "retention" } } }]);
    expect((await cli(["job", "review", "invite", "--json"])).json.data.status).toBe("stale");
  });

  it("changing a target makes the approval stale", async () => {
    await approveJob();
    const [saved] = await readJobs();
    await writeJobs([{ ...saved, desiredOutcomes: [{ ...JOB.desiredOutcomes[0], target: { op: "<=", value: 30, unit: "s" } }, JOB.desiredOutcomes[1]] }]);
    expect((await cli(["job", "review", "invite", "--json"])).json.data.status).toBe("stale");
  });
});
