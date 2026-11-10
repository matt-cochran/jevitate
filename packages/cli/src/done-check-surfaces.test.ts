import { readFileSync, readdirSync, statSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { afterEach, describe, expect, test } from "vitest";
import type { JobVerdict } from "@jevitate/adjudicator";
import { FsJourneyStore, type Journey } from "@jevitate/journey";
import type { JourneyRunResult } from "@jevitate/runtime";
import { DoneCheckRun } from "./journey-done-check-hook.js";
import { currentDoneCheckScope } from "./journey-done-check-scope.js";
import { chainExitCode, chainSucceeded, runJourneyChain, type JourneyChainResult } from "./journey-chain.js";
import { journeyResultRecord } from "./journey-result-record.js";
import { runCheck, type CheckRunners, type RunCheckOptions } from "./check-api.js";
import { parseSuite } from "./check-suite.js";
import { advisoryCatalogDir } from "./done-check-policy.testkit.js";
import { CLI_TOOL_SPECS } from "./mcp-cli-tools.js";
import { runCampaign, validateCampaignSpec } from "./campaign-api.js";
import { Command } from "commander";
import { writeFileSync } from "node:fs";
import { registerCheckCommand } from "./check-cli.js";

/**
 * H5 (0.30.0 independent check): every surface that runs a Journey and reports its pass reads the job's done
 * check (a `DoneCheckRun` scope) and folds the verdict with the project's `doneCheckPolicy`, as `journey run`
 * and MCP `run_journey` do (owner decisions 2/3): a job not achieved exits 1, an unverified pass exits 2 under
 * `require`. The last block is the guard: every `runJourneyProgrammatically` call site is either inside a
 * done-check scope or listed with the reason it is not a Journey pass.
 */

const SITE = "https://example.test";
const ACHIEVED: JobVerdict = { attainment: "achieved", basis: "done-check" };
const NOT_ACHIEVED: JobVerdict = { attainment: "not-achieved", basis: "done-check" };
const UNVERIFIED: JobVerdict = { attainment: "unverified", basis: "no-check" };

const discover = {
  metadata: { id: "discover", name: "Discover", promoted: true, params: [], createdAtIso: "2026-11-09T00:00:00Z" },
  recording: { version: "1.0.0", site: SITE, pages: [{ url: "/", steps: [{ step: { kind: "navigate", url: `${SITE}/`, expect: { kind: "urlIncludes", text: "/" } } }] }] },
} as unknown as Journey;
const reply = {
  metadata: { id: "reply", name: "Reply", promoted: true, params: ["commentId", "replyText"], createdAtIso: "2026-11-09T00:00:00Z" },
  recording: {
    version: "1.0.0",
    site: SITE,
    pages: [{ url: "/c", steps: [
      { step: { kind: "navigate", url: `${SITE}/c/\${commentId}`, expect: { kind: "urlIncludes", text: "/c/" } } },
      { variableName: "replyText", step: { kind: "fill", target: { testId: "composer" }, value: { var: "replyText" }, expect: { kind: "visible", target: { testId: "composer" } } } },
    ] }],
  },
} as unknown as Journey;
const RECORDS = { "records.count": "1", "records.0.commentId": "c-1", "records.0.account": "mcpl", "records.0.threadId": "t-1", "records.0.sourceText": "first" };
const REQUESTS = `${JSON.stringify({ commentId: "c-1", account: "mcpl", replyText: "Thanks" })}\n`;

let dir: string | undefined;
afterEach(async () => {
  if (dir !== undefined) await rm(dir, { recursive: true, force: true });
  dir = undefined;
});

async function journeys(): Promise<string> {
  dir ??= await mkdtemp(join(tmpdir(), "jev-done-surfaces-"));
  for (const j of [discover, reply]) await new FsJourneyStore(dir).put(j);
  return dir;
}

/** A fake run that decides its job in the scope the surface opened, as the done-check hooks do. */
function deciding(jobs: Readonly<Record<string, JobVerdict>>, seen: string[] = []) {
  return async (o: { id: string }): Promise<JourneyRunResult> => {
    const scope = currentDoneCheckScope();
    if (scope instanceof DoneCheckRun) {
      seen.push(o.id);
      const job = jobs[o.id];
      if (job !== undefined) scope.decide(job);
    }
    return o.id === "discover" ? { outcome: "ok", output: RECORDS } : { outcome: "ok", output: {} };
  };
}

describe("H5: journey chain reads every run's done check", () => {
  test("the producer and each consumer run inside a done-check scope, and the chain reports each job", async () => {
    const d = await journeys();
    const seen: string[] = [];
    const result = await runJourneyChain(
      { from: "discover", to: "reply", requests: REQUESTS, dir: d, requirePromoted: true, catalogDir: null },
      { runJourney: deciding({ discover: ACHIEVED, reply: NOT_ACHIEVED }, seen) },
    );
    expect(seen).toEqual(["discover", "reply"]);
    expect(result.from.job).toEqual(ACHIEVED);
    expect(result.runs[0]).toMatchObject({ outcome: "ok", job: NOT_ACHIEVED, failure: { kind: "done-check-failed" } });
    // Owner decision 2: steps that passed while the job did not happen are a defect, never ok.
    expect(chainSucceeded(result)).toBe(false);
    expect(chainExitCode(result, "require")).toBe(1);
  });

  test("an unverified pass exits 2 under require and 0 under advisory (owner decision 3); achieved exits 0", async () => {
    const d = await journeys();
    const unverified = await runJourneyChain(
      { from: "discover", to: "reply", requests: REQUESTS, dir: d, requirePromoted: true, catalogDir: null },
      { runJourney: deciding({ discover: ACHIEVED, reply: UNVERIFIED }) },
    );
    expect(chainSucceeded(unverified)).toBe(true);
    expect(chainExitCode(unverified, "require")).toBe(2);
    expect(chainExitCode(unverified, "advisory")).toBe(0);
    const achieved = await runJourneyChain(
      { from: "discover", to: "reply", requests: REQUESTS, dir: d, requirePromoted: true, catalogDir: null },
      { runJourney: deciding({ discover: ACHIEVED, reply: ACHIEVED }) },
    );
    expect(chainExitCode(achieved, "require")).toBe(0);
  });

  test("a harness target's unverified pass keeps exit 0 (decisions/exit-codes.md, #802)", () => {
    const result: JourneyChainResult = {
      from: { journey: "discover", outcome: "ok", records: 1, job: { attainment: "unverified", basis: "harness" } },
      runs: [{ commentId: "c-1", account: "mcpl", outcome: "ok", job: { attainment: "unverified", basis: "harness" } }],
      unmatched: [],
      requests: { total: 1, ran: 1 },
    };
    expect(chainExitCode(result, "require")).toBe(0);
  });
});

describe("H5: the result record keeps the job and folds it into its exit", () => {
  const ok: JourneyRunResult = { outcome: "ok", output: {} };
  const ctx = { journey: discover, params: {}, startedAt: "2026-11-09T00:00:00.000Z" };

  test("not achieved over passing steps: exit 1, done-check-failed, the job kept", () => {
    const r = journeyResultRecord(ok, { ...ctx, job: NOT_ACHIEVED, doneCheckPolicy: "require" });
    expect(r).toMatchObject({ missionOutcome: "defects-found", exitCode: 1, result: { job: NOT_ACHIEVED, failure: { kind: "done-check-failed" } } });
  });

  test("unverified: exit 2 under require, 0 under advisory", () => {
    expect(journeyResultRecord(ok, { ...ctx, job: UNVERIFIED, doneCheckPolicy: "require" })).toMatchObject({ missionOutcome: "inconclusive", exitCode: 2, result: { job: UNVERIFIED } });
    expect(journeyResultRecord(ok, { ...ctx, job: UNVERIFIED, doneCheckPolicy: "advisory" })).toMatchObject({ missionOutcome: "clean", exitCode: 0 });
  });
});

describe("H5: check folds every Journey item's job (owner decision 2026-11-09)", () => {
  const HARNESS: JobVerdict = { attainment: "unverified", basis: "harness" };

  async function check(job: JobVerdict | undefined, extra: Partial<RunCheckOptions> = {}, seen: unknown[] = []) {
    const d = await journeys();
    const suite = parseSuite({ version: 1, name: "ci", targets: [{ name: "shop", url: `${SITE}/`, journeys: [{ id: "discover" }] }] }, join(d, "suite.json"));
    const journey = (async (o: { id: string }) => {
      const scope = currentDoneCheckScope();
      if (scope instanceof DoneCheckRun) {
        seen.push(scope.request);
        if (job !== undefined) scope.decide(job);
      }
      return { outcome: "ok", output: {} };
    }) as unknown as CheckRunners["journey"];
    return runCheck({ suite, outDir: join(d, "out"), journeysDir: d, projectDir: null, runners: { journey }, ...extra });
  }

  test("not achieved over passing steps: the item fails on a gating done-check-failed finding, exit 1, in every output", async () => {
    const r = await check(NOT_ACHIEVED);
    expect(r).toMatchObject({ exitCode: 1, verdict: "fail", summary: { failed: 1, gatingFindings: 1, unverified: 0 }, doneCheckPolicy: "require" });
    expect(r.items[0]).toMatchObject({ kind: "journey", name: "discover", verdict: "failed", job: NOT_ACHIEVED });
    const finding = r.findings.find((f) => f.identity.signal === "done-check-failed");
    expect(finding).toMatchObject({ category: "journey-assertion", severity: "hard", gating: true });
    expect(r.items[0]?.gating).toContain(finding?.key);
    const junit = readFileSync(r.junitPath, "utf8");
    expect(junit).toMatch(/<failure [^>]*type="done-check-failed"/);
    expect(junit).toContain('<property name="jevitate.job.attainment" value="not-achieved"/>');
    const sarif = JSON.parse(readFileSync(r.sarifPath, "utf8")) as { runs: Array<{ properties: Record<string, unknown>; results: Array<{ partialFingerprints?: Record<string, string> }> }> };
    expect(sarif.runs[0]?.properties).toMatchObject({ doneCheckPolicy: "require", jobs: [{ target: "shop", name: "discover", attainment: "not-achieved", basis: "done-check" }] });
    expect(sarif.runs[0]?.results.length).toBeGreaterThan(0);
    expect(JSON.parse(readFileSync(r.jsonPath, "utf8")).data.items[0].job).toEqual(NOT_ACHIEVED);
    const report = readFileSync(r.reportPath, "utf8");
    expect(report).toContain("## Job verdicts");
    expect(report).toContain("| shop | discover | not-achieved | done-check |");
    // The item's own result record keeps the job and its done-check-failed failure (as `journey run --json`).
    const record = JSON.parse(readFileSync(r.results[0]!, "utf8")) as { exitCode: number; result: Record<string, unknown> };
    expect(record).toMatchObject({ exitCode: 1, result: { job: NOT_ACHIEVED, failure: { kind: "done-check-failed" } } });
  });

  test("an unverified pass holds the suite at exit 2 under require (the default), 0 under advisory", async () => {
    const required = await check(UNVERIFIED);
    expect(required).toMatchObject({ exitCode: 2, summary: { passed: 1, gatingFindings: 0, unverified: 1 } });
    expect(required.items[0]).toMatchObject({ verdict: "passed", job: UNVERIFIED });
    expect(readFileSync(required.junitPath, "utf8")).toContain('<property name="jevitate.job.basis" value="no-check"/>');
    const advisoryDir = advisoryCatalogDir(dir!);
    const advisory = await check(UNVERIFIED, { projectDir: advisoryDir });
    expect(advisory).toMatchObject({ exitCode: 0, doneCheckPolicy: "advisory", summary: { unverified: 0 } });
    // --require-done-check over an advisory project folds it back to 2.
    expect(await check(UNVERIFIED, { projectDir: advisoryCatalogDir(dir!), doneCheck: { policy: "require" } })).toMatchObject({ exitCode: 2 });
  });

  test("a harness target's unverified pass exits 0 (decisions/exit-codes.md, #802); achieved exits 0", async () => {
    expect(await check(HARNESS)).toMatchObject({ exitCode: 0, summary: { unverified: 0 } });
    expect(await check(ACHIEVED)).toMatchObject({ exitCode: 0, items: [{ verdict: "passed", job: ACHIEVED }] });
  });

  test("each item runs inside a done-check scope with the run's dir; --no-done-check asks the scope to read nothing", async () => {
    const seen: Array<{ journeysDir?: string; skip?: boolean }> = [];
    await check(undefined, { doneCheck: { skip: true } }, seen);
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ skip: true, journeysDir: dir });
  });

  test("check's CLI: --no-done-check with --require-done-check is refused (64); --require-done-check folds over an advisory project", async () => {
    const d = await journeys();
    const catalogDir = advisoryCatalogDir(d);
    writeFileSync(join(d, "suite.json"), JSON.stringify({ version: 1, name: "ci", targets: [{ name: "shop", url: `${SITE}/`, journeys: [{ id: "discover" }] }] }));
    const cli = async (argv: readonly string[]): Promise<number | undefined> => {
      const program = new Command();
      program.exitOverride();
      program.configureOutput({ writeOut: () => {}, writeErr: () => {} });
      const journey = deciding({ discover: UNVERIFIED }) as unknown as CheckRunners["journey"];
      registerCheckCommand(program, { buildGateways: () => Promise.reject(new Error("no gateways")), journeysDir: d, catalogDir, targetsConfigPath: join(d, "no-targets.json"), runners: { journey }, env: {} }, (c) => c);
      process.exitCode = undefined;
      await program.parseAsync(["check", "--suite", join(d, "suite.json"), "--out", join(d, "cli"), ...argv], { from: "user" });
      const code = process.exitCode === undefined ? undefined : Number(process.exitCode);
      process.exitCode = undefined;
      return code;
    };
    expect(await cli(["--no-done-check", "--require-done-check"])).toBe(64);
    expect(await cli([])).toBe(0);
    expect(await cli(["--require-done-check"])).toBe(2);
  });

  test("MCP run_check and run_campaign take the done-check flags as run_journey does", () => {
    for (const name of ["run_check", "run_campaign"]) {
      const cmd = CLI_TOOL_SPECS.find((t) => t.name === name)!.command as { params: Record<string, { flag?: string }> };
      expect(cmd.params.doneCheck?.flag).toBe("--no-done-check");
      expect(cmd.params.requireDoneCheck?.flag).toBe("--require-done-check");
    }
  });
});

describe("H5: campaign folds each discovery replay's job", () => {
  async function campaign(job: JobVerdict | undefined, policy: "require" | "advisory", mission: "clean" | "defects-found" = "clean", seenArgv: string[][] = [], skip = false) {
    const d = await journeys();
    await new FsJourneyStore(d).put({ ...discover, metadata: { ...discover.metadata, anchors: [{ name: "home", step: 1 }] } } as Journey);
    const plan = await validateCampaignSpec({ version: 1, jobs: [{ id: "j", journey: "discover", anchors: ["home"], strategies: ["adversarial"] }] }, join(d, "campaign.json"), { journeysDir: d });
    const newProgram = (): Command => {
      const program = new Command();
      const reply = (data: unknown) => function (this: Command) {
        seenArgv.push(this.parent?.name() === "journey" ? ["journey", "run", ...this.args] : [this.name(), ...this.args]);
        program.configureOutput().writeOut?.(`${JSON.stringify({ v: 1, ok: true, data })}\n`);
      };
      program.command("journey").command("run").allowUnknownOption().allowExcessArguments().action(reply({ outcome: "ok", ...(job === undefined ? {} : { job }) }));
      program.command("explore").allowUnknownOption().allowExcessArguments().action(reply({ missionOutcome: mission, exitCode: mission === "clean" ? 0 : 1 }));
      return program;
    };
    return runCampaign(plan, { newProgram, journeysDir: d, missionTargetsDir: join(d, "targets"), outDir: join(d, "out"), fakeAi: true, doneCheck: { policy, ...(skip ? { skip: true } : {}) } });
  }

  test("not achieved exits 1; unverified exits 2 under require and 0 under advisory; the verdict is on discovery[]", async () => {
    const notAchieved = await campaign(NOT_ACHIEVED, "require");
    expect(notAchieved).toMatchObject({ exitCode: 1, missionOutcome: "defects-found", discovery: [{ outcome: "ok", jobVerdict: NOT_ACHIEVED }] });
    expect(readFileSync(notAchieved.reportPath, "utf8")).toContain("not-achieved (done-check)");
    expect(await campaign(UNVERIFIED, "require")).toMatchObject({ exitCode: 2, missionOutcome: "inconclusive" });
    expect(await campaign(UNVERIFIED, "advisory")).toMatchObject({ exitCode: 0 });
    expect(await campaign({ attainment: "unverified", basis: "harness" }, "require")).toMatchObject({ exitCode: 0 });
    expect(await campaign(ACHIEVED, "require")).toMatchObject({ exitCode: 0 });
  });

  test("--no-done-check reaches each discovery `journey run`, never a mission", async () => {
    const argv: string[][] = [];
    await campaign(UNVERIFIED, "require", "clean", argv, true);
    expect(argv.find((a) => a[0] === "journey")).toContain("--no-done-check");
    expect(argv.find((a) => a[0] === "explore")).not.toContain("--no-done-check");
  });

  test("an unverified job never hides a defect a mission found (exit 1, as check's 1 > 2)", async () => {
    expect(await campaign(UNVERIFIED, "require", "defects-found")).toMatchObject({ exitCode: 1, missionOutcome: "defects-found" });
  });
});

// --- The guard ---------------------------------------------------------------------------------------

const SRC = dirname(fileURLToPath(import.meta.url));

/**
 * Every non-test file that calls `runJourneyProgrammatically` (or hands it on as a runner). `scope`: the text in
 * the file that opens the done-check scope around it. `reason`: why that call is not a Journey pass a surface
 * reports (so it needs no job verdict). A new call site fails here until it is listed.
 */
const CALL_SITES: Readonly<Record<string, { readonly scope: readonly string[]; readonly in?: string } | { readonly reason: string }>> = {
  "journey-cli/run.ts": { scope: ["doneCheckRun.run("] },
  "mcp-api.ts": { scope: ["runWithDoneCheck("] },
  "mission-queue-runner.ts": { scope: ["runWithDoneCheck("] },
  "journey-shorten.ts": { scope: ["check.run("] },
  "journey-chain.ts": { scope: ["inDoneCheckScope(doneCheck, () => inner(o))"] },
  "journey-hold.ts": { scope: ["inDoneCheckScope(doneCheck,"] },
  "journey-readiness.ts": { scope: ["scope.run(() => run(o))"] },
  // Owner decision 2026-11-09: each check Journey item runs in a scope opened where the item calls its runner.
  "check-api.ts": { scope: ["scope.run(run)"], in: "check-execute.ts" },
  "journey-verify.ts": { reason: "mutation-proof replays judge the Journey's assertions (sensitive/inconclusive), never the job; the job is `journey run`'s" },
  "journey-annotate-api.ts": { reason: "an authoring replay that drafts step objectives; it reports no pass" },
  "journey-labels-migrate-api.ts": { reason: "a migration replay that re-resolves labels; it reports no pass" },
  "journey-demo-api.ts": { reason: "a demo render; a replay that no longer works renders nothing, it reports no job" },
  "demo-aspect-api.ts": { reason: "verifies a demo candidate path replays; it reports no job" },
  "journey-prefix.ts": { reason: "replays a Journey prefix to reach an exploration's start state; it reports no pass" },
};

function sourceFiles(root: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(root)) {
    const p = join(root, name);
    if (statSync(p).isDirectory()) out.push(...sourceFiles(p));
    else if (name.endsWith(".ts") && !name.endsWith(".test.ts") && !name.endsWith(".d.ts")) out.push(p);
  }
  return out;
}

/** Whether a file uses `runJourneyProgrammatically` as a value (a call or a runner), not only imports, declares or re-exports it. */
function usesRunner(file: string): boolean {
  const sf = ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true);
  let used = false;
  const visit = (node: ts.Node): void => {
    if (used || ts.isImportDeclaration(node) || ts.isExportDeclaration(node) || ts.isTypeQueryNode(node)) return;
    if (ts.isIdentifier(node) && node.text === "runJourneyProgrammatically" && !(ts.isFunctionDeclaration(node.parent) && node.parent.name === node)) used = true;
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return used;
}

describe("H5 guard: no surface returns a Journey pass without a job verdict", () => {
  const found = sourceFiles(SRC).filter(usesRunner).map((f) => relative(SRC, f).split("\\").join("/")).sort();

  test("every runJourneyProgrammatically call site is listed, and every listed one still calls it", () => {
    expect(found).toEqual(Object.keys(CALL_SITES).sort());
  });

  test("a scoped call site still opens its done-check scope", () => {
    for (const [file, entry] of Object.entries(CALL_SITES)) {
      if (!("scope" in entry)) continue;
      const text = readFileSync(join(SRC, entry.in ?? file), "utf8");
      for (const opener of entry.scope) expect(text, `${file} opens ${opener}`).toContain(opener);
    }
  });

  test("source run (its own runner, not runJourneyProgrammatically) reads the done check before and after, in a scope", () => {
    const text = readFileSync(join(SRC, "source-run-api.ts"), "utf8");
    for (const s of ["doneCheckRunHooks.validateParams(", "doneCheckRunHooks.readDoneCheck(", "inDoneCheckScope("]) expect(text).toContain(s);
    // The CLI folds the job into the exit, as `journey run`.
    expect(readFileSync(join(SRC, "source-cli.ts"), "utf8")).toContain("doneCheckExitInput(reported.job, doneCheckPolicy)");
  });

  test("inbox resume and journey chain fold the job into their exit codes", () => {
    expect(readFileSync(join(SRC, "inbox-cli.ts"), "utf8")).toMatch(/journeyExitCode\(r\.outcome, doneCheckExitInput\(resumed\.job, resumed\.doneCheckPolicy\)\)[\s\S]*chainExitCode\(chained, resumed\.doneCheckPolicy\)/);
    expect(readFileSync(join(SRC, "journey-cli/chain.ts"), "utf8")).toContain("chainExitCode(result, doneCheckPolicyOf(catalogDir))");
  });
});
