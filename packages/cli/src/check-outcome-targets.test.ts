import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FakeClock, installClock, resetClock } from "@jevitate/domain";
import { FsJourneyStore, type Journey } from "@jevitate/journey";
import type { StepObserver } from "@jevitate/interpreter";
import { runCheck, type CheckResult, type CheckRunners } from "./check-api.js";
import { parseSuite } from "./check-suite.js";

/**
 * #643 in `jevitate check` (fake Journey runner, no browser): a passed Journey item whose catalog job
 * declares duration targets carries the outcome-target results against its machine baseline.
 */

const shown = { kind: "visible" as const, target: { role: "heading", name: "Cart" } };

function journey(job: string | undefined): Journey {
  return {
    metadata: { id: "pay", name: "Pay", promoted: true, params: [], createdAtIso: "2026-10-09T00:00:00.000Z", ...(job === undefined ? {} : { job }) },
    recording: {
      version: "1.0.0",
      site: "https://shop.example",
      pages: [{ url: "/cart", steps: ["a", "b", "c"].map((id) => ({ stepId: `s-${id}`, step: { kind: "click" as const, target: { testId: id }, expect: shown } })) }],
    },
  };
}

const jobs = {
  jobs: [
    {
      id: "buy",
      trigger: "my cart holds what I need",
      motivation: "pay for it",
      outcome: "receive my order",
      desiredOutcomes: [
        { id: "pay-fast", direction: "minimize", measure: "time", object: "the time it takes to pay", metric: { kind: "duration", from: "job_start", to: "job_end", stat: "p50" }, target: { op: "<=", value: 0.2, unit: "s" } },
      ],
    },
  ],
};

let dir: string;
let fake: FakeClock;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "jev-check-643-"));
  mkdirSync(join(dir, "project"));
  writeFileSync(join(dir, "project", "jobs.json"), JSON.stringify(jobs));
  fake = new FakeClock({ startMs: Date.parse("2026-10-09T12:00:00.000Z") });
  installClock(fake);
});
afterEach(() => {
  resetClock();
  rmSync(dir, { recursive: true, force: true });
});

/** Each of the three steps takes 100 ms through the check's step observer. */
const runner = (async (o: { observer?: StepObserver }) => {
  for (const [index, recorded] of journey(undefined).recording.pages[0]!.steps.entries()) {
    await o.observer?.beforeStep?.({ actor: {} as never, index, recorded });
    await fake.advanceBy(100);
    await o.observer?.afterStep?.({ actor: {} as never, index, recorded, outcome: "done" });
  }
  return { outcome: "ok", output: {} };
}) as unknown as CheckRunners["journey"];

async function check(job: string | undefined): Promise<CheckResult> {
  await new FsJourneyStore(dir).put(journey(job));
  const suite = parseSuite({ version: 1, name: "s", targets: [{ name: "shop", url: "https://shop.example/cart", journeys: [{ id: "pay" }] }] }, join(dir, "suite.json"));
  return runCheck({ suite, outDir: join(dir, "out"), journeysDir: dir, projectDir: join(dir, "project"), runners: { journey: runner } });
}

describe("#643 outcome targets in check", () => {
  it("a passed Journey item of a job with a duration target reports the replay floor's miss", async () => {
    expect((await check("buy")).items[0]?.outcomeTargets).toEqual([expect.objectContaining({ outcomeId: "pay-fast", status: "miss", floorSeconds: 0.3 })]);
  });

  it("a Journey item linked to no job carries no outcome targets", async () => {
    expect((await check(undefined)).items[0]?.outcomeTargets).toBeUndefined();
  });

  it("an outcome-target miss never fails the check", async () => {
    expect((await check("buy")).exitCode).toBe(0);
  });
});
