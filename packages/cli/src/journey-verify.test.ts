import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FakeClock, clock, installClock, resetClock } from "@jevitate/domain";
import { CastActor } from "@jevitate/screenplay";
import { FsJourneyStore, type Journey } from "@jevitate/journey";
import { verifyJourneyMutations } from "./journey-verify.js";
import type { runJourneyProgrammatically } from "./journey-api.js";

const noClaim = { kind: "urlIncludes", text: "" } as const;
function fixture(): Journey {
  return {
    metadata: { id: "horizon", name: "Horizon", promoted: false, params: [], createdAtIso: "2026-11-06T00:00:00Z", endState: [{ kind: "responseStatus", method: "POST", pathGlob: "/sync", status: { class: 2 } }] },
    recording: { version: "1", site: "http://fixture.test", pages: [{ url: "/", steps: [{ step: { kind: "click", target: { testId: "send" }, expect: noClaim }, delta: { verdict: "no-change", why: "captured", changes: [], requests: ["POST /sync → 200"], overheadMs: 0 } }] }] },
  };
}
const actor = CastActor.named("horizon-test");
const finalFailure = { outcome: "quarantined", reason: "missing final response", outcomeFailures: [{ where: "end-state", index: 0, detail: "missing response" }] } as const;
const dirs: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  resetClock();
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});
async function store(j: Journey): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "jev-horizon-"));
  dirs.push(dir);
  await new FsJourneyStore(dir).put(j);
  return dir;
}

describe("final-network observation horizon is qualifying evidence, not a best-effort hint", () => {
  it.each(["missing-failed", "missing-passed", "thrown", "cancelled", "shortened"])("does not admit a skip whose hold is %s", async (mode) => {
    const fake = new FakeClock();
    installClock(fake);
    const sleep = vi.spyOn(clock, "sleep").mockImplementation(async (ms) => {
      if (mode === "thrown" || mode === "cancelled") throw new Error(`${mode}: secret must not escape`);
      if (mode !== "shortened") await fake.advanceBy(ms);
    });
    const j = fixture();
    const dir = await store(j);
    let first = true;
    const run: typeof runJourneyProgrammatically = async (opts, mutation = {}) => {
      if (first) { first = false; await fake.advanceBy(100); return { outcome: "ok", output: null }; }
      if (mutation.blockWritesAtStep !== undefined) return { ...finalFailure, blockedWrites: [] };
      if (!mode.startsWith("missing")) await opts.observer?.afterStep?.({ actor, index: 0, recorded: j.recording.pages[0]!.steps[0]!, outcome: "done" });
      return mode === "missing-passed" ? { outcome: "ok", output: null } : finalFailure;
    };
    const report = await verifyJourneyMutations({ dir, id: j.metadata.id }, run);
    expect(report.mutations.find((m) => m.id === "skip:1")).toMatchObject({ outcome: "error", failedSites: [] });
    expect(report.assertions.find((a) => a.site === "end-state:0")?.verdict).not.toBe("sensitive");
    expect(report.verdict).toBe("inconclusive");
    expect(JSON.stringify(report)).not.toContain("secret must not escape");
    expect(sleep).toHaveBeenCalledTimes(mode.startsWith("missing") ? 0 : 1);
    const reason = report.mutations.find((m) => m.id === "skip:1")?.reason;
    expect(reason).toContain(`cause=${mode.startsWith("missing") ? "missing-observer" : mode === "shortened" ? "clock-no-progress" : "sleep-failed"}`);
    expect(reason).toContain(`eligible=${!mode.startsWith("missing")}`);
  });

  it.each([{ skipIndex: false, baselineMs: 100 }, { skipIndex: true, baselineMs: 100 }, { skipIndex: false, baselineMs: 100.5 }])("holds a skipped last step before final checks (skipIndex: $skipIndex, horizon: $baselineMs)", async ({ skipIndex, baselineMs }) => {
    const fake = new FakeClock();
    installClock(fake);
    vi.spyOn(clock, "sleep").mockImplementation((ms) => fake.advanceBy(Math.floor(ms)));
    const j = fixture();
    const dir = await store(j);
    let first = true;
    if (skipIndex) j.recording.pages[0]!.steps[0]!.step = { kind: "waitFor", target: { testId: "ready" }, state: "visible" };
    // The ordinary click skip becomes an assert; an expectation-less step uses skipStep.
    await new FsJourneyStore(dir).put(j);
    let skippedLast = false;
    let blocker = false;
    const run: typeof runJourneyProgrammatically = async (opts, mutation = {}) => {
      if (first) { first = false; await fake.advanceBy(baselineMs); return { outcome: "ok", output: null }; }
      expect(mutation.structuredFailures).toBe(true);
      if (mutation.blockWritesAtStep !== undefined) { blocker = true; expect(mutation.blockWritesAtStep).toBe(0); return { ...finalFailure, blockedWrites: [{ method: "POST", path: "/sync" }] }; }
      skippedLast = skipIndex ? mutation.skipStep?.(0) === true : mutation.mutateJourney?.(j).recording.pages[0]!.steps[0]!.step.kind === "assert";
      const started = clock.monotonicMs();
      await opts.observer?.afterStep?.({ actor, index: 0, recorded: j.recording.pages[0]!.steps[0]!, outcome: "done" });
      expect(clock.monotonicMs() - started).toBeGreaterThanOrEqual(baselineMs);
      return finalFailure;
    };
    const report = await verifyJourneyMutations({ dir, id: j.metadata.id }, run);
    expect(skippedLast && blocker).toBe(true);
    expect(report.mutations.find((m) => m.id === "skip:1")?.outcome).toBe("failed");
    expect(report.assertions.find((a) => a.site === "end-state:0")).toMatchObject({ verdict: "sensitive", provedBy: "skip:1" });
  });

  it("continues an early wake to the same actual deadline before final checks", async () => {
    const fake = new FakeClock();
    installClock(fake);
    const sleeps: number[] = [];
    vi.spyOn(clock, "sleep").mockImplementation(async (ms) => {
      sleeps.push(ms);
      await fake.advanceBy(sleeps.length === 1 ? 100.25 : ms);
    });
    const j = fixture();
    const dir = await store(j);
    let first = true;
    let finalChecks = 0;
    const run: typeof runJourneyProgrammatically = async (opts, mutation = {}) => {
      if (first) { first = false; await fake.advanceBy(100.75); return { outcome: "ok", output: null }; }
      if (mutation.blockWritesAtStep !== undefined) return { ...finalFailure, blockedWrites: [] };
      const started = clock.monotonicMs();
      await opts.observer?.afterStep?.({ actor, index: 0, recorded: j.recording.pages[0]!.steps[0]!, outcome: "done" });
      expect(clock.monotonicMs() - started).toBeGreaterThanOrEqual(100.75);
      finalChecks++;
      return finalFailure;
    };
    const report = await verifyJourneyMutations({ dir, id: j.metadata.id }, run);
    expect(report.mutations.find((m) => m.id === "skip:1")?.outcome).toBe("failed");
    expect(finalChecks).toBe(1);
    expect(sleeps).toEqual([101, 1]);
    expect(report.assertions.find((a) => a.site === "end-state:0")).toMatchObject({ verdict: "sensitive", provedBy: "skip:1" });
  });

  it.each(["several", "already-elapsed", "late-write"])("preserves the continuous deadline with %s", async (mode) => {
    installClock(new FakeClock());
    let now = 0;
    vi.spyOn(clock, "monotonicMs").mockImplementation(() => now);
    let sleeps = 0;
    let lateWrite = false;
    vi.spyOn(clock, "sleep").mockImplementation(async (ms) => {
      sleeps++;
      now += sleeps <= 2 ? 40 : ms;
      if (mode === "late-write" && sleeps === 3) lateWrite = true;
    });
    const j = fixture();
    const dir = await store(j);
    let first = true;
    const run: typeof runJourneyProgrammatically = async (opts, mutation = {}) => {
      if (first) { first = false; now += 100.75; return { outcome: "ok", output: null }; }
      if (mutation.blockWritesAtStep !== undefined) return { ...finalFailure, blockedWrites: [] };
      const started = now;
      if (mode === "already-elapsed") now += 100.75;
      await opts.observer?.afterStep?.({ actor, index: 0, recorded: j.recording.pages[0]!.steps[0]!, outcome: "done" });
      expect(now - started).toBeGreaterThanOrEqual(100.75);
      return lateWrite ? { outcome: "ok", output: null } : finalFailure;
    };
    const report = await verifyJourneyMutations({ dir, id: j.metadata.id }, run);
    expect(sleeps).toBe(mode === "already-elapsed" ? 0 : 3);
    expect(report.mutations.find((m) => m.id === "skip:1")?.outcome).toBe(mode === "late-write" ? "passed" : "failed");
    expect(report.assertions.find((a) => a.site === "end-state:0")?.verdict).toBe(mode === "late-write" ? "insensitive" : "sensitive");
  });

  it.each([
    { mode: "zero", cause: "clock-no-progress", calls: 1 },
    { mode: "backwards", cause: "clock-invalid", calls: 1 },
    { mode: "nan", cause: "clock-invalid", calls: 1 },
    { mode: "infinity", cause: "clock-invalid", calls: 1 },
    { mode: "wake-limit", cause: "wake-limit", calls: 8 },
    { mode: "wrong-index", cause: "missing-observer", calls: 0 },
    { mode: "wrong-outcome", cause: "missing-observer", calls: 0 },
  ])("fails closed with bounded safe diagnostics for $mode", async ({ mode, cause, calls }) => {
    installClock(new FakeClock());
    let now = 0;
    vi.spyOn(clock, "monotonicMs").mockImplementation(() => now);
    const sleep = vi.spyOn(clock, "sleep").mockImplementation(async () => {
      if (mode === "backwards") now--;
      if (mode === "nan") now = Number.NaN;
      if (mode === "infinity") now = Number.POSITIVE_INFINITY;
      if (mode === "wake-limit") now++;
    });
    const j = fixture();
    const dir = await store(j);
    let first = true;
    const run: typeof runJourneyProgrammatically = async (opts, mutation = {}) => {
      if (first) { first = false; now += 100; return { outcome: "ok", output: null }; }
      if (mutation.blockWritesAtStep !== undefined) return { ...finalFailure, blockedWrites: [] };
      await opts.observer?.afterStep?.({ actor, index: mode === "wrong-index" ? 1 : 0, recorded: j.recording.pages[0]!.steps[0]!, outcome: mode === "wrong-outcome" ? "failed" : "done" });
      return finalFailure;
    };
    const report = await verifyJourneyMutations({ dir, id: j.metadata.id }, run);
    const skip = report.mutations.find((m) => m.id === "skip:1");
    expect(skip).toMatchObject({ outcome: "error", failedSites: [] });
    expect(skip?.reason).toContain(`cause=${cause}`);
    expect(skip?.reason).toContain(`sleeps=${calls}`);
    expect(skip?.reason).toContain("requiredMs=100");
    expect(skip?.reason).not.toMatch(/NaN|Infinity/);
    expect(report.assertions.find((a) => a.site === "end-state:0")?.verdict).not.toBe("sensitive");
    expect(sleep).toHaveBeenCalledTimes(calls);
  });

  it("does not require a successful skip for an otherwise sound block witness", async () => {
    const fake = new FakeClock();
    installClock(fake);
    const j = fixture();
    const dir = await store(j);
    let first = true;
    const run: typeof runJourneyProgrammatically = async (_opts, mutation = {}) => {
      if (first) { first = false; await fake.advanceBy(100); return { outcome: "ok", output: null }; }
      return { ...finalFailure, ...(mutation.blockWritesAtStep === undefined ? {} : { blockedWrites: [{ method: "POST", path: "/sync" }] }) };
    };
    const report = await verifyJourneyMutations({ dir, id: j.metadata.id }, run);
    expect(report.mutations.find((m) => m.id === "skip:1")?.outcome).toBe("error");
    expect(report.assertions.find((a) => a.site === "end-state:0")).toMatchObject({ verdict: "sensitive", provedBy: "block-write:1" });
    expect(report.verdict).toBe("proven");
  });

  it.each(["action failed", "run budget exhausted", "heal-exhausted"])("preserves an earlier %s as a cascade without inventing a hold completion", async (reason) => {
    const fake = new FakeClock();
    installClock(fake);
    const sleep = vi.spyOn(clock, "sleep").mockImplementation((ms) => fake.advanceBy(ms));
    const j = fixture();
    const dir = await store(j);
    let first = true;
    const run: typeof runJourneyProgrammatically = async (_opts, mutation = {}) => {
      if (first) { first = false; await fake.advanceBy(100); return { outcome: "ok", output: null }; }
      if (reason === "heal-exhausted") return { outcome: "heal-exhausted", reason, at: 0 };
      return { outcome: "quarantined", reason, at: 0, failurePhase: "action", ...(mutation.blockWritesAtStep === undefined ? {} : { blockedWrites: [] }) };
    };
    const report = await verifyJourneyMutations({ dir, id: j.metadata.id }, run);
    expect(report.mutations.find((m) => m.id === "skip:1")).toMatchObject({ outcome: "failed", failedSites: [{ where: "step", step: 1, postcondition: false }] });
    expect(report.assertions.find((a) => a.site === "end-state:0")?.verdict).toBe("cascade");
    expect(report.verdict).toBe("inconclusive");
    expect(sleep).not.toHaveBeenCalled();
  });

  it.each([false, true])("requires matching targeted/control horizons (missing control hook: %s)", async (missingControl) => {
    const fake = new FakeClock();
    installClock(fake);
    vi.spyOn(clock, "sleep").mockImplementation((ms) => fake.advanceBy(ms));
    const j = fixture();
    j.recording.pages[0]!.steps[0]!.step = { kind: "click", target: { testId: "send" }, expect: { kind: "textIncludes", target: { testId: "status" }, text: "Sent" } };
    j.recording.pages[0]!.steps.push({ step: { kind: "assert", check: { kind: "textIncludes", target: { testId: "guard" }, text: "Sent" } } });
    j.metadata.mutationPairs = [{ check: "step:2", mustFailWhen: "skip:1" }];
    const dir = await store(j);
    let first = true;
    let skipRuns = 0;
    const held: number[] = [];
    const run: typeof runJourneyProgrammatically = async (opts, mutation = {}) => {
      if (first) { first = false; await fake.advanceBy(100); return { outcome: "ok", output: null }; }
      if (mutation.blockWritesAtStep !== undefined) return { ...finalFailure, blockedWrites: [] };
      skipRuns++;
      if (skipRuns <= 2) return { outcome: "quarantined", reason: "postcondition", at: skipRuns - 1, failurePhase: "postcondition" };
      const copy = mutation.mutateJourney?.(j);
      expect(copy?.recording.pages[0]!.steps[1]!.step).toEqual({ kind: "assert", check: noClaim });
      expect(mutation.skipStep?.(0)).toBe(skipRuns === 3 ? true : undefined);
      const started = clock.monotonicMs();
      if (!(missingControl && skipRuns === 4)) {
        await opts.observer?.afterStep?.({ actor, index: 1, recorded: j.recording.pages[0]!.steps[1]!, outcome: "done" });
        held.push(clock.monotonicMs() - started);
      }
      return skipRuns === 3 ? finalFailure : { outcome: "ok", output: null };
    };
    const report = await verifyJourneyMutations({ dir, id: j.metadata.id }, run);
    expect(held).toEqual(missingControl ? [100] : [100, 100]);
    const proof = report.mutations.find((m) => m.id === "skip:1")?.targeted?.find((t) => t.site === "end-state:0");
    expect(proof).toMatchObject({ relaxedSites: ["step:2"], outcome: "failed", control: missingControl ? "error" : "passed" });
    if (missingControl) {
      expect(proof?.refused).toContain("unmutated control");
      expect(report.assertions.find((a) => a.site === "end-state:0")?.verdict).toBe("cascade");
    }
  });
});
