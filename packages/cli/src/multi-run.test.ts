import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { UsageTracker, type UsageCounts } from "@jevitate/ai-core";
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
  return {
    index,
    ok: true,
    outcome,
    exitCode: outcome === "succeeded" || outcome === "clean" ? 0 : 1,
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
    expect(voteRuns([run(1, "succeeded", []), run(2, "succeeded", []), run(3, "exhausted", [])], 2).outcome).toBe("succeeded");
    const split = voteRuns([run(1, "succeeded", []), run(2, "exhausted", []), run(3, "blocked", [])], 2);
    expect(split.outcome).toBe("intermittent");
    expect(split.exitCode).toBe(4);
    expect(voteRuns([run(1, "succeeded", []), run(2, "exhausted", [])], 1).outcome).toBe("intermittent");
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

  it("the goal strategy votes on its own outcome; others on missionOutcome", () => {
    expect(summarizeRun("goal", 1, { ok: true, data: { outcome: "succeeded", missionOutcome: "clean", exitCode: 0 } }).outcome).toBe("succeeded");
    expect(summarizeRun("coverage", 1, { ok: true, data: { outcome: "exhausted", missionOutcome: "clean", exitCode: 0 } }).outcome).toBe("clean");
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
    expect(d.outcomes).toEqual({ admin: "succeeded", sales: "blocked" });
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
