import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { UsageTracker, type UsageCounts } from "@jevitate/ai-core";
import { GOAL_ONLY_OUTCOMES, MISSION_EXIT_CODES, foldGoalOutcome, type GoalOnlyOutcome, type MissionOutcome } from "@jevitate/domain";
import { formatMultiRunHuman } from "./cli-output.js";
import {
  MultiRunArgsError,
  diffPersonas,
  extractRequests,
  extractRunFindings,
  findingIdentity,
  loadPersonasFile,
  resolveMultiRunPlan,
  runMultiRun,
  summarizeRun,
  voteRuns,
  type RunEnvelope,
  type RunSummary,
} from "./multi-run.js";

/** A synthetic run: only what the vote reads. */
function run(index: number, outcome: string, fingerprints: string[], extra: Partial<RunSummary> = {}): RunSummary {
  // A goal-only ending (succeeded/failed/exhausted/blocked) is a goal run's: it folds onto its canonical verdict (#217).
  const goal = (GOAL_ONLY_OUTCOMES as readonly string[]).includes(outcome) ? (outcome as GoalOnlyOutcome) : undefined;
  const missionOutcome = goal === undefined ? (outcome as MissionOutcome) : foldGoalOutcome(goal);
  return {
    index,
    ok: true,
    outcome,
    missionOutcome,
    ...(goal === undefined ? {} : { goalOutcome: goal }),
    exitCode: MISSION_EXIT_CODES[missionOutcome],
    findings: fingerprints.map((fp) => ({ kind: "defect/network-5xx", fingerprint: fp, route: "/items/42", title: `bug ${fp}` })),
    requests: {},
    controls: [],
    ...extra,
  };
}

describe("repeat-and-vote (#141)", () => {
  it("keeps findings seen in ≥k runs and labels the rest flaky, with stability seen/N", () => {
    const cell = voteRuns([run(1, "defects-found", ["a", "b"]), run(2, "defects-found", ["a"]), run(3, "clean", [])], 2);
    expect(cell.findings.map((f) => [f.fingerprint, f.stability, f.runs, f.status])).toEqual([["a", "2/3", [1, 2], "agreed"]]);
    expect(cell.flaky.map((f) => [f.fingerprint, f.stability, f.runs, f.status])).toEqual([["b", "1/3", [1], "flaky"]]);
    expect(cell.outcome).toBe("defects-found");
    expect(cell.outcomes).toEqual({ "defects-found": 2, clean: 1 });
    expect(cell.exitCode).toBe(1);
  });

  it("matches a finding across runs by fingerprint + templated route (ids in the path do not split it)", () => {
    const a = run(1, "defects-found", ["x"]);
    const b = { ...run(2, "defects-found", []), findings: [{ kind: "defect/network-5xx", fingerprint: "x", route: "/items/77", title: "t" }] };
    const cell = voteRuns([a, b], 2);
    expect(cell.findings).toHaveLength(1);
    expect(cell.findings[0]!.stability).toBe("2/2");
    expect(findingIdentity(a.findings[0]!)).toBe(findingIdentity(b.findings[0]!));
  });

  it("the agreed outcome needs ≥k runs; otherwise (or on a tie) it is intermittent (exit 4)", () => {
    expect(voteRuns([run(1, "succeeded", []), run(2, "succeeded", []), run(3, "exhausted", [])], 2)).toMatchObject({
      outcome: "succeeded",
      missionOutcome: "clean",
      goalOutcome: "succeeded",
      exitCode: 0,
    });
    // #226: the vote is over the canonical verdict — two goal runs that failed in different ways
    // (exhausted, blocked) still agree the run found a defect; the goal ending then reads as that verdict.
    const split = voteRuns([run(1, "succeeded", []), run(2, "exhausted", []), run(3, "blocked", [])], 2);
    expect(split).toMatchObject({ outcome: "defects-found", missionOutcome: "defects-found", goalOutcome: "defects-found", exitCode: 1 });
    const tie = voteRuns([run(1, "succeeded", []), run(2, "exhausted", [])], 1);
    expect(tie).toMatchObject({ outcome: "intermittent", missionOutcome: "intermittent", exitCode: 4 });
  });

  it("a finding seen twice in ONE run still counts as one run", () => {
    const cell = voteRuns([run(1, "defects-found", ["a", "a"]), run(2, "clean", []), run(3, "clean", [])], 2);
    expect(cell.flaky[0]!.stability).toBe("1/3");
  });

  it("requests and controls are kept only when seen in ≥k runs", () => {
    const cell = voteRuns(
      [
        run(1, "clean", [], { requests: { "GET /api/a": [200], "GET /api/rare": [200] }, controls: ['button "Save"', 'link "Beta"'] }),
        run(2, "clean", [], { requests: { "GET /api/a": [200, 304] }, controls: ['button "Save"'] }),
      ],
      2,
    );
    expect(cell.requests).toEqual({ "GET /api/a": [200, 304] });
    expect(cell.controls).toEqual(['button "Save"']);
  });

  it("extracts every strategy's findings: defects, invariants, hangs, advisories, coverage defects, UX", () => {
    const fs = extractRunFindings({
      defects: [
        { fingerprint: "d1", kind: "network-5xx", route: "/a", title: "HTTP 500" },
        { fingerprint: "i1", kind: "invariant", route: "/b", title: "inv" },
      ],
      hangs: [{ fingerprint: "h1", kind: "hang", route: "/c", title: "hang" }],
      advisories: [{ fingerprint: "s1", kind: "console-error", route: "/d", title: "403" }],
      coverage: { defects: [{ stateFingerprint: "st1", url: "http://x/e/12", reason: "broken" }] },
      report: { findings: [{ rubricItemId: "r1", route: "/f", observation: "o", controls: ['button "B"', 'button "A"'] }] },
    });
    expect(fs.map(findingIdentity)).toEqual([
      "defect/network-5xx:d1@/a",
      "invariant:i1@/b",
      "hang:h1@/c",
      "advisory/console-error:s1@/d",
      "coverage-defect:st1@/e/:id",
      'ux:r1@/f[button "A"|button "B"]',
    ]);
  });

  it("extracts requests from the timing summary, without assets or pending statuses", () => {
    expect(
      extractRequests({
        timing: {
          endpoints: {
            "GET /api/billing": { kind: "api", statuses: [403, null, 403] },
            "GET /app.js": { kind: "asset", statuses: [200] },
            "GET /home": { kind: "document", statuses: [200] },
          },
        },
      }),
    ).toEqual({ "GET /api/billing": [403], "GET /home": [200] });
  });

  it("an error envelope is a crashed run with no findings", () => {
    const s = summarizeRun("goal", 1, { ok: false, error: { code: "E_EXPLORE_RUN", message: "boom" } });
    expect(s).toMatchObject({ ok: false, outcome: "crashed", exitCode: 2, findings: [], error: { message: "boom" } });
  });

  it("a run carries its canonical missionOutcome (#217) — and a goal run its own goalOutcome beside it", () => {
    expect(summarizeRun("goal", 1, { ok: true, data: { outcome: "succeeded", goalOutcome: "succeeded", missionOutcome: "clean", exitCode: 0 } })).toMatchObject({
      outcome: "succeeded",
      missionOutcome: "clean",
      goalOutcome: "succeeded",
    });
    const coverage = summarizeRun("coverage", 1, { ok: true, data: { outcome: "exhausted", missionOutcome: "clean", exitCode: 0 } });
    expect(coverage).toMatchObject({ outcome: "clean", missionOutcome: "clean" });
    expect(coverage.goalOutcome).toBeUndefined();
    // An older goal result without missionOutcome: its ending is folded, never read as the verdict.
    expect(summarizeRun("goal", 1, { ok: true, data: { outcome: "blocked", exitCode: 1 } })).toMatchObject({ missionOutcome: "defects-found", goalOutcome: "blocked" });
  });
});

describe("persona diff (#143)", () => {
  const admin = voteRuns(
    [
      run(1, "succeeded", [], {
        requests: { "GET /api/billing": [200], "GET /api/admin/users": [200], "GET /home": [200] },
        controls: ['button "Billing"', 'link "Home"'],
      }),
    ],
    1,
    { name: "admin", storageState: "/s/admin.json" },
  );
  const sales = voteRuns(
    [run(1, "blocked", [], { requests: { "GET /api/billing": [403], "GET /home": [200] }, controls: ['link "Home"'] })],
    1,
    { name: "sales", storageState: "/s/sales.json" },
  );

  it("reports requests, statuses, controls and outcomes that differ — and a 403-vs-200 as an RBAC candidate", () => {
    const d = diffPersonas([admin, sales]);
    expect(d.advisory).toBe(true);
    expect(d.requestsOnlyIn).toEqual([{ item: "GET /api/admin/users", presentFor: ["admin"], absentFor: ["sales"] }]);
    expect(d.statusDiffs).toEqual([{ request: "GET /api/billing", statuses: { admin: [200], sales: [403] } }]);
    expect(d.controlsOnlyIn).toEqual([{ item: 'button "Billing"', presentFor: ["admin"], absentFor: ["sales"] }]);
    expect(d.outcomes).toEqual({ admin: "clean", sales: "defects-found" });
    expect(d.outcomeDiffers).toBe(true);
    expect(d.rbacCandidates).toEqual([
      { request: "GET /api/billing", denied: { sales: [403] }, allowed: ["admin"], title: "GET /api/billing: 403 for sales; 2xx for admin" },
    ]);
  });

  it("identical personas diff to nothing", () => {
    const twin = { ...admin, persona: "admin2" };
    const d = diffPersonas([admin, twin]);
    expect(d).toMatchObject({ requestsOnlyIn: [], statusDiffs: [], controlsOnlyIn: [], rbacCandidates: [], outcomeDiffers: false });
  });
});

describe("plan and orchestration", () => {
  it("validates flags before any run: k ≤ N, default majority, personas exclude --storage-state", () => {
    const dir = mkdtempSync(join(tmpdir(), "jev-multi-"));
    try {
      const state = join(dir, "admin.json");
      writeFileSync(state, "{}");
      expect(resolveMultiRunPlan({ repeat: "3", persona: [] })).toEqual({ repeat: 3, minAgreement: 2, personas: null });
      expect(() => resolveMultiRunPlan({ repeat: "2", minAgreement: "3", persona: [] })).toThrow(MultiRunArgsError);
      expect(() => resolveMultiRunPlan({ repeat: "0", persona: [] })).toThrow(/positive integer/);
      expect(() => resolveMultiRunPlan({ persona: [`admin=${state}`], storageState: state })).toThrow(/--storage-state/);
      expect(() => resolveMultiRunPlan({ persona: [`admin=${join(dir, "nope.json")}`] })).toThrow(/not found/);
      expect(() => resolveMultiRunPlan({ persona: [`admin=${state}`, `admin=${state}`] })).toThrow(/twice/);
      expect(() => resolveMultiRunPlan({ persona: [`../x=${state}`] })).toThrow(/persona name/);
      writeFileSync(join(dir, "personas.json"), JSON.stringify({ admin: "admin.json" }));
      expect(loadPersonasFile(join(dir, "personas.json"))).toEqual([{ name: "admin", storageState: state }]);
      writeFileSync(join(dir, "p2.json"), JSON.stringify({ personas: [{ name: "admin", storageState: "admin.json" }] }));
      expect(loadPersonasFile(join(dir, "p2.json"))).toEqual([{ name: "admin", storageState: state }]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("runs strictly one at a time, persona by persona, and writes per-run envelopes plus one aggregate", async () => {
    const dir = mkdtempSync(join(tmpdir(), "jev-multi-"));
    try {
      let active = 0;
      const calls: Array<{ storageState?: string; outDir: string }> = [];
      const result = await runMultiRun({
        plan: { repeat: 2, minAgreement: 2, personas: [{ name: "a", storageState: "/s/a.json" }, { name: "b", storageState: "/s/b.json" }] },
        strategy: "adversarial",
        outDir: dir,
        runOnce: async (args): Promise<RunEnvelope> => {
          active += 1;
          expect(active).toBe(1);
          calls.push(args);
          await new Promise((r) => setTimeout(r, 5));
          active -= 1;
          return { ok: true, data: { outcome: "clean", missionOutcome: "clean", exitCode: 0 } };
        },
      });
      expect(calls.map((c) => [c.storageState, c.outDir])).toEqual([
        ["/s/a.json", join(dir, "a", "run-1")],
        ["/s/a.json", join(dir, "a", "run-2")],
        ["/s/b.json", join(dir, "b", "run-1")],
        ["/s/b.json", join(dir, "b", "run-2")],
      ]);
      expect(result).toMatchObject({ kind: "multi-run", outcome: "clean", exitCode: 0, complete: true, repeat: 2, minAgreement: 2 });
      expect(result.cells.map((c) => c.persona)).toEqual(["a", "b"]);
      expect(result.diff).toBeDefined();
      const onDisk = JSON.parse(readFileSync(result.resultPath, "utf8")) as { complete: boolean };
      expect(onDisk.complete).toBe(true);
      expect(JSON.parse(readFileSync(join(dir, "b", "run-2", "run.envelope.json"), "utf8"))).toMatchObject({ ok: true });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("multi-run usage (#163)", () => {
  it("the aggregate's usage equals the sum of its runs; a run with no usage makes it partial", async () => {
    const dir = mkdtempSync(join(tmpdir(), "jev-multi-usage-"));
    const perRun: UsageCounts[] = [1, 2, 3].map((n) => {
      const t = new UsageTracker();
      for (let i = 0; i < n; i++) t.recordJudgment({ inputTokens: 1_000_000, outputTokens: 0, model: "jev-1.13.0" });
      t.recordGeneration({ inputTokens: 100, outputTokens: 10, usd: 0.01 * n, model: "openai/gpt-4o-mini", task: "form.value" });
      return JSON.parse(JSON.stringify(t.snapshot())) as UsageCounts;
    });
    try {
      let i = 0;
      const result = await runMultiRun({
        plan: { repeat: 3, minAgreement: 2, personas: null },
        strategy: "adversarial",
        outDir: dir,
        runOnce: async (): Promise<RunEnvelope> => ({ ok: true, data: { outcome: "clean", missionOutcome: "clean", exitCode: 0, usage: perRun[i++] } }),
      });
      const sum = (f: (u: UsageCounts) => number): number => perRun.reduce((a, u) => a + f(u), 0);
      expect(result.usage).toMatchObject({ runs: 3, judgments: 6, generations: 3, priced: "full" });
      expect(result.usage.tokens).toBe(sum((u) => u.inputTokens + u.outputTokens));
      expect(result.usage.jevUsd).toBeCloseTo(sum((u) => u.jevUsd ?? 0), 12);
      expect(result.usage.generationUsd).toBeCloseTo(sum((u) => u.generationUsd ?? 0), 12);
      expect(result.usage.totalUsd).toBeCloseTo(sum((u) => u.totalUsd ?? 0), 12);
      expect(result.usage.totalUsd).toBeCloseTo(6 * 0.042 + 0.06, 12);
      const onDisk = JSON.parse(readFileSync(result.resultPath, "utf8")) as { usage: { totalUsd: number } };
      expect(onDisk.usage.totalUsd).toBeCloseTo(result.usage.totalUsd ?? NaN, 12);

      const crashed = await runMultiRun({
        plan: { repeat: 2, minAgreement: 1, personas: null },
        strategy: "adversarial",
        outDir: join(dir, "second"),
        runOnce: async ({ outDir }): Promise<RunEnvelope> =>
          outDir.endsWith("run-1")
            ? { ok: true, data: { outcome: "clean", missionOutcome: "clean", exitCode: 0, usage: perRun[0] } }
            : { ok: false, error: { code: "E_EXPLORE_RUN", message: "browser died" } },
      });
      expect(crashed.usage).toMatchObject({ runs: 2, judgments: 1, priced: "partial", unreportedRuns: 1, missing: ["1 run(s) reported no usage"] });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("a broken or interrupted run is never `intermittent` (#220)", () => {
  it("a disagreement caused by a crashed run (a lost browser) is inconclusive with the reason; real verdicts that disagree stay intermittent", () => {
    const cell = voteRuns([run(1, "blocked", []), run(2, "crashed", [], { exitCode: 2, reason: "page-crash: Target crashed" })], 2);
    expect(cell.outcome).toBe("inconclusive");
    expect(cell.exitCode).toBe(2);
    expect(cell.reason).toContain("run 2 crashed (page-crash: Target crashed)");
    const failedEnvelope = summarizeRun("goal", 2, { ok: false, error: { code: "E_EXPLORE_RUN", message: "browserContext.newPage: Target crashed" } });
    expect(voteRuns([run(1, "blocked", []), failedEnvelope], 2)).toMatchObject({ outcome: "inconclusive", exitCode: 2 });
    expect(voteRuns([run(1, "blocked", []), run(2, "succeeded", [])], 2).outcome).toBe("intermittent");
  });

  it("fewer runs than planned never read intermittent: the partial aggregate is inconclusive until the multi-run completes", async () => {
    expect(voteRuns([run(1, "blocked", [])], 2, null, 2)).toMatchObject({ outcome: "inconclusive", reason: expect.stringContaining("only 1 of 2") });
    const dir = mkdtempSync(join(tmpdir(), "jev-multi-partial-"));
    try {
      let seenPartial: { outcome: string; exitCode: number; complete: boolean; reason?: string } | undefined;
      await runMultiRun({
        plan: { repeat: 2, minAgreement: 2, personas: null },
        strategy: "goal",
        outDir: dir,
        runOnce: async ({ outDir }): Promise<RunEnvelope> => {
          if (outDir.endsWith("run-2")) seenPartial = JSON.parse(readFileSync(join(dir, "multi-run.result.json"), "utf8"));
          return { ok: true, data: { outcome: "blocked", exitCode: 1 } };
        },
      });
      expect(seenPartial).toMatchObject({ outcome: "inconclusive", exitCode: 2, complete: false, reason: "incomplete: 1 of 2 run(s) finished" });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("a kill mid-run: the run in flight is recorded as interrupted and the aggregate is rewritten, synchronously", async () => {
    const dir = mkdtempSync(join(tmpdir(), "jev-multi-kill-"));
    try {
      let onKill: ((i: { signal: string; exitCode: number; partial?: Record<string, unknown> }) => unknown) | undefined;
      let killed: ReturnType<NonNullable<typeof onKill>> | undefined;
      let disarmed = false;
      await runMultiRun({
        plan: { repeat: 2, minAgreement: 2, personas: null },
        strategy: "goal",
        outDir: dir,
        armKill: (fn) => {
          onKill = fn;
          return () => {
            disarmed = true;
          };
        },
        runOnce: async ({ outDir }): Promise<RunEnvelope> => {
          if (outDir.endsWith("run-2")) {
            killed = onKill?.({ signal: "SIGINT", exitCode: 130, partial: { outcome: "inconclusive", missionOutcome: "inconclusive", exitCode: 130, reason: "interrupted by SIGINT after 0 steps" } });
          }
          return { ok: true, data: { outcome: "blocked", exitCode: 1 } };
        },
      });
      expect(disarmed).toBe(true);
      expect(killed).toMatchObject({
        outcome: "inconclusive",
        exitCode: 130,
        complete: false,
        interrupted: { signal: "SIGINT" },
        reason: "interrupted by SIGINT during run 2; 1 of 2 run(s) finished",
      });
      const cell = (killed as { cells: Array<{ runs: Array<{ outcome: string; reason?: string }> }> }).cells[0]!;
      expect(cell.runs.map((r) => r.outcome)).toEqual(["blocked", "inconclusive"]);
      expect(cell.runs[1]!.reason).toBe("interrupted by SIGINT after 0 steps");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("multi-run results follow the #217 contract (#226)", () => {
  const answer = { text: "42 items", evidence: [{ source: "page-text", url: "http://127.0.0.1:3000/items" }] };

  it("--repeat of a goal: canonical missionOutcome, goalOutcome and engine — in the result AND on disk; the human headline is canonical", async () => {
    const dir = mkdtempSync(join(tmpdir(), "jev-multi-contract-"));
    try {
      const result = await runMultiRun({
        plan: { repeat: 2, minAgreement: 2, personas: null },
        strategy: "goal",
        outDir: dir,
        runOnce: async (): Promise<RunEnvelope> => ({
          ok: true,
          data: { outcome: "succeeded", goalOutcome: "succeeded", missionOutcome: "clean", exitCode: 0, answer, reason: "every success check held" },
        }),
      });
      expect(result).toMatchObject({ outcome: "succeeded", missionOutcome: "clean", goalOutcome: "succeeded", exitCode: 0 });
      expect(result.engine).toMatchObject({ version: expect.any(String), commit: expect.any(String), builtAt: expect.any(String) });
      const onDisk = JSON.parse(readFileSync(result.resultPath, "utf8")) as Record<string, unknown>;
      expect(onDisk).toMatchObject({ missionOutcome: "clean", goalOutcome: "succeeded", exitCode: 0, engine: result.engine });
      expect(result.cells[0]!.runs.map((r) => [r.missionOutcome, r.goalOutcome])).toEqual([
        ["clean", "succeeded"],
        ["clean", "succeeded"],
      ]);

      const human = formatMultiRunHuman(result);
      expect(human).toMatch(/^CLEAN: goal ×2 · 0 agreed finding\(s\) · 0 flaky/);
      expect(human).not.toMatch(/SUCCEEDED:/);
      expect(human).toMatch(/^GOAL {4}succeeded$/m);
      expect(human).toMatch(/^RUN {5}run 1 {2}clean \(goal: succeeded\) {2}every success check held$/m);
      // Both runs found the same answer: one ANSWER line, with where it came from.
      expect(human.match(/^ANSWER/gm)).toHaveLength(1);
      expect(human).toMatch(/^ANSWER {2}42 items {2}\(from page text on \/items\)$/m);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // #230: apply #227's goal-verdict headline here too — every run agreeing the goal failed used to
  // still lead "DEFECTS-FOUND: goal ×2 · 0 agreed finding(s) · 0 flaky", self-contradicting (the
  // goal's own check failed; no defect was found).
  it("--repeat of a failed goal: heads FAILED, not 'DEFECTS-FOUND … 0 agreed finding(s)'", async () => {
    const dir = mkdtempSync(join(tmpdir(), "jev-multi-failed-goal-"));
    try {
      const result = await runMultiRun({
        plan: { repeat: 2, minAgreement: 2, personas: null },
        strategy: "goal",
        outDir: dir,
        runOnce: async (): Promise<RunEnvelope> => ({
          ok: true,
          data: { outcome: "failed", goalOutcome: "failed", missionOutcome: "defects-found", exitCode: 1, reason: "success check never held" },
        }),
      });
      expect(result).toMatchObject({ outcome: "failed", missionOutcome: "defects-found", goalOutcome: "failed", exitCode: 1 });
      const human = formatMultiRunHuman(result);
      expect(human).toMatch(/^FAILED: goal ×2$/m);
      expect(human).not.toContain("DEFECTS-FOUND");
      expect(human).not.toContain("0 agreed finding(s)");
      expect(human).toMatch(/^GOAL {4}failed$/m);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("--persona: the headline is the canonical (most severe) verdict; each persona's runs, the status diff and each answer are listed", async () => {
    const dir = mkdtempSync(join(tmpdir(), "jev-multi-persona-"));
    try {
      const result = await runMultiRun({
        plan: { repeat: 1, minAgreement: 1, personas: [{ name: "admin", storageState: "/s/admin.json" }, { name: "viewer", storageState: "/s/viewer.json" }] },
        strategy: "goal",
        outDir: dir,
        runOnce: async ({ storageState }): Promise<RunEnvelope> =>
          storageState === "/s/admin.json"
            ? { ok: true, data: { goalOutcome: "succeeded", missionOutcome: "clean", exitCode: 0, answer: { text: "3 invoices" }, timing: { endpoints: { "GET /api/invoices": { statuses: [200] } } } } }
            : {
                ok: true,
                data: {
                  goalOutcome: "blocked",
                  missionOutcome: "defects-found",
                  exitCode: 1,
                  reason: "blocked before the goal was met",
                  timing: { endpoints: { "GET /api/invoices": { statuses: [404] } } },
                },
              },
      });
      expect(result).toMatchObject({ outcome: "mixed", missionOutcome: "defects-found", goalOutcome: "defects-found", exitCode: 1 });
      expect(result.diff?.outcomes).toEqual({ admin: "clean", viewer: "defects-found" });
      const human = formatMultiRunHuman(result);
      expect(human).toMatch(/^DEFECTS-FOUND: goal ×1 · 2 personas · 0 agreed finding\(s\) · 0 flaky/);
      expect(human).toMatch(/^PERSONA admin  clean \(goal: succeeded\)$/m);
      expect(human).toMatch(/^PERSONA viewer  defects-found \(goal: blocked\)$/m);
      expect(human).toMatch(/^RUN {5}viewer run 1 {2}defects-found \(goal: blocked\) {2}blocked before the goal was met$/m);
      expect(human).toMatch(/^DIFF {4}GET \/api\/invoices: 200 for admin; 404 for viewer {2}\(advisory\)$/m);
      expect(human).toMatch(/^ANSWER {2}admin run 1: 3 invoices$/m);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("an interrupted multi-run is canonical too: missionOutcome inconclusive with the signal's exit code", async () => {
    const dir = mkdtempSync(join(tmpdir(), "jev-multi-kill-contract-"));
    try {
      let onKill: ((i: { signal: string; exitCode: number }) => unknown) | undefined;
      let killed: unknown;
      await runMultiRun({
        plan: { repeat: 2, minAgreement: 2, personas: null },
        strategy: "adversarial",
        outDir: dir,
        armKill: (fn) => {
          onKill = fn;
          return () => undefined;
        },
        runOnce: async ({ outDir }): Promise<RunEnvelope> => {
          if (outDir.endsWith("run-2")) killed = onKill?.({ signal: "SIGTERM", exitCode: 143 });
          return { ok: true, data: { outcome: "clean", missionOutcome: "clean", exitCode: 0 } };
        },
      });
      expect(killed).toMatchObject({ missionOutcome: "inconclusive", exitCode: 143, engine: expect.any(Object) });
      expect(formatMultiRunHuman(killed)).toMatch(/^INCONCLUSIVE: adversarial ×2/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
