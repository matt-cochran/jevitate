import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { FakeClock, installClock, resetClock } from "@jevitate/domain";
import type { Journey } from "@jevitate/journey";
import { journeyRunLogsRoot, latestJourneyRun, withJourneyRunRecord, type JourneyRunRecord } from "./journey-run-record.js";
import { buildJourneyReview } from "./journey-review.js";

/**
 * Owner decision "Proof role" (2026-11-09): the run record carries the run's job verdict, code tokens only,
 * so readiness and review can lead with the latest run's `job.attainment`. Additive and optional: a record
 * from before 0.30.0 reads `unverified`.
 */

let root: string;
let clock: FakeClock;

function journey(name = "Publish"): Journey {
  return {
    metadata: { id: "publish", name, promoted: false, params: [], createdAtIso: "2026-11-01T00:00:00Z" },
    recording: { version: "1.0.0", site: "https://example.test", pages: [{ url: "/editor", steps: [{ step: { kind: "click", target: { testId: "go" }, expect: { kind: "textIncludes", target: { testId: "status" }, text: "Live" } } }] }] },
  };
}

function records(): JourneyRunRecord[] {
  const out: JourneyRunRecord[] = [];
  for (const date of readdirSync(root)) for (const name of readdirSync(join(root, date))) if (name.startsWith("journey-run-")) out.push(JSON.parse(readFileSync(join(root, date, name), "utf8")) as JourneyRunRecord);
  return out;
}

beforeEach(() => {
  // The suite turns run records off (vitest.config.ts); these tests are about them.
  vi.stubEnv("JEVITATE_RUN_RECORD", "");
  root = mkdtempSync(join(tmpdir(), "jev-run-job-"));
  clock = new FakeClock({ startMs: Date.UTC(2026, 10, 9, 12) });
  installClock(clock);
});

afterEach(() => {
  vi.unstubAllEnvs();
  resetClock();
  rmSync(root, { recursive: true, force: true });
});

describe("the run record's job verdict", () => {
  it("carries the verdict a done-check scope returned on the result (run_journey, a queued call)", async () => {
    await withJourneyRunRecord({ channel: "mcp", id: "publish", params: {}, logsRoot: root }, async (recorder) => {
      recorder.noteJourney(journey());
      return { outcome: "ok", job: { attainment: "achieved", basis: "done-check" } };
    });
    const [rec] = records();
    expect(rec?.job).toEqual({ attainment: "achieved", basis: "done-check" });
    expect(rec?.journey.proofHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("takes the verdict of the scope it runs inside when the result has none (journey run), on a throw too", async () => {
    await withJourneyRunRecord({ channel: "cli", id: "publish", params: {}, logsRoot: root, job: () => ({ attainment: "not-achieved", basis: "done-check" }) }, async () => ({ outcome: "ok" }));
    await expect(
      withJourneyRunRecord({ channel: "cli", id: "publish", params: {}, logsRoot: root, job: () => ({ attainment: "unverified", basis: "reading-unknown" }) }, async () => {
        throw Object.assign(new Error("boom"), { code: "E_X" });
      }),
    ).rejects.toThrow("boom");
    expect(records().map((r) => r.job)).toEqual(expect.arrayContaining([{ attainment: "not-achieved", basis: "done-check" }, { attainment: "unverified", basis: "reading-unknown" }]));
  });

  it("copies code tokens only: a verdict with anything else is left out", async () => {
    await withJourneyRunRecord({ channel: "mcp", id: "publish", params: { secret: "hunter2" }, logsRoot: root }, async () => ({ outcome: "ok", job: { attainment: "achieved", basis: "hunter2", note: "page text" } }));
    expect(records()[0]).not.toHaveProperty("job");
    expect(JSON.stringify(records())).not.toContain("hunter2");
  });
});

describe("latestJourneyRun", () => {
  async function run(job: { attainment: string; basis: string } | undefined, j: Journey = journey()): Promise<void> {
    await withJourneyRunRecord({ channel: "cli", id: "publish", params: {}, logsRoot: root }, async (recorder) => {
      recorder.noteJourney(j);
      return { outcome: "ok", ...(job === undefined ? {} : { job }) };
    });
    await clock.advanceBy(1000);
  }

  it("is the newest record of the Journey; none is undefined", async () => {
    expect(latestJourneyRun(root, "publish", journey())).toBeUndefined();
    await run({ attainment: "not-achieved", basis: "done-check" });
    await run({ attainment: "achieved", basis: "done-check" });
    expect(latestJourneyRun(root, "publish", journey())).toMatchObject({ job: { attainment: "achieved" }, current: true, outcome: "ok" });
  });

  it("a reworded Journey keeps its run (executable identity); a changed step does not", async () => {
    await run({ attainment: "achieved", basis: "done-check" });
    expect(latestJourneyRun(root, "publish", journey("Publish a post"))?.current).toBe(true);
    const changed = journey();
    changed.recording.pages[0]!.steps.push({ step: { kind: "click", target: { testId: "again" }, expect: { kind: "textIncludes", target: { testId: "status" }, text: "Live" } } });
    expect(latestJourneyRun(root, "publish", changed)?.current).toBe(false);
    expect(buildJourneyReview(changed, { latestRun: latestJourneyRun(root, "publish", changed) ?? null }).job).toMatchObject({ attainment: "unverified", basis: "earlier-version" });
  });

  it("a record from before 0.30.0 (no job, no proofHash) reads unverified, not-recorded", () => {
    const j = journey();
    mkdirSync(join(root, "2026-10-01"), { recursive: true });
    const old = { kind: "journey-run", version: 1, channel: "cli", journey: { id: "publish", hash: buildJourneyReview(j).contentHash }, outcome: "ok", writes: { count: 0, refused: 0, shapes: [] }, startedAt: "2026-10-01T00:00:00.000Z", endedAt: "2026-10-01T00:00:01.000Z" };
    writeFileSync(join(root, "2026-10-01", "journey-run-2026-10-01T00-00-00-000Z-0000.json"), JSON.stringify(old));
    const latest = latestJourneyRun(root, "publish", j) ?? null;
    expect(latest).toMatchObject({ current: true });
    expect(buildJourneyReview(j, { latestRun: latest }).job).toEqual({ attainment: "unverified", basis: "not-recorded", doneCheckPolicy: "require", at: "2026-10-01T00:00:01.000Z", outcome: "ok" });
    expect(buildJourneyReview(j, { latestRun: null, doneCheckPolicy: "advisory" }).job).toEqual({ attainment: "unverified", basis: "no-run", doneCheckPolicy: "advisory" });
  });

  // M4: `journey review` uses readiness's rule: `achieved` counts only from a record whose own outcome is ok.
  it("a failed run's achieved done check reads unverified, run-not-passed, in the review (as in readiness)", async () => {
    const j = journey();
    await withJourneyRunRecord({ channel: "cli", id: "publish", params: {}, logsRoot: root }, async (recorder) => {
      recorder.noteJourney(j);
      return { outcome: "quarantined", job: { attainment: "achieved", basis: "done-check" } };
    });
    const latest = latestJourneyRun(root, "publish", j) ?? null;
    expect(latest).toMatchObject({ outcome: "quarantined", job: { attainment: "achieved" }, current: true });
    expect(buildJourneyReview(j, { latestRun: latest }).job).toMatchObject({ attainment: "unverified", basis: "run-not-passed", outcome: "quarantined" });
    await clock.advanceBy(1000);
    await run({ attainment: "achieved", basis: "done-check" }, j);
    expect(buildJourneyReview(j, { latestRun: latestJourneyRun(root, "publish", j) ?? null }).job).toMatchObject({ attainment: "achieved", basis: "done-check", outcome: "ok" });
  });

  it("the logs a Journeys dir's runs record into sit beside it", () => {
    expect(journeyRunLogsRoot(join(root, ".jevitate", "journeys"))).toBe(join(root, ".jevitate", "logs"));
  });
});
