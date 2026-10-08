import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ProfileManager } from "@jevitate/daemon";
import { FakeClock, installClock, resetClock } from "@jevitate/domain";
import { FAKE_CALL_USAGE, UsageTracker, type Answer, type JudgmentPort, type JudgmentState, type Question } from "@jevitate/ai-core";
import { FsJourneyStore, type Finding, type Journey } from "@jevitate/journey";
import { buildProgram } from "./program.js";
import { writeVerifyRecord } from "./journey-review-store.js";
import { journeyReviewHash } from "./journey-review.js";
import type { CliDeps } from "./cli-shared.js";

/** #434 — the Readiness section: deterministic checks + GtWR rules, and the advisory Jev questions. No browser, no live model. */

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

const JOB = { id: "publish-post", trigger: "a draft is ready", motivation: "publish it", outcome: "readers see it", personas: ["editor"] };

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
  root = await mkdtemp(join(tmpdir(), "jev-434-"));
  catalogDir = join(root, ".jevitate");
  journeysDir = join(catalogDir, "journeys");
  await mkdir(catalogDir, { recursive: true });
  await writeFile(join(catalogDir, "personas.json"), JSON.stringify([{ name: "editor", description: "writes and publishes posts", role: "editor" }]));
  await writeJobs([JOB]);
  const store = new FsJourneyStore(journeysDir);
  await store.put(journey("publish", { job: "publish-post", persona: "editor" }));
  await store.put(journey("loose"));
  usage = new UsageTracker();
  judge = undefined;
  env = {};
  installClock(new FakeClock({ startMs: Date.parse("2026-10-08T12:00:00.000Z") }));
});

afterEach(() => {
  resetClock();
  process.exitCode = undefined;
});

function useJudge(answer: (name: string, q: Question, state: JudgmentState) => Answer): ScriptedJudge {
  judge = new ScriptedJudge(answer, usage);
  return judge;
}

function deps(): CliDeps {
  return {
    profiles: new ProfileManager(join(root, "profiles")),
    journeysDir,
    catalogDir,
    explore: { targetsConfigPath: join(root, "no-targets.json"), env, localConfig: {}, usage, ...(judge === undefined ? {} : { judge }) },
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

async function findings(argv: readonly string[]): Promise<Finding[]> {
  return (await cli([...argv, "--json"])).json.data.findings as Finding[];
}

const byCode = (fs: readonly Finding[], code: string): Finding | undefined => fs.find((f) => f.code === code);

describe("#434 deterministic readiness — Journeys", () => {
  it("warns when a Journey links no job and no persona", async () => {
    expect(byCode(await findings(["journey", "review", "loose", "--readiness"]), "readiness.links")?.severity).toBe("warn");
  });

  it("passes when it links an existing job and persona", async () => {
    expect(byCode(await findings(["journey", "review", "publish", "--readiness"]), "readiness.links")?.severity).toBe("info");
  });

  it("warns when its job and persona are not approved", async () => {
    expect(byCode(await findings(["journey", "review", "publish", "--readiness"]), "readiness.links-approved")?.severity).toBe("warn");
  });

  it("passes the approval check once both are approved", async () => {
    await cli(["persona", "approve", "editor", "--json", "--non-interactive-approval", "test"]);
    await cli(["job", "approve", "publish-post", "--json", "--non-interactive-approval", "test"]);
    expect(byCode(await findings(["journey", "review", "publish", "--readiness"]), "readiness.links-approved")?.severity).toBe("info");
  });

  it("warns when the intent is incomplete (no goal)", async () => {
    expect(byCode(await findings(["journey", "review", "publish", "--readiness"]), "readiness.intent")?.message).toMatch(/no goal/);
  });

  it("passes the intent check when goal, criteria, objectives and expected results are written", async () => {
    const j = journey("intent", { goal: "publish a post", successCriteria: [{ description: "the post is live" }] });
    const step = j.recording.pages[0]!.steps[0]!;
    j.recording.pages[0]!.steps[0] = { ...step, objective: "publish the draft", expectedResult: "the post shows as published" } as typeof step;
    await new FsJourneyStore(journeysDir).put(j);
    expect(byCode(await findings(["journey", "review", "intent", "--readiness"]), "readiness.intent")?.severity).toBe("info");
  });

  it("reports the lint result", async () => {
    expect(byCode(await findings(["journey", "review", "publish", "--readiness"]), "readiness.lint")?.severity).toBe("info");
  });

  it("fails the lint check when the assertions cannot prove the outcome", async () => {
    const weak = journey("weak", { endState: [] });
    weak.recording.pages[0]!.steps[0] = { step: { kind: "click", target: { testId: "publish" }, expect: { kind: "visible", target: { testId: "publish" } } } };
    await new FsJourneyStore(journeysDir).put(weak);
    expect(byCode(await findings(["journey", "review", "weak", "--readiness"]), "readiness.lint")?.severity).toBe("fail");
  });

  it("warns when the mutation proof never ran", async () => {
    expect(byCode(await findings(["journey", "review", "publish", "--readiness"]), "readiness.verify")?.message).toMatch(/never ran/);
  });

  it("warns when the mutation proof is for an older version", async () => {
    await writeVerifyRecord(journeysDir, { journeyId: "publish", contentHash: "0".repeat(64), verdict: "proven", summary: {}, at: "2026-10-01T00:00:00Z" });
    expect(byCode(await findings(["journey", "review", "publish", "--readiness"]), "readiness.verify")?.message).toMatch(/older version/);
  });

  it("passes when the mutation proof is current and proven", async () => {
    const j = await new FsJourneyStore(journeysDir).get("publish");
    await writeVerifyRecord(journeysDir, { journeyId: "publish", contentHash: journeyReviewHash(j!), verdict: "proven", summary: {}, at: "2026-10-01T00:00:00Z" });
    expect(byCode(await findings(["journey", "review", "publish", "--readiness"]), "readiness.verify")?.severity).toBe("info");
  });
});

describe("#434 deterministic readiness — jobs and personas", () => {
  it("passes the job story parts check", async () => {
    expect(byCode(await findings(["job", "review", "publish-post", "--readiness"]), "readiness.story")?.severity).toBe("info");
  });

  it("warns when the job's persona is not approved", async () => {
    expect(byCode(await findings(["job", "review", "publish-post", "--readiness"]), "readiness.personas")?.severity).toBe("warn");
  });

  it("warns when a persona has no job", async () => {
    await writeJobs([]);
    expect(byCode(await findings(["persona", "review", "editor", "--readiness"]), "readiness.jobs")?.severity).toBe("warn");
  });

  it("GtWR findings appear in the sheet with their rule id and characteristic", async () => {
    await writeJobs([{ ...JOB, outcome: "readers find it easily" }]);
    expect(byCode(await findings(["job", "review", "publish-post", "--readiness"]), "gtwr:vague-term@outcome")).toMatchObject({ severity: "warn", characteristic: "unambiguous" });
  });

  it("the text sheet shows the GtWR rule in its Readiness section", async () => {
    await writeJobs([{ ...JOB, outcome: "readers find it easily" }]);
    expect((await cli(["job", "review", "publish-post", "--readiness"])).out).toMatch(/READINESS[\s\S]*rule gtwr:vague-term, GtWR: unambiguous/);
  });

  it("there is no readiness section without --readiness", async () => {
    expect((await findings(["job", "review", "publish-post"])).filter((f) => f.analyzer.startsWith("readiness"))).toEqual([]);
  });

  it("every approval runs the readiness checks", async () => {
    expect((await cli(["job", "approve", "publish-post", "--json", "--non-interactive-approval", "test"])).json.data.findings.some((f: Finding) => f.code === "readiness.story")).toBe(true);
  });
});

describe("#434 Jev readiness (advisory)", () => {
  it("a low Jev probability becomes a 'not ready because … (GtWR: …)' item", async () => {
    useJudge((name, q) => (q.kind === "choice" ? compatible : noul(name === "verifiable" ? 0.2 : 0.9)));
    expect(byCode(await findings(["job", "review", "publish-post", "--readiness", "--real"]), "jev.verifiable")?.message).toMatch(/^not ready because .*\(GtWR: verifiable\)/);
  });

  it("each Jev answer carries its probability", async () => {
    useJudge((name, q) => (q.kind === "choice" ? compatible : noul(name === "verifiable" ? 0.2 : 0.9)));
    expect(byCode(await findings(["job", "review", "publish-post", "--readiness", "--real"]), "jev.verifiable")?.probability).toBe(0.2);
  });

  it("asks the Journey whether its steps accomplish the job's outcome", async () => {
    useJudge((_n, q) => (q.kind === "choice" ? compatible : noul(0.9)));
    expect(byCode(await findings(["journey", "review", "publish", "--readiness", "--real"]), "jev.accomplishes_outcome")?.severity).toBe("info");
  });

  it("no judgment key: the Jev layer says skipped", async () => {
    expect(byCode(await findings(["job", "review", "publish-post", "--readiness", "--real"]), "jev.skipped")?.message).toMatch(/skipped: no judgment key/);
  });

  it("no key: the deterministic layer still runs", async () => {
    expect(byCode(await findings(["job", "review", "publish-post", "--readiness", "--real"]), "readiness.story")).toBeDefined();
  });

  it("without --real the Jev layer says to pass --real", async () => {
    expect(byCode(await findings(["job", "review", "publish-post", "--readiness"]), "jev.skipped")?.message).toMatch(/pass --real/);
  });

  it("Jev findings never require an acknowledgment", async () => {
    useJudge((_n, q) => (q.kind === "choice" ? compatible : noul(0.01)));
    expect((await findings(["job", "review", "publish-post", "--readiness", "--real"])).filter((f) => f.analyzer === "readiness-jev" && f.requiresAcknowledgment)).toEqual([]);
  });

  it("all-low Jev answers never change an approval's exit code", async () => {
    useJudge((_n, q) => (q.kind === "choice" ? compatible : noul(0.01)));
    await cli(["persona", "approve", "editor", "--json", "--non-interactive-approval", "test"]);
    expect((await cli(["job", "approve", "publish-post", "--real", "--json", "--non-interactive-approval", "test"])).json.ok).toBe(true);
  });

  it("re-reviewing unchanged content asks nothing new (cached by content hash)", async () => {
    const j = useJudge((_n, q) => (q.kind === "choice" ? compatible : noul(0.9)));
    await cli(["job", "review", "publish-post", "--readiness", "--real", "--json"]);
    const asked = j.calls;
    await cli(["job", "review", "publish-post", "--readiness", "--real", "--json"]);
    expect(j.calls).toBe(asked);
  });

  it("an edited job is asked again (the cache key is the content)", async () => {
    const j = useJudge((_n, q) => (q.kind === "choice" ? compatible : noul(0.9)));
    await cli(["job", "review", "publish-post", "--readiness", "--real", "--json"]);
    const asked = j.calls;
    await writeJobs([{ ...JOB, outcome: "readers see the new post" }]);
    await cli(["job", "review", "publish-post", "--readiness", "--real", "--json"]);
    expect(j.calls).toBeGreaterThan(asked);
  });

  it("the cache holds answers only — no catalog text", async () => {
    useJudge((_n, q) => (q.kind === "choice" ? compatible : noul(0.9)));
    await cli(["job", "review", "publish-post", "--readiness", "--real", "--json"]);
    const { readdir } = await import("node:fs/promises");
    const dir = join(catalogDir, "cache", "jev");
    const texts = await Promise.all((await readdir(dir)).map((f) => readFile(join(dir, f), "utf8")));
    expect(texts.some((t) => t.includes("readers see it"))).toBe(false);
  });

  it("records the usage of the calls made", async () => {
    useJudge((_n, q) => (q.kind === "choice" ? compatible : noul(0.9)));
    expect((await cli(["job", "review", "publish-post", "--readiness", "--real", "--json"])).json.data.jev.usage.judgments).toBeGreaterThan(0);
  });

  it("the text sheet keeps the two layers apart", async () => {
    expect((await cli(["job", "review", "publish-post", "--readiness"])).out).toMatch(/Deterministic checks[\s\S]*Jev review \(advisory/);
  });
});
