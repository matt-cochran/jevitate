import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { appendFileSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ProfileManager } from "@jevitate/daemon";
import { FakeGenerationGateway, FakeJudgmentGateway } from "@jevitate/ai-core";
import type { Recording } from "@jevitate/recording";
import type { RunExplorationOptions, RunExplorationResult } from "./explore-goal.js";

/**
 * #369: every `explore-author-journey` take is `explore`'s goal run (`runExploration`) — the
 * run-shaping flags reach it, and a take that does not reach the goal comes back with its stop
 * reason, checks and the paths of everything it wrote. `runExploration` is replaced by a capture.
 */
const calls: RunExplorationOptions[] = [];
let logFile = "";
let nextOutcome: "succeeded" | "failed" = "succeeded";

const recording: Recording = {
  version: "1.0",
  site: "http://127.0.0.1:3000",
  pages: [
    {
      url: "/login",
      steps: [
        { step: { kind: "navigate", url: "/login", expect: { kind: "visible", target: { label: "Password" } } } },
        { step: { kind: "fill", target: { label: "Password" }, value: { redacted: true, length: 9 }, expect: { kind: "visible", target: { label: "Password" } } } },
      ],
    },
  ],
};

vi.mock("./explore-goal.js", async (importOriginal) => {
  const real = await importOriginal<typeof import("./explore-goal.js")>();
  return {
    ...real,
    runExploration: vi.fn(async (opts: RunExplorationOptions): Promise<RunExplorationResult> => {
      calls.push(opts);
      if (logFile !== "") appendFileSync(logFile, "run\n");
      const failed = nextOutcome === "failed";
      const stem = join(opts.outDir ?? "/logs", `explore-${calls.length}`);
      return {
        goalOutcome: nextOutcome,
        outcome: nextOutcome,
        defectOutcome: { status: "none", byKind: {} },
        stop: failed ? "no-progress" : "done",
        runOutcome: failed ? { status: "incomplete", reason: "no progress after 3 actions" } : { status: "completed", verifiedBy: "success-condition" },
        ...(failed ? { reason: "no progress after 3 actions; the success check did not hold: textIncludes:testId=status|Welcome (saw \"Wrong password\")" } : {}),
        checks: [{ check: "textIncludes:testId=status|Welcome", passed: !failed, detail: failed ? 'saw "Wrong password"' : "held" }],
        decisions: 4,
        actions: 3,
        finalUrl: "http://127.0.0.1:3000/login",
        recording,
        recordingPaths: [`${stem}.json`],
        transcriptPath: `${stem}.transcript.json`,
        resultPath: `${stem}.result.json`,
      } as unknown as RunExplorationResult;
    }),
  };
});

const { buildProgram } = await import("./program.js");

let dir: string;
let journeysDir: string;
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "jev-author-goal-run-"));
  journeysDir = join(dir, "journeys");
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));
afterEach(() => {
  calls.length = 0;
  nextOutcome = "succeeded";
  delete process.env.JEV_AUTHOR_PW;
  delete process.env.JEV_AUTHOR_SEED;
  process.exitCode = undefined;
});

async function cli(args: string[]): Promise<{ out: string; err: string; exitCode: number | undefined }> {
  const out: string[] = [];
  const err: string[] = [];
  const program = buildProgram({
    profiles: new ProfileManager("/unused"),
    journeysDir,
    explore: { judge: new FakeJudgmentGateway({}), gen: new FakeGenerationGateway(), targetsConfigPath: join(dir, "no-targets.json") },
  });
  program.configureOutput({ writeOut: (s) => out.push(s), writeErr: (s) => err.push(s) });
  program.exitOverride();
  process.exitCode = undefined;
  await program.parseAsync(args, { from: "user" });
  const exitCode = process.exitCode;
  process.exitCode = undefined;
  return { out: out.join(""), err: err.join(""), exitCode };
}

const URL = "http://127.0.0.1:3000/login";
const BASE = ["explore-author-journey", "--url", URL, "--goal", "sign in", "--success", "textIncludes:testId=status|Welcome", "--id", "signin-fx", "--name", "Sign in", "--fake-ai", "--json"];

/** Shell hooks that log each phase to `log`; `--before` binds ${setup.id}. */
function hookArgs(log: string, before = `echo before >> '${log}'; echo '{"vars":{"id":"42"}}'`): string[] {
  return ["--allow-shell-hooks", "--before", before, "--after", `echo after >> '${log}'`];
}

function freshLog(name: string): string {
  logFile = join(dir, `${name}.log`);
  writeFileSync(logFile, "");
  return logFile;
}
const lines = (f: string): string[] => readFileSync(f, "utf8").split("\n").filter(Boolean);

describe("explore-author-journey fixtures (#544)", () => {
  afterEach(() => {
    logFile = "";
  });

  it("accepts the --fixtures flag", async () => {
    const r = await cli([...BASE, "--fixtures", join(dir, "missing.json")]);
    expect(r.err + r.out).not.toContain("unknown option");
  });

  it("refuses a missing fixtures file with the fixture spec code", async () => {
    const r = await cli([...BASE, "--fixtures", join(dir, "missing.json")]);
    expect(r.out).toContain("E_FIXTURE_SPEC");
  });

  it("opens no browser run for a fixtures spec error", async () => {
    await cli([...BASE, "--fixtures", join(dir, "missing.json")]);
    expect(calls).toHaveLength(0);
  });

  it("refuses an unbound setup ref in --goal with the ref code", async () => {
    const r = await cli(BASE.map((a) => (a === "sign in" ? "open ${setup.id}" : a)));
    expect(r.out).toContain("E_FIXTURE_REF");
  });

  it("opens no browser run for an unbound setup ref", async () => {
    await cli(BASE.map((a) => (a === "sign in" ? "open ${setup.id}" : a)));
    expect(calls).toHaveLength(0);
  });

  it("runs setup before the take and restore after it", async () => {
    const log = freshLog("order");
    await cli([...BASE, ...hookArgs(log)]);
    expect(lines(log)).toEqual(["before", "run", "after"]);
  });

  it("runs setup and restore around every corroborating take", async () => {
    const log = freshLog("takes");
    await cli([...BASE, "--takes", "2", ...hookArgs(log)]);
    expect(lines(log)).toEqual(["before", "run", "after", "before", "run", "after"]);
  });

  it("hands the fixtures to each goal run", async () => {
    await cli([...BASE, ...hookArgs(freshLog("handed"))]);
    expect(calls[0]?.fixtures).toBeDefined();
  });

  it("binds a setup ref in --goal for the take", async () => {
    await cli([...BASE.map((a) => (a === "sign in" ? "open item ${setup.id}" : a)), ...hookArgs(freshLog("bound"))]);
    expect(calls[0]?.goal).toBe("open item 42");
  });

  it("ends authoring without a Journey when setup fails", async () => {
    await cli([...BASE.map((a) => (a === "signin-fx" ? "signin-fail" : a)), ...hookArgs(freshLog("fail"), "exit 3")]);
    expect(existsSync(join(journeysDir, "signin-fail.json"))).toBe(false);
  });

  it("starts no goal run when setup fails", async () => {
    await cli([...BASE, ...hookArgs(freshLog("fail2"), "exit 3")]);
    expect(calls).toHaveLength(0);
  });

  it("reports setup failure as not reached with a configuration failure", async () => {
    const r = await cli([...BASE, ...hookArgs(freshLog("fail3"), "exit 3")]);
    expect(JSON.parse(r.out).data).toMatchObject({ outcome: "not-reached", failure: { kind: "configuration" } });
  });

  it("exits non-zero when setup fails", async () => {
    const r = await cli([...BASE, ...hookArgs(freshLog("fail4"), "exit 3")]);
    expect(r.exitCode).toBe(1);
  });
});
