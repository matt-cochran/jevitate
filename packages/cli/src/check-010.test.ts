import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Command } from "commander";
import { FakeClock, installClock, resetClock } from "@jevitate/domain";
import { FsJourneyStore, type Journey } from "@jevitate/journey";
import type { TargetDescriptor } from "@jevitate/recording";
import type { StepObserver } from "@jevitate/interpreter";
import { runCheck, type CheckResult, type CheckRunners, type RunCheckOptions } from "./check-api.js";
import { registerCheckCommand } from "./check-cli.js";
import { parseSuite } from "./check-suite.js";
import { journeyReviewHash } from "./journey-review.js";

/**
 * 0.10 in `jevitate check` (fake Journey runner, no browser): locator health on every Journey item
 * (advisory warnings; the opt-in `maxBrittleSteps` gate fails the check), the per-anchor machine
 * baseline and the replayed Journey's review hash (#469), and the trend against `--baseline`.
 */

const CSS_A: TargetDescriptor = { css: "main > div:nth-of-type(2) > span" };
const CSS_C: TargetDescriptor = { css: "main > section > div:nth-of-type(3)" };
const TEST_ID: TargetDescriptor = { testId: "pay", testIdAttr: "data-testid" };
const shown = { kind: "visible" as const, target: { role: "heading", name: "Cart" } };

function journey(first: TargetDescriptor = CSS_A): Journey {
  return {
    metadata: {
      id: "pay",
      name: "Pay",
      promoted: true,
      params: [],
      createdAtIso: "2026-10-09T00:00:00.000Z",
      anchors: [{ name: "paid", step: 2, stepId: "s-b" }],
    },
    recording: {
      version: "1.0.0",
      site: "https://shop.example",
      pages: [
        {
          url: "/cart",
          steps: [first, TEST_ID, CSS_C].map((target, i) => ({ stepId: `s-${"abc"[i]}`, step: { kind: "click" as const, target, expect: shown } })),
        },
      ],
    },
  };
}

let dir: string;
let fake: FakeClock;
beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "jev-check-010-"));
  fake = new FakeClock({ startMs: Date.parse("2026-10-09T12:00:00.000Z") });
  installClock(fake);
  await new FsJourneyStore(dir).put(journey());
});
afterEach(() => {
  resetClock();
  rmSync(dir, { recursive: true, force: true });
});

/** A fake Journey runner: each step takes 100 ms through the check's step observer; `ok` unless told otherwise. */
function journeyRunner(outcome: "ok" | "quarantined" = "ok"): CheckRunners["journey"] {
  return (async (o: { observer?: StepObserver }) => {
    const steps = journey().recording.pages[0]!.steps;
    for (const [index, recorded] of steps.entries()) {
      await o.observer?.beforeStep?.({ actor: {} as never, index, recorded });
      await fake.advanceBy(100);
      await o.observer?.afterStep?.({ actor: {} as never, index, recorded, outcome: "done" });
    }
    return outcome === "ok" ? { outcome: "ok", output: {} } : { outcome: "quarantined", reason: "step 3 failed", at: 2 };
  }) as unknown as CheckRunners["journey"];
}

const suite = () => parseSuite({ version: 1, name: "s", targets: [{ name: "shop", url: "https://shop.example/cart", journeys: [{ id: "pay" }] }] }, join(dir, "suite.json"));

function check(extra: Partial<RunCheckOptions> = {}, outcome: "ok" | "quarantined" = "ok", out = "out"): Promise<CheckResult> {
  return runCheck({ suite: suite(), outDir: join(dir, out), journeysDir: dir, projectDir: null, runners: { journey: journeyRunner(outcome) }, ...extra });
}

const read = (p: string): string => readFileSync(p, "utf8");

describe("#470 locator health in check", () => {
  it("a Journey item carries its run's locator health", async () => {
    expect((await check()).items[0]?.locatorHealth?.brittle).toBe(2);
  });

  it("without --max-brittle-steps brittle steps never fail the check", async () => {
    expect((await check()).exitCode).toBe(0);
  });

  it("without the gate each fix is a JUnit warning, not a failure", async () => {
    expect(read((await check()).junitPath)).toMatch(/<property name="warning" value="add data-testid=/);
  });

  it("without the gate each fix is a SARIF warning", async () => {
    const sarif = JSON.parse(read((await check()).sarifPath));
    expect(sarif.runs[0].results.map((r: { ruleId: string; level: string }) => `${r.ruleId} ${r.level}`)).toEqual([
      "jevitate/locator-health/brittle-locator warning",
      "jevitate/locator-health/brittle-locator warning",
    ]);
  });

  it("past --max-brittle-steps the check fails (exit 1)", async () => {
    expect((await check({ maxBrittleSteps: 1 })).exitCode).toBe(1);
  });

  it("past the gate the Journey item fails on a locator-health finding naming the threshold", async () => {
    const r = await check({ maxBrittleSteps: 1 });
    expect(r.findings.filter((f) => f.gating).map((f) => f.title)).toEqual([expect.stringContaining("2 brittle locator step(s), more than --max-brittle-steps 1")]);
  });

  it("within the gate the check passes", async () => {
    expect((await check({ maxBrittleSteps: 2 })).exitCode).toBe(0);
  });

  it("the check's summary aggregates the health and the gate's verdict", async () => {
    expect((await check({ maxBrittleSteps: 1 })).locatorHealth).toMatchObject({ journeys: 1, stable: 1, brittle: 2, maxBrittleSteps: 1, exceeded: true });
  });

  it("an invalid threshold is refused before anything runs", async () => {
    await expect(check({ maxBrittleSteps: -1 })).rejects.toMatchObject({ code: "E_CHECK_ARGS" });
  });

  it("with --baseline the summary reports the trend against the baseline's runs", async () => {
    await check({}, "ok", "first");
    await new FsJourneyStore(dir).put(journey(TEST_ID));
    const r = await check({ baseline: "last", baselineDirs: [join(dir, "first", "results")] }, "ok", "second");
    expect(r.locatorHealth?.trend?.line).toBe("trend vs baseline: 1 improved, 0 regressed (brittle -1)");
  });
});

describe("#469 anchor baselines and the replayed hash in check", () => {
  it("a clean Journey item's baseline measures each anchor from the first step's start", async () => {
    expect((await check()).items[0]?.baseline?.anchors.find((a) => a.name === "paid")).toEqual({ name: "paid", step: 2, stepId: "s-b", atMs: 200 });
  });

  it("a Journey item that did not complete has no baseline", async () => {
    expect((await check({}, "quarantined")).items[0]?.baseline).toBeUndefined();
  });

  it("a Journey item names the review hash of the revision it replayed", async () => {
    expect((await check()).items[0]?.journeyHash).toBe(journeyReviewHash((await new FsJourneyStore(dir).get("pay"))!));
  });

  it("check.json carries the baseline", async () => {
    expect(JSON.parse(read((await check()).jsonPath)).data.items[0].baseline.totalMs).toBe(300);
  });
});

describe("#470 check --max-brittle-steps reaches the gate", () => {
  async function cli(argv: readonly string[]): Promise<number | undefined> {
    const program = new Command();
    program.exitOverride();
    program.configureOutput({ writeOut: () => {}, writeErr: () => {} });
    registerCheckCommand(program, { buildGateways: () => Promise.reject(new Error("no gateways")), journeysDir: dir, catalogDir: join(dir, "no-project"), targetsConfigPath: join(dir, "no-targets.json"), runners: { journey: journeyRunner() } }, (c) => c);
    process.exitCode = undefined;
    await program.parseAsync(["check", "--suite", join(dir, "suite.json"), "--out", join(dir, "cli-out"), ...argv], { from: "user" });
    const code = process.exitCode === undefined ? undefined : Number(process.exitCode);
    process.exitCode = undefined;
    return code;
  }

  beforeEach(() => {
    const s = { version: 1, name: "s", targets: [{ name: "shop", url: "https://shop.example/cart", journeys: [{ id: "pay" }] }] };
    writeFileSync(join(dir, "suite.json"), JSON.stringify(s));
  });

  it("the CLI flag fails the check past the threshold (exit 1)", async () => {
    expect(await cli(["--max-brittle-steps", "1"])).toBe(1);
  });
});
