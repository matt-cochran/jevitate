import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { FakeGenerationGateway, UsageTracker } from "@jevitate/ai-core";
import { FsJourneyStore } from "@jevitate/journey";
import { runCheck, type CheckGateways, type CheckRunners, type RunCheckOptions } from "./check-api.js";
import { parseSuite } from "./check-suite.js";
import type { GitExec } from "./change-context.js";

/**
 * #453 Lane E — `jevitate check --self-heal` over fake runners (no browser, no model): a quarantined
 * Journey is re-run once with the change scope; a proposal is pending review (exit 5), never a pass.
 */

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "jevitate-check-heal-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const URL0 = "https://shop.example/app";
const gw = (): CheckGateways => ({ judge: {} as CheckGateways["judge"], gen: new FakeGenerationGateway(), usage: new UsageTracker() });

const journeySuite = (ids: string[]) =>
  parseSuite({ version: 1, name: "ci", targets: [{ name: "shop", url: URL0, journeys: ids.map((id) => ({ id })) }] }, join(dir, "suite.json"));

type Scripted = Record<string, unknown>;
/** A fake Journey runner: a fail-closed call answers `first`; a call carrying a self-heal policy answers `second`. */
function runner(first: Scripted, second: Scripted): { runner: CheckRunners["journey"]; calls: Array<{ id: string; heal: boolean; scope?: unknown }> } {
  const calls: Array<{ id: string; heal: boolean; scope?: unknown }> = [];
  const fn = (async (o: { id: string; policy?: { selfHeal?: { mode: string } }; heal?: { scope: unknown } }) => {
    const heal = o.policy?.selfHeal !== undefined && o.policy.selfHeal.mode !== "fail-closed";
    calls.push({ id: o.id, heal, ...(o.heal === undefined ? {} : { scope: o.heal.scope }) });
    return heal ? second : first;
  }) as unknown as CheckRunners["journey"];
  return { runner: fn, calls };
}

const QUARANTINED = { outcome: "quarantined", reason: "step 1: click 'Create New' not found", at: 1 };
const PENDING = { outcome: "healed-pending-review", output: {}, revision: { steps: [] }, proposal: { id: "p-1", path: "/j/.proposals/p-1.json", steps: [1] }, heal: { verdict: "proposed", attempts: [{}] } };
const EXHAUSTED = { outcome: "heal-exhausted", reason: "every candidate was refuted", at: 1, heal: { verdict: "exhausted", attempts: [{}, {}] } };

async function seedJourney(id: string): Promise<void> {
  await new FsJourneyStore(dir).put({
    metadata: { id, name: id, promoted: true, params: [], createdAtIso: "2026-09-24T00:00:00.000Z" },
    recording: { version: "1.0.0", site: "https://shop.example", pages: [{ url: "/app", steps: [{ step: { kind: "navigate", url: "/app", expect: { kind: "urlIncludes", text: "/app" } } }] }] },
  });
}

const base = (suite: ReturnType<typeof journeySuite>, extra: Partial<RunCheckOptions>): RunCheckOptions => ({
  suite,
  outDir: join(dir, "out"),
  journeysDir: dir,
  gateways: async () => gw(),
  aiMode: "fake",
  selfHeal: { selfHeal: "hybrid", changeNotes: ["renamed Create New to Create"] },
  ...extra,
});

describe("check --self-heal (#453)", () => {
  it("a quarantined Journey whose re-run proposes a revision is pending-review and the check exits 5", async () => {
    await seedJourney("j1");
    const f = runner(QUARANTINED, PENDING);
    const r = await runCheck(base(journeySuite(["j1"]), { runners: { journey: f.runner } }));
    expect(r).toMatchObject({ exitCode: 5, verdict: "pending-review", summary: { pendingReview: 1, gatingFindings: 0 } });
    expect(r.items[0]).toMatchObject({ verdict: "pending-review", outcome: "healed-pending-review" });
  });

  it("the proposal id and path land in check.json proposals", async () => {
    await seedJourney("j1");
    const r = await runCheck(base(journeySuite(["j1"]), { runners: { journey: runner(QUARANTINED, PENDING).runner } }));
    expect(r.proposals).toEqual([{ journeyId: "j1", proposalId: "p-1", path: "/j/.proposals/p-1.json" }]);
    expect(JSON.parse(readFileSync(r.jsonPath, "utf8")).data.proposals).toHaveLength(1);
  });

  it("a quarantined Journey whose re-run is heal-exhausted fails the check with exit 1", async () => {
    await seedJourney("j1");
    const r = await runCheck(base(journeySuite(["j1"]), { runners: { journey: runner(QUARANTINED, EXHAUSTED).runner } }));
    expect(r).toMatchObject({ exitCode: 1, verdict: "fail", summary: { gatingFindings: 1 } });
    expect(r.items[0]).toMatchObject({ verdict: "failed", outcome: "heal-exhausted", healAttempts: 2 });
  });

  it("a Journey that passes the fail-closed run is never re-run", async () => {
    await seedJourney("j1");
    const f = runner({ outcome: "ok", output: {} }, PENDING);
    const r = await runCheck(base(journeySuite(["j1"]), { runners: { journey: f.runner } }));
    expect([r.exitCode, f.calls.map((c) => c.heal)]).toEqual([0, [false]]);
  });

  it("without --self-heal a quarantined Journey fails closed after one run", async () => {
    await seedJourney("j1");
    const f = runner(QUARANTINED, PENDING);
    const r = await runCheck(base(journeySuite(["j1"]), { runners: { journey: f.runner }, selfHeal: undefined }));
    expect([r.exitCode, f.calls.length]).toEqual([1, 1]);
  });

  it("the re-run carries the shared change scope and the original result is linked by healOf", async () => {
    await seedJourney("j1");
    const f = runner(QUARANTINED, PENDING);
    const r = await runCheck(base(journeySuite(["j1"]), { runners: { journey: f.runner } }));
    const healPath = r.items[0]?.resultPath ?? "";
    expect(basename(healPath)).toMatch(/-1\.heal\.result\.json$/);
    const original = healPath.replace(".heal.result.json", ".result.json");
    expect(existsSync(original)).toBe(true);
    expect(JSON.parse(readFileSync(healPath, "utf8")).result.healOf).toBe(basename(original));
  });

  it("reads the change scope once however many Journeys re-run", async () => {
    await seedJourney("a");
    await seedJourney("b");
    const reads = async (ids: string[]): Promise<number> => {
      let n = 0;
      const exec: GitExec = async () => {
        n += 1;
        return { stdout: "" };
      };
      await runCheck(
        base(journeySuite(ids), {
          outDir: join(dir, `out-${ids.length}`),
          runners: { journey: runner(QUARANTINED, PENDING).runner },
          selfHeal: { selfHeal: "hybrid", changes: "HEAD~1..HEAD", changeNotes: [] },
          changeGitExec: exec,
        }),
      ).catch(() => undefined);
      return n;
    };
    const one = await reads(["a"]);
    expect(await reads(["a", "b"])).toBe(one);
  });

  it("a self-heal without a change context is refused before anything runs", async () => {
    await seedJourney("j1");
    const f = runner(QUARANTINED, PENDING);
    await expect(runCheck(base(journeySuite(["j1"]), { runners: { journey: f.runner }, selfHeal: { selfHeal: "hybrid", changeNotes: [] } }))).rejects.toMatchObject({ code: "E_CHECK_ARGS" });
    expect(f.calls).toEqual([]);
  });

  it("a self-heal without a gateway is refused before anything runs", async () => {
    await seedJourney("j1");
    const f = runner(QUARANTINED, PENDING);
    await expect(runCheck(base(journeySuite(["j1"]), { runners: { journey: f.runner }, gateways: undefined, aiMode: undefined }))).rejects.toMatchObject({ code: "E_AI_SETUP_REQUIRED" });
    expect(f.calls).toEqual([]);
  });

  it("junit reports a pending Journey as a healed-pending-review failure naming the proposal", async () => {
    await seedJourney("j1");
    const r = await runCheck(base(journeySuite(["j1"]), { runners: { journey: runner(QUARANTINED, PENDING).runner } }));
    expect(readFileSync(r.junitPath, "utf8")).toContain('<failure message="proposed revision p-1 awaiting review" type="healed-pending-review">/j/.proposals/p-1.json</failure>');
  });

  it("sarif reports a pending Journey on the heal-pending rule as a warning with the proposal", async () => {
    await seedJourney("j1");
    const r = await runCheck(base(journeySuite(["j1"]), { runners: { journey: runner(QUARANTINED, PENDING).runner } }));
    const result = JSON.parse(readFileSync(r.sarifPath, "utf8")).runs[0].results[0];
    expect(result).toMatchObject({ ruleId: "jevitate/journey-heal-pending-review", level: "warning", properties: { proposal: { id: "p-1", path: "/j/.proposals/p-1.json" } } });
  });

  it("sarif reports an exhausted heal on the journey rule as an error with its attempts", async () => {
    await seedJourney("j1");
    const r = await runCheck(base(journeySuite(["j1"]), { runners: { journey: runner(QUARANTINED, EXHAUSTED).runner } }));
    const result = JSON.parse(readFileSync(r.sarifPath, "utf8")).runs[0].results[0];
    expect(result).toMatchObject({ ruleId: "jevitate/journey-assertion/journey:j1", level: "error", properties: { healAttempts: 2 } });
  });

  it("junit reports an exhausted heal as a journey-assertion failure", async () => {
    await seedJourney("j1");
    const r = await runCheck(base(journeySuite(["j1"]), { runners: { journey: runner(QUARANTINED, EXHAUSTED).runner } }));
    expect(readFileSync(r.junitPath, "utf8")).toContain('type="journey-assertion"');
  });
});

describe("check exit code precedence (#453)", () => {
  // item outcome sets -> exit code; 1 > 2 > 5 > 0.
  const table: Array<[string, Scripted[], number]> = [
    ["pending only", [PENDING], 5],
    ["pending and exhausted", [PENDING, EXHAUSTED], 1],
    ["nothing pending", [{ outcome: "ok", output: {} }], 0],
  ];
  for (const [name, reruns, code] of table) {
    it(`${name} exits ${code}`, async () => {
      await seedJourney("a");
      await seedJourney("b");
      const ids = reruns.length === 1 ? ["a"] : ["a", "b"];
      let k = 0;
      const journey = (async (o: { policy?: { selfHeal?: { mode: string } } }) => {
        const heal = o.policy?.selfHeal !== undefined && o.policy.selfHeal.mode !== "fail-closed";
        if (!heal) return code === 0 ? { outcome: "ok", output: {} } : QUARANTINED;
        return reruns[k++] ?? PENDING;
      }) as unknown as CheckRunners["journey"];
      const r = await runCheck(base(journeySuite(ids), { runners: { journey } }));
      expect(r.exitCode).toBe(code);
    });
  }

  it("an errored item outranks a pending proposal (2 > 5)", async () => {
    await seedJourney("a");
    const suite = parseSuite(
      { version: 1, name: "ci", budget: { maxActions: 1 }, targets: [{ name: "shop", url: URL0, journeys: [{ id: "a" }, { id: "b" }] }] },
      join(dir, "suite.json"),
    );
    await seedJourney("b");
    const journey = runner(QUARANTINED, PENDING).runner;
    const r = await runCheck(base(suite, { runners: { journey } }));
    expect(r.exitCode).toBe(2);
  });
});
