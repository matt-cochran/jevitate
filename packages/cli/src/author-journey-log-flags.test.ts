import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ProfileManager } from "@jevitate/daemon";
import { FakeGenerationGateway, FakeJudgmentGateway } from "@jevitate/ai-core";
import type { Recording } from "@jevitate/recording";
import type { RunExplorationOptions, RunExplorationResult } from "./explore-goal.js";

/**
 * #142/#544: `explore-author-journey` takes `explore`'s backend-log flags (through
 * `withServerLogFlags`/`serverLogOptionsFromFlags`) and `--allow-writes`, and threads them into every
 * take's goal run the way `explore --strategy goal` does. `runExploration` is replaced by a capture.
 */
const calls: RunExplorationOptions[] = [];

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
      const stem = join(opts.outDir ?? "/logs", `explore-${calls.length}`);
      return {
        goalOutcome: "succeeded",
        outcome: "succeeded",
        defectOutcome: { status: "none", byKind: {} },
        stop: "done",
        runOutcome: { status: "completed", verifiedBy: "success-condition" },
        checks: [],
        decisions: 1,
        actions: 1,
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
  dir = mkdtempSync(join(tmpdir(), "jev-author-log-flags-"));
  journeysDir = join(dir, "journeys");
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));
afterEach(() => {
  calls.length = 0;
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
const BASE = ["explore-author-journey", "--url", URL, "--goal", "sign in", "--success", "textIncludes:testId=status|Welcome", "--id", "signin", "--name", "Sign in", "--fake-ai", "--json"];

describe("explore-author-journey backend-log flags (#142, #544)", () => {
  it("accepts --log-source", async () => {
    const r = await cli([...BASE, "--log-source", `file:${join(dir, "app.log")}`]);
    expect(r.err + r.out).not.toContain("unknown option");
  });

  it("refuses a cmd: --log-source without --allow-log-cmd", async () => {
    const r = await cli([...BASE, "--log-source", "cmd:tail -f app.log"]);
    expect(JSON.parse(r.out)).toMatchObject({ ok: false, error: { code: "E_LOG_SOURCE_SPEC" } });
  });

  it("refuses --log-triage without --log-source", async () => {
    const r = await cli([...BASE, "--log-triage"]);
    expect(JSON.parse(r.out)).toMatchObject({ ok: false, error: { code: "E_EXPLORE_ARGS" } });
  });

  it("hands the parsed --log-source to the take's goal run", async () => {
    const source = `file:${join(dir, "app.log")}`;
    await cli([...BASE, "--log-source", source]);
    expect(calls[0]?.serverLog?.sources).toEqual([{ kind: "file", path: join(dir, "app.log"), raw: source }]);
  });

  it("hands --allow-writes to the take's goal run", async () => {
    await cli([...BASE, "--allow-writes"]);
    expect(calls[0]?.target?.safety?.allowWrites).toBe(true);
  });
});
