import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { UsageTracker } from "@jevitate/ai-core";
import { BudgetMeter, affectedBy, runCheck, type CheckGateways, type CheckRunners } from "./check-api.js";
import { parseSuite, SuiteError } from "./check-suite.js";
import { loadRunFile, tagBaseline } from "./report-api.js";

/**
 * #137 — the CI gate's decision logic over fake runners (no browser): the budget fails closed,
 * hard findings gate and advisory ones do not, a baseline gates only new findings, and
 * `--changed-routes` skips unaffected Journeys/goals.
 */

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "jevitate-check-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const URL0 = "https://shop.example/app";

/** A fake feature runner: writes a result like the real one, spending `spend` actions (capped by bounds unless `ignoreBounds`). */
function featureRunner(script: Array<{ spend: number; defects?: unknown[]; advisories?: unknown[]; outcome?: string; ignoreBounds?: boolean }>): {
  runner: CheckRunners["feature"];
  calls: Array<{ maxActions?: number }>;
} {
  const calls: Array<{ maxActions?: number }> = [];
  let i = 0;
  const runner = (async (o: { outDir?: string; seedUrl: string; bounds?: { maxActions?: number } }) => {
    const s = script[Math.min(i, script.length - 1)] ?? { spend: 0 };
    i += 1;
    calls.push({ ...(o.bounds?.maxActions === undefined ? {} : { maxActions: o.bounds.maxActions }) });
    const spend = s.ignoreBounds === true ? s.spend : Math.min(s.spend, o.bounds?.maxActions ?? Infinity);
    const transcript = Array.from({ length: spend }, (_, k) => ({ step: k, op: "click" }));
    const missionOutcome = s.outcome ?? ((s.defects?.length ?? 0) > 0 ? "defects-found" : "clean");
    const resultPath = join(o.outDir ?? dir, `feature-2026-09-24T10-00-0${i}-000Z.result.json`);
    const result = { target: { seedUrl: o.seedUrl, allowlist: ["https://shop.example"] }, transcript, defects: s.defects ?? [], advisories: s.advisories ?? [], hangs: [] };
    writeFileSync(resultPath, JSON.stringify({ missionOutcome, exitCode: 0, result }));
    return { ...result, resultPath, missionOutcome, exitCode: 0 };
  }) as unknown as CheckRunners["feature"];
  return { runner, calls };
}

const invariantDefect = (fp: string) => ({
  fingerprint: fp,
  related: [fp],
  kind: "invariant",
  title: `Invariant "${fp}" violated on /app`,
  route: "/app",
  url: URL0,
  invariant: { id: fp, action: { op: "click", control: "Import" }, evidence: [] },
  occurrences: 1,
  repro: { recordingStepIndex: 1 },
});

function suite(missions: number, extra: Record<string, unknown> = {}, target: Record<string, unknown> = {}) {
  return parseSuite(
    {
      version: 1,
      name: "ci",
      ...extra,
      targets: [
        {
          name: "shop",
          url: URL0,
          missions: Array.from({ length: missions }, (_, k) => ({ name: `m${k + 1}`, strategy: "feature", feature: `f${k + 1}` })),
          ...target,
        },
      ],
    },
    join(dir, "suite.json"),
  );
}

function junit(path: string): string {
  return readFileSync(path, "utf8");
}

describe("check budget fails closed (#137)", () => {
  it("passes each item the remaining actions, and never runs an item once the budget is spent", async () => {
    const f = featureRunner([{ spend: 3 }, { spend: 3 }, { spend: 3 }]);
    const r = await runCheck({ suite: suite(3, { budget: { maxActions: 5 } }), outDir: join(dir, "out"), journeysDir: dir, runners: { feature: f.runner } });
    expect(f.calls).toEqual([{ maxActions: 5 }, { maxActions: 2 }]); // the third never ran
    expect(r.items.map((i) => [i.name, i.verdict, i.actions])).toEqual([
      ["m1", "passed", 3],
      ["m2", "passed", 2],
      ["m3", "error", 0],
    ]);
    expect(r.items[2]?.error).toEqual({ type: "budget-exceeded", message: "not run: action budget exhausted: 5/5" });
    expect(r.budget).toMatchObject({ used: { actions: 5 }, exceeded: "action budget exhausted: 5/5" });
    expect(r).toMatchObject({ verdict: "fail", exitCode: 2 });
    expect(junit(r.junitPath)).toContain('<error message="not run: action budget exhausted: 5/5" type="budget-exceeded"/>');
  });

  it("fails when an item overshoots the budget, even if every item passed", async () => {
    const f = featureRunner([{ spend: 9, ignoreBounds: true }]);
    const r = await runCheck({ suite: suite(1, { budget: { maxActions: 5 } }), outDir: join(dir, "out"), journeysDir: dir, runners: { feature: f.runner } });
    expect(r.items[0]?.verdict).toBe("passed");
    expect(r.budget.exceeded).toBe("action budget exceeded: 9 > 5");
    expect(r).toMatchObject({ verdict: "fail", exitCode: 2 });
    // The overrun is a JUnit error of its own, so CI shows why a green list still failed.
    expect(junit(r.junitPath)).toContain('name="total budget"');
  });

  it("time: an item that starts after the wall-clock budget is spent is not run", async () => {
    let t = 0;
    const f = featureRunner([{ spend: 1 }]);
    const clocked = (async (o: Parameters<CheckRunners["feature"]>[0]) => {
      t += 90_000; // each item takes 1.5 minutes
      return f.runner(o);
    }) as CheckRunners["feature"];
    const r = await runCheck({ suite: suite(2, { budget: { maxMinutes: 1 } }), outDir: join(dir, "out"), journeysDir: dir, runners: { feature: clocked }, now: () => t });
    expect(r.items.map((i) => i.verdict)).toEqual(["passed", "error"]);
    expect(r.budget.exceeded).toMatch(/^time budget exceeded: 1\.50 > 1 min$/);
    expect(r.exitCode).toBe(2);
  });

  it("usd: a real gateway whose provider reports no cost makes a maxUsd budget unmeasurable — fail closed", () => {
    const usage = new UsageTracker();
    usage.recordGeneration({ inputTokens: 10, outputTokens: 5 });
    const real = new BudgetMeter({ maxUsd: 1 });
    expect(real.charge(0, usage.snapshot())).toMatch(/not measurable/);
    const fake = new BudgetMeter({ maxUsd: 1 }, { costKnownZero: true });
    expect(fake.charge(0, usage.snapshot())).toBeUndefined();
    const priced = new UsageTracker();
    priced.recordGeneration({ inputTokens: 10, outputTokens: 5, usd: 1.5 });
    expect(new BudgetMeter({ maxUsd: 1 }).charge(0, priced.snapshot())).toBe("usd budget exceeded: $1.5000 > $1");
  });
});

describe("check gating (#137)", () => {
  it("a violated invariant fails the gate; an advisory finding does not, unless the suite opts in", async () => {
    const advisory = { fingerprint: "adv", kind: "console-error", title: "403 console error", route: "/app", url: URL0, status: 403, occurrenceSteps: [1] };
    const f = featureRunner([{ spend: 1, defects: [invariantDefect("inv1")] }, { spend: 1, advisories: [advisory] }]);
    const r = await runCheck({ suite: suite(2), outDir: join(dir, "out"), journeysDir: dir, runners: { feature: f.runner }, targetBuild: "build-42" });
    expect(r.items.map((i) => i.verdict)).toEqual(["failed", "passed"]);
    expect(r).toMatchObject({ verdict: "fail", exitCode: 1, targetBuild: "build-42", summary: { gatingFindings: 1, failed: 1, passed: 1 } });
    expect(r.findings.map((x) => [x.category, x.gating])).toEqual([
      ["invariant", true],
      ["advisory", false],
    ]);
    // Every result carries the engine and the caller's target build.
    const stamped = JSON.parse(readFileSync(r.results[0] ?? "", "utf8")) as { result: { targetBuild: string; suite: unknown; engine: { commit: string } } };
    expect(stamped.result).toMatchObject({ targetBuild: "build-42", suite: { name: "ci", target: "shop", item: "m1" } });
    expect(typeof stamped.result.engine.commit).toBe("string");
    expect(loadRunFile(r.results[0] ?? "")?.targetBuild).toBe("build-42");

    const opted = featureRunner([{ spend: 1, advisories: [advisory] }]);
    const r2 = await runCheck({ suite: suite(1, { gateAdvisory: true }), outDir: join(dir, "out2"), journeysDir: dir, runners: { feature: opted.runner } });
    expect(r2).toMatchObject({ verdict: "fail", exitCode: 1 });
  });

  it("a crashed or inconclusive run is an error, never a pass", async () => {
    const f = featureRunner([{ spend: 0, outcome: "inconclusive" }]);
    const r = await runCheck({ suite: suite(1), outDir: join(dir, "out"), journeysDir: dir, runners: { feature: f.runner } });
    expect(r.items[0]).toMatchObject({ verdict: "error", error: { type: "inconclusive" } });
    expect(r).toMatchObject({ verdict: "fail", exitCode: 2 });
  });

  it("with a baseline, only findings not in the baseline gate", async () => {
    const first = featureRunner([{ spend: 1, defects: [invariantDefect("known")] }]);
    const before = await runCheck({ suite: suite(1), outDir: join(dir, "before"), journeysDir: dir, runners: { feature: first.runner } });
    await tagBaseline({ name: "main", runs: before.results.map((p) => loadRunFile(p)).filter((x): x is NonNullable<typeof x> => x !== null), dir: join(dir, "baselines") });

    const same = featureRunner([{ spend: 1, defects: [invariantDefect("known")] }]);
    const r = await runCheck({
      suite: suite(1),
      outDir: join(dir, "after"),
      journeysDir: dir,
      runners: { feature: same.runner },
      baseline: "main",
      baselinesDir: join(dir, "baselines"),
    });
    expect(r).toMatchObject({ verdict: "pass", exitCode: 0, diff: { summary: { "still-present": 1, new: 0 } } });
    expect(r.findings[0]).toMatchObject({ gating: false, status: "still-present" });

    const worse = featureRunner([{ spend: 1, defects: [invariantDefect("known"), invariantDefect("fresh")] }]);
    const r2 = await runCheck({
      suite: suite(1),
      outDir: join(dir, "worse"),
      journeysDir: dir,
      runners: { feature: worse.runner },
      baseline: "main",
      baselinesDir: join(dir, "baselines"),
    });
    expect(r2).toMatchObject({ verdict: "fail", exitCode: 1, summary: { gatingFindings: 1 } });
    expect(r2.findings.find((x) => x.gating)?.title).toContain("fresh");
    const sarif = JSON.parse(readFileSync(r2.sarifPath, "utf8")) as { runs: Array<{ results: Array<{ level: string; properties: { status: string } }> }> };
    expect(sarif.runs[0]?.results.map((x) => [x.level, x.properties.status]).sort()).toEqual([
      ["error", "new"],
      ["warning", "still-present"],
    ]);
  });

  it("a suite needing a model gateway with none selected is refused before anything runs", async () => {
    const f = featureRunner([{ spend: 1 }]);
    const s = suite(0, {}, { goals: [{ goal: "buy", success: ["urlIncludes:/done"] }] });
    await expect(runCheck({ suite: s, outDir: join(dir, "out"), journeysDir: dir, runners: { feature: f.runner } })).rejects.toMatchObject({
      code: "E_AI_SETUP_REQUIRED",
    });
    expect(f.calls).toEqual([]);
  });

  it("--changed-routes skips an unaffected goal (never reported as passing)", async () => {
    const usage = new UsageTracker();
    const gw: CheckGateways = { judge: {} as CheckGateways["judge"], gen: {} as CheckGateways["gen"], usage };
    const goals: string[] = [];
    const goal = (async (o: { goal: string; outDir?: string }) => {
      goals.push(o.goal);
      const resultPath = join(o.outDir ?? dir, `explore-2026-09-24T10-00-00-000Z.result.json`);
      writeFileSync(resultPath, JSON.stringify({ missionOutcome: "succeeded", exitCode: 0, result: { outcome: "succeeded", checks: [], target: { seedUrl: URL0 } } }));
      return { outcome: "succeeded", actions: 2, resultPath };
    }) as unknown as CheckRunners["goal"];
    const s = suite(0, {}, {
      goals: [
        { name: "settings", goal: "change settings", success: ["urlIncludes:/settings"], routes: ["/settings/**"] },
        { name: "cart", goal: "check out", success: ["urlIncludes:/done"], url: "https://shop.example/cart" },
      ],
    });
    const r = await runCheck({ suite: s, outDir: join(dir, "out"), journeysDir: dir, runners: { goal }, gateways: async () => gw, aiMode: "fake", changedRoutes: ["/cart/**"] });
    expect(goals).toEqual(["check out"]);
    expect(r.items.map((i) => [i.name, i.verdict])).toEqual([
      ["settings", "skipped"],
      ["cart", "passed"],
    ]);
    expect(r.exitCode).toBe(0);
    expect(junit(r.junitPath)).toContain('<skipped message="not affected by --changed-routes"/>');
  });
});

describe("changed-route matching", () => {
  it("matches concrete routes and globs both ways; unknown routes always run", () => {
    expect(affectedBy(["/cart"], ["/cart/**"])).toBe(true);
    expect(affectedBy(["/cart/checkout"], ["/cart/**"])).toBe(true);
    expect(affectedBy(["/cart/**"], ["/cart/checkout"])).toBe(true);
    expect(affectedBy(["/settings/**"], ["/cart/**"])).toBe(false);
    expect(affectedBy(undefined, ["/cart/**"])).toBe(true);
  });
});

describe("suite validation", () => {
  it("refuses a typo'd field, a goal without success checks or a bad budget, and resolves paths against the suite file", () => {
    const refuse = (raw: unknown) => {
      try {
        parseSuite(raw, "s.json");
      } catch (e) {
        expect(e).toBeInstanceOf(SuiteError);
        return (e as Error).message;
      }
      throw new Error("accepted");
    };
    expect(refuse({ version: 1, targets: [{ name: "a", url: URL0, jouneys: [] }] })).toBe(
      "s.json: $.targets[0].jouneys: unknown field (allowed: name, url, allow, storageState, invariants, journeysDir, journeys, goals, missions, verifyFix)",
    );
    expect(refuse({ version: 1, targets: [{ name: "a", url: URL0, goals: [{ goal: "g" }] }] })).toMatch(/goals\[0\]\.success: at least one success check/);
    expect(refuse({ version: 2, targets: [] })).toBe("s.json: $.version: must be 1");
    expect(refuse({ version: 1, budget: { maxActions: -1 }, targets: [] })).toBe("s.json: $.budget.maxActions: must be a positive integer");
    mkdirSync(join(dir, "inv"));
    const ok = parseSuite({ version: 1, targets: [{ name: "a", url: URL0, invariants: ["inv/x.json"] }] }, join(dir, "s.json"));
    expect(ok.targets[0]?.invariants).toEqual([join(dir, "inv/x.json")]);
  });
});
