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

async function beforeSteps(opts: Parameters<typeof runJourneyProgrammatically>[0], j: Journey): Promise<void> {
  let index = 0;
  for (const page of j.recording.pages) for (const recorded of page.steps) await opts.observer?.beforeStep?.({ actor, index: index++, recorded });
}
async function finishBaseline(opts: Parameters<typeof runJourneyProgrammatically>[0], mutation: NonNullable<Parameters<typeof runJourneyProgrammatically>[1]>, j: Journey, settle?: () => unknown): Promise<void> {
  const flat = j.recording.pages.flatMap((page) => page.steps);
  await opts.observer?.afterStep?.({ actor, index: flat.length - 1, recorded: flat.at(-1)!, outcome: "done" });
  await settle?.();
  await closeCapture(mutation);
}

/**
 * The 0.30.0 line also paces each replay (#785: held past the base's step time plus a margin) outside
 * the final capture. These cases pin the final-network horizon itself, so only a sleep inside the
 * capture-close boundary is the horizon's and is counted; a pacer sleep runs `elapse` (by default no
 * time). Where a case exercises the horizon's own sleeps, its base settles for `SETTLE_MS` before the
 * capture closes, beyond the pacer's last-step hold, and its replays' pacer sleeps elapse fake time.
 * An error that opened no browser is retried once (#778), so such a case observes two attempts.
 */
const SETTLE_MS = 5_000;
let inClose = false;
async function closeCapture(mutation: { beforeFinalNetworkCaptureClose?: () => Promise<void> }): Promise<void> {
  inClose = true;
  try { await mutation.beforeFinalNetworkCaptureClose?.(); } finally { inClose = false; }
}
function horizonSleep(impl: (ms: number) => Promise<void> | void, elapse: (ms: number) => unknown = () => undefined): number[] {
  const calls: number[] = [];
  vi.spyOn(clock, "sleep").mockImplementation(async (ms) => {
    if (!inClose) { await elapse(ms); return; }
    calls.push(ms);
    await impl(ms);
  });
  return calls;
}

/** The 0.30.0 proof also replays the Journey as recorded (independence, controls): those pass here. */
function onLine(run: typeof runJourneyProgrammatically): typeof runJourneyProgrammatically {
  let calls = 0;
  return async (opts, mutation = {}) => {
    const asRecorded = mutation.mutateJourney === undefined && mutation.skipStep === undefined && mutation.blockWritesAtStep === undefined && mutation.selectAlternativeAtStep === undefined;
    if (calls++ > 0 && asRecorded) return { outcome: "ok", output: null };
    return run(opts, mutation);
  };
}

describe("final-network observation horizon is qualifying evidence, not a best-effort hint", () => {
  it.each(["missing-failed", "missing-passed", "thrown", "cancelled", "shortened"])("does not admit a skip whose hold is %s", async (mode) => {
    const fake = new FakeClock();
    installClock(fake);
    const sleep = horizonSleep(async (ms) => {
      if (mode === "thrown" || mode === "cancelled") throw new Error(`${mode}: secret must not escape`);
      if (mode !== "shortened") await fake.advanceBy(ms);
    }, (ms) => fake.advanceBy(ms));
    const j = fixture();
    const dir = await store(j);
    let first = true;
    const run: typeof runJourneyProgrammatically = async (opts, mutation = {}) => {
      if (first) { first = false; await beforeSteps(opts, j); await fake.advanceBy(100); await finishBaseline(opts, mutation, j, () => fake.advanceBy(SETTLE_MS)); return { outcome: "ok", output: null }; }
      if (mutation.blockWritesAtStep !== undefined) return { ...finalFailure, blockedWrites: [] };
      await beforeSteps(opts, j);
      if (!mode.startsWith("missing")) await opts.observer?.afterStep?.({ actor, index: 0, recorded: j.recording.pages[0]!.steps[0]!, outcome: "done" });
      await closeCapture(mutation);
      return mode === "missing-passed" ? { outcome: "ok", output: null } : finalFailure;
    };
    const report = await verifyJourneyMutations({ dir, id: j.metadata.id }, onLine(run));
    expect(report.mutations.find((m) => m.id === "skip:1")).toMatchObject({ outcome: "error", failedSites: [] });
    expect(report.assertions.find((a) => a.site === "end-state:0")?.verdict).not.toBe("sensitive");
    expect(report.verdict).toBe("inconclusive");
    expect(JSON.stringify(report)).not.toContain("secret must not escape");
    expect(sleep).toHaveLength(mode.startsWith("missing") ? 0 : 2);
    const reason = report.mutations.find((m) => m.id === "skip:1")?.reason;
    expect(reason).toContain(`cause=${mode.startsWith("missing") ? "missing-observer" : mode === "shortened" ? "clock-no-progress" : "sleep-failed"}`);
    expect(reason).toContain(`eligible=${!mode.startsWith("missing")}`);
  });

  it.each([{ skipIndex: false, baselineMs: 100 }, { skipIndex: true, baselineMs: 100 }, { skipIndex: false, baselineMs: 100.5 }])("holds a skipped last step before final checks (skipIndex: $skipIndex, horizon: $baselineMs)", async ({ skipIndex, baselineMs }) => {
    const fake = new FakeClock();
    installClock(fake);
    horizonSleep((ms) => fake.advanceBy(Math.floor(ms)), (ms) => fake.advanceBy(ms));
    const j = fixture();
    const dir = await store(j);
    let first = true;
    if (skipIndex) j.recording.pages[0]!.steps[0]!.step = { kind: "waitFor", target: { testId: "ready" }, state: "visible" };
    // The ordinary click skip becomes an assert; an expectation-less step uses skipStep.
    await new FsJourneyStore(dir).put(j);
    let skippedLast = false;
    let blocker = false;
    const run: typeof runJourneyProgrammatically = async (opts, mutation = {}) => {
      if (first) { first = false; await beforeSteps(opts, j); await fake.advanceBy(baselineMs); await finishBaseline(opts, mutation, j); return { outcome: "ok", output: null }; }
      expect(mutation.structuredFailures).toBe(true);
      if (mutation.blockWritesAtStep !== undefined) { blocker = true; expect(mutation.blockWritesAtStep).toBe(0); return { ...finalFailure, blockedWrites: [{ method: "POST", path: "/sync" }] }; }
      skippedLast = skipIndex ? mutation.skipStep?.(0) === true : mutation.mutateJourney?.(j).recording.pages[0]!.steps[0]!.step.kind === "assert";
      const started = clock.monotonicMs();
      await beforeSteps(opts, j);
      await opts.observer?.afterStep?.({ actor, index: 0, recorded: j.recording.pages[0]!.steps[0]!, outcome: "done" });
      await closeCapture(mutation);
      expect(clock.monotonicMs() - started).toBeGreaterThanOrEqual(baselineMs);
      return finalFailure;
    };
    const report = await verifyJourneyMutations({ dir, id: j.metadata.id }, onLine(run));
    expect(skippedLast && blocker).toBe(true);
    expect(report.mutations.find((m) => m.id === "skip:1")?.outcome).toBe("failed");
    expect(report.assertions.find((a) => a.site === "end-state:0")).toMatchObject({ verdict: "sensitive", provedBy: "skip:1" });
  });

  it("continues an early wake to the same actual deadline before final checks", async () => {
    const fake = new FakeClock();
    installClock(fake);
    const sleeps: number[] = [];
    horizonSleep(async (ms) => {
      sleeps.push(ms);
      await fake.advanceBy(sleeps.length === 1 ? 100.25 : ms);
    }, (ms) => fake.advanceBy(ms));
    const j = fixture();
    const dir = await store(j);
    let first = true;
    let finalChecks = 0;
    const run: typeof runJourneyProgrammatically = async (opts, mutation = {}) => {
      if (first) { first = false; await beforeSteps(opts, j); await fake.advanceBy(100.75); await finishBaseline(opts, mutation, j, () => fake.advanceBy(SETTLE_MS)); return { outcome: "ok", output: null }; }
      if (mutation.blockWritesAtStep !== undefined) return { ...finalFailure, blockedWrites: [] };
      const started = clock.monotonicMs();
      await beforeSteps(opts, j);
      await opts.observer?.afterStep?.({ actor, index: 0, recorded: j.recording.pages[0]!.steps[0]!, outcome: "done" });
      await closeCapture(mutation);
      expect(clock.monotonicMs() - started).toBeGreaterThanOrEqual(100.75 + SETTLE_MS);
      finalChecks++;
      return finalFailure;
    };
    const report = await verifyJourneyMutations({ dir, id: j.metadata.id }, onLine(run));
    expect(report.mutations.find((m) => m.id === "skip:1")?.outcome).toBe("failed");
    expect(finalChecks).toBe(1);
    // The early wake (100.25 of the first sleep) is continued to the same deadline: the second sleep is the rest.
    expect(sleeps).toEqual([sleeps[0], sleeps[0]! - 100]);
    expect(report.assertions.find((a) => a.site === "end-state:0")).toMatchObject({ verdict: "sensitive", provedBy: "skip:1" });
  });

  it.each(["several", "already-elapsed", "late-write"])("preserves the continuous deadline with %s", async (mode) => {
    installClock(new FakeClock());
    let now = 0;
    vi.spyOn(clock, "monotonicMs").mockImplementation(() => now);
    let sleeps = 0;
    let lateWrite = false;
    horizonSleep(async (ms) => {
      sleeps++;
      now += sleeps <= 2 ? 40 : ms;
      if (mode === "late-write" && sleeps === 3) lateWrite = true;
    }, (ms) => { now += ms; });
    const j = fixture();
    const dir = await store(j);
    let first = true;
    const run: typeof runJourneyProgrammatically = async (opts, mutation = {}) => {
      if (first) { first = false; await beforeSteps(opts, j); now += 100.75; await finishBaseline(opts, mutation, j, () => { now += SETTLE_MS; }); return { outcome: "ok", output: null }; }
      if (mutation.blockWritesAtStep !== undefined) return { ...finalFailure, blockedWrites: [] };
      await beforeSteps(opts, j);
      const started = now;
      if (mode === "already-elapsed") now += 100.75 + SETTLE_MS;
      await opts.observer?.afterStep?.({ actor, index: 0, recorded: j.recording.pages[0]!.steps[0]!, outcome: "done" });
      await closeCapture(mutation);
      expect(now - started).toBeGreaterThanOrEqual(100.75 + SETTLE_MS);
      return lateWrite ? { outcome: "ok", output: null } : finalFailure;
    };
    const report = await verifyJourneyMutations({ dir, id: j.metadata.id }, onLine(run));
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
    const sleep = horizonSleep(async (ms) => {
      if (mode === "backwards") now--;
      if (mode === "nan") now = Number.NaN;
      if (mode === "infinity") now = Number.POSITIVE_INFINITY;
      if (mode === "wake-limit") now++;
    }, (ms) => { now += ms; });
    const j = fixture();
    const dir = await store(j);
    let first = true;
    const run: typeof runJourneyProgrammatically = async (opts, mutation = {}) => {
      if (first) { first = false; await beforeSteps(opts, j); now += 100; await finishBaseline(opts, mutation, j, () => { now += SETTLE_MS; }); return { outcome: "ok", output: null }; }
      if (mutation.blockWritesAtStep !== undefined) return { ...finalFailure, blockedWrites: [] };
      // The #778 retry of an errored attempt starts from a readable clock again.
      if (!Number.isFinite(now)) now = 1_000_000;
      await beforeSteps(opts, j);
      await opts.observer?.afterStep?.({ actor, index: mode === "wrong-index" ? 1 : 0, recorded: j.recording.pages[0]!.steps[0]!, outcome: mode === "wrong-outcome" ? "failed" : "done" });
      await closeCapture(mutation);
      return finalFailure;
    };
    const report = await verifyJourneyMutations({ dir, id: j.metadata.id }, onLine(run));
    const skip = report.mutations.find((m) => m.id === "skip:1");
    expect(skip).toMatchObject({ outcome: "error", failedSites: [] });
    // Both attempts (#778) fail closed the same way.
    for (const reason of [skip?.retries?.[0]?.reason, skip?.reason]) {
      expect(reason).toContain(`cause=${cause}`);
      expect(reason).toContain(`sleeps=${calls}`);
      expect(reason).toContain(`requiredMs=${100 + SETTLE_MS}`);
      expect(reason).not.toMatch(/NaN|Infinity/);
    }
    expect(report.assertions.find((a) => a.site === "end-state:0")?.verdict).not.toBe("sensitive");
    expect(sleep).toHaveLength(2 * calls);
  });

  it("excludes pre-page admission and preserves each corresponding prefix opportunity through capture close", async () => {
    const fake = new FakeClock(); installClock(fake);
    horizonSleep((ms) => fake.advanceBy(ms));
    const j = fixture();
    const a = j.recording.pages[0]!.steps[0]!;
    j.recording.pages[0]!.steps.unshift({ step: { kind: "navigate", url: "/", expect: noClaim } });
    const dir = await store(j);
    let baseline = true;
    let sent = false;
    const run: typeof runJourneyProgrammatically = async (opts, mutation = {}) => {
      if (mutation.blockWritesAtStep !== undefined) return { ...finalFailure, blockedWrites: [] };
      if (!baseline) await fake.advanceBy(7_000);
      await opts.observer?.beforeStep?.({ actor, index: 0, recorded: j.recording.pages[0]!.steps[0]! });
      await opts.observer?.beforeStep?.({ actor, index: 1, recorded: a });
      const began = clock.monotonicMs();
      if (baseline) await fake.advanceBy(6_500);
      await opts.observer?.afterStep?.({ actor, index: 1, recorded: a, outcome: "done" });
      if (!baseline) await fake.advanceBy(500); // native-sized quiet control, not served evidence
      await closeCapture(mutation);
      if (baseline) { baseline = false; return { outcome: "ok", output: null }; }
      sent = clock.monotonicMs() - began >= 6_000;
      return sent ? { outcome: "ok", output: null } : finalFailure;
    };
    const report = await verifyJourneyMutations({ dir, id: j.metadata.id }, onLine(run));
    expect(report.mutations.find((m) => m.id === "skip:2")?.outcome).toBe("passed");
    expect(sent).toBe(true);
    expect(report.assertions.find((a) => a.site === "end-state:0")?.verdict).toBe("insensitive");
  });

  it.each(["mutation-admission", "baseline-setup-cleanup", "slow-navigation", "accelerated-prefix", "multi-page"])("aligns each ordered prefix through actual capture close: %s", async (mode) => {
    const fake = new FakeClock(); installClock(fake);
    horizonSleep((ms) => fake.advanceBy(ms));
    const j = fixture();
    const write = j.recording.pages[0]!.steps[0]!;
    const nav = { step: { kind: "navigate", url: "/", expect: noClaim } } as const;
    const a = { step: { kind: "click", target: { testId: "a" }, expect: noClaim } } as const;
    j.recording.pages = mode === "multi-page" ? [{ url: "/", steps: [nav] }, { url: "/next", steps: [a, write] }] : [{ url: "/", steps: [nav, a, write] }];
    const flat = j.recording.pages.flatMap((page) => page.steps);
    const dir = await store(j);
    let first = true;
    const baselineAnchors: number[] = [];
    let baselineClose = 0;
    const run: typeof runJourneyProgrammatically = async (opts, mutation = {}) => {
      if (mutation.blockWritesAtStep !== undefined) return { ...finalFailure, blockedWrites: [] };
      const isBase = first; first = false;
      if (isBase && mode === "baseline-setup-cleanup") await fake.advanceBy(10_000);
      if (!isBase && mode === "mutation-admission") await fake.advanceBy(7_000);
      const anchors: number[] = [];
      for (const [index, recorded] of flat.entries()) {
        if (index === 1) await fake.advanceBy(isBase ? 40 : mode === "slow-navigation" ? 200 : 0);
        if (index === 2 && isBase) await fake.advanceBy(40);
        anchors.push(clock.monotonicMs());
        await opts.observer?.beforeStep?.({ actor, index, recorded });
      }
      await opts.observer?.afterStep?.({ actor, index: 2, recorded: write, outcome: "done" });
      await fake.advanceBy(isBase ? 60 : 10); // baseline settle/judgment opportunity precedes close
      await closeCapture(mutation);
      if (isBase) {
        baselineAnchors.push(...anchors); baselineClose = clock.monotonicMs();
        if (mode === "baseline-setup-cleanup") await fake.advanceBy(10_000);
        return { outcome: "ok", output: null };
      }
      for (let index = 0; index <= 2; index++) expect(clock.monotonicMs() - anchors[index]!).toBeGreaterThanOrEqual(baselineClose - baselineAnchors[index]!);
      return clock.monotonicMs() - anchors[1]! >= 100 ? { outcome: "ok", output: null } : finalFailure;
    };
    const report = await verifyJourneyMutations({ dir, id: j.metadata.id }, onLine(run));
    expect(report.mutations.find((m) => m.id === "skip:3")?.outcome).toBe("passed");
    expect(report.assertions.find((a) => a.site === "end-state:0")?.verdict).toBe("insensitive");
  });

  it.each(["missing-baseline-close", "missing-baseline-prefix", "missing-close", "missing-prefix", "duplicate", "reordered", "failed-final", "duplicate-close", "duplicate-baseline-close", "late-prefix", "late-failed-final", "negative-baseline"])("refuses unmatched phase evidence: %s", async (mode) => {
    const fake = new FakeClock(); installClock(fake);
    if (mode === "negative-baseline") vi.spyOn(clock, "monotonicMs").mockImplementation(() => fake.monotonicMs() - 1_000);
    horizonSleep((ms) => fake.advanceBy(ms));
    const j = fixture(); j.recording.pages[0]!.steps.unshift({ step: { kind: "navigate", url: "/", expect: noClaim } });
    const flat = j.recording.pages[0]!.steps;
    const dir = await store(j);
    let first = true;
    const run: typeof runJourneyProgrammatically = async (opts, mutation = {}) => {
      if (mutation.blockWritesAtStep !== undefined) return { ...finalFailure, blockedWrites: [] };
      const isBase = first; first = false;
      const indices = isBase ? (mode === "missing-baseline-prefix" ? [0] : [0, 1]) : mode === "missing-prefix" ? [0] : mode === "duplicate" ? [0, 0, 1] : mode === "reordered" ? [1, 0] : [0, 1];
      for (const index of indices) await opts.observer?.beforeStep?.({ actor, index, recorded: flat[index]! });
      await fake.advanceBy(isBase ? 100 : 10);
      await opts.observer?.afterStep?.({ actor, index: 1, recorded: flat[1]!, outcome: !isBase && mode === "failed-final" ? "failed" : "done" });
      if (!(isBase && mode === "missing-baseline-close") && !(!isBase && mode === "missing-close")) await closeCapture(mutation);
      if ((isBase && mode === "duplicate-baseline-close") || (!isBase && mode === "duplicate-close")) await closeCapture(mutation);
      if (!isBase && mode === "late-prefix") await opts.observer?.beforeStep?.({ actor, index: 0, recorded: flat[0]! });
      if (!isBase && mode === "late-failed-final") await opts.observer?.afterStep?.({ actor, index: 1, recorded: flat[1]!, outcome: "failed" });
      return isBase ? { outcome: "ok", output: null } : finalFailure;
    };
    const report = await verifyJourneyMutations({ dir, id: j.metadata.id }, onLine(run));
    expect(report.mutations.find((m) => m.id === "skip:2")).toMatchObject({ outcome: "error", failedSites: [] });
    expect(report.assertions.find((a) => a.site === "end-state:0")?.verdict).not.toBe("sensitive");
  });

  it.each([{ sample: 350, invalid: true }, { sample: 400, invalid: false }, { sample: 401, invalid: false }])("qualifies the first hold sample against its close entry: $sample", async ({ sample, invalid }) => {
    installClock(new FakeClock());
    let now = 0;
    const samples: number[] = [];
    vi.spyOn(clock, "monotonicMs").mockImplementation(() => samples.shift() ?? now);
    const sleep = horizonSleep(() => undefined, (ms) => { now += ms; });
    const j = fixture();
    const dir = await store(j);
    let first = true;
    const run: typeof runJourneyProgrammatically = async (opts, mutation = {}) => {
      if (first) {
        first = false;
        await beforeSteps(opts, j);
        now = 100;
        await finishBaseline(opts, mutation, j);
        return { outcome: "ok", output: null };
      }
      if (mutation.blockWritesAtStep !== undefined) return { ...finalFailure, blockedWrites: [] };
      now = 200;
      await beforeSteps(opts, j);
      await opts.observer?.afterStep?.({ actor, index: 0, recorded: j.recording.pages[0]!.steps[0]!, outcome: "done" });
      now = 400;
      samples.push(400, sample);
      await closeCapture(mutation);
      return finalFailure;
    };
    const report = await verifyJourneyMutations({ dir, id: j.metadata.id }, onLine(run));
    const skip = report.mutations.find((m) => m.id === "skip:1");
    expect(skip).toMatchObject({ outcome: invalid ? "error" : "failed", failedSites: invalid ? [] : [{ where: "end-state", index: 0 }] });
    expect(samples).toEqual([]);
    expect(sleep).toEqual([]);
    if (invalid) {
      expect(skip?.reason).toContain("cause=clock-invalid");
      expect(report.assertions.find((a) => a.site === "end-state:0")?.verdict).not.toBe("sensitive");
    } else {
      expect(report.assertions.find((a) => a.site === "end-state:0")).toMatchObject({ verdict: "sensitive", provedBy: "skip:1" });
    }
  });

  it("does not require a successful skip for an otherwise sound block witness", async () => {
    const fake = new FakeClock();
    installClock(fake);
    const j = fixture();
    const dir = await store(j);
    let first = true;
    const run: typeof runJourneyProgrammatically = async (opts, mutation = {}) => {
      if (first) { first = false; await beforeSteps(opts, j); await fake.advanceBy(100); await finishBaseline(opts, mutation, j); return { outcome: "ok", output: null }; }
      return { ...finalFailure, ...(mutation.blockWritesAtStep === undefined ? {} : { blockedWrites: [{ method: "POST", path: "/sync" }] }) };
    };
    const report = await verifyJourneyMutations({ dir, id: j.metadata.id }, onLine(run));
    expect(report.mutations.find((m) => m.id === "skip:1")?.outcome).toBe("error");
    expect(report.assertions.find((a) => a.site === "end-state:0")).toMatchObject({ verdict: "sensitive", provedBy: "block-write:1" });
    // The line keeps 0.29.0's rule that an errored mutated replay leaves the proof a gap to retry.
    expect(report).toMatchObject({ verdict: "inconclusive", reason: expect.stringContaining("errored") });
  });

  it.each(["action failed", "run budget exhausted", "heal-exhausted"])("preserves an earlier %s as a cascade without inventing a hold completion", async (reason) => {
    const fake = new FakeClock();
    installClock(fake);
    const sleep = horizonSleep((ms) => fake.advanceBy(ms));
    const j = fixture();
    const dir = await store(j);
    let first = true;
    const run: typeof runJourneyProgrammatically = async (opts, mutation = {}) => {
      if (first) { first = false; await beforeSteps(opts, j); await fake.advanceBy(100); await finishBaseline(opts, mutation, j); return { outcome: "ok", output: null }; }
      if (reason === "heal-exhausted") return { outcome: "heal-exhausted", reason, at: 0 };
      return { outcome: "quarantined", reason, at: 0, failurePhase: "action", ...(mutation.blockWritesAtStep === undefined ? {} : { blockedWrites: [] }) };
    };
    const report = await verifyJourneyMutations({ dir, id: j.metadata.id }, onLine(run));
    expect(report.mutations.find((m) => m.id === "skip:1")).toMatchObject({ outcome: "failed", failedSites: [{ where: "step", step: 1, postcondition: false }] });
    expect(report.assertions.find((a) => a.site === "end-state:0")?.verdict).toBe("cascade");
    expect(report.verdict).toBe("inconclusive");
    expect(sleep).toEqual([]);
  });

  it.each([false, true])("requires matching targeted/control horizons (missing control hook: %s)", async (missingControl) => {
    const fake = new FakeClock();
    installClock(fake);
    horizonSleep((ms) => fake.advanceBy(ms));
    const j = fixture();
    j.recording.pages[0]!.steps[0]!.step = { kind: "click", target: { testId: "send" }, expect: { kind: "textIncludes", target: { testId: "status" }, text: "Sent" } };
    j.recording.pages[0]!.steps.push({ step: { kind: "assert", check: { kind: "textIncludes", target: { testId: "guard" }, text: "Sent" } } });
    j.metadata.mutationPairs = [{ check: "step:2", mustFailWhen: "skip:1" }];
    const dir = await store(j);
    let first = true;
    let skipRuns = 0;
    const held: number[] = [];
    const run: typeof runJourneyProgrammatically = async (opts, mutation = {}) => {
      if (first) { first = false; await beforeSteps(opts, j); await fake.advanceBy(100); await finishBaseline(opts, mutation, j); return { outcome: "ok", output: null }; }
      if (mutation.blockWritesAtStep !== undefined) return { ...finalFailure, blockedWrites: [] };
      skipRuns++;
      if (skipRuns <= 2) return { outcome: "quarantined", reason: "postcondition", at: skipRuns - 1, failurePhase: "postcondition" };
      const copy = mutation.mutateJourney?.(j);
      expect(copy?.recording.pages[0]!.steps[1]!.step).toEqual({ kind: "assert", check: noClaim });
      expect(mutation.skipStep?.(0)).toBe(skipRuns === 3 ? true : undefined);
      const started = clock.monotonicMs();
      // The control lacks the hook on its #778 retry as well.
      if (!(missingControl && skipRuns >= 4)) {
        await beforeSteps(opts, j);
        await opts.observer?.afterStep?.({ actor, index: 1, recorded: j.recording.pages[0]!.steps[1]!, outcome: "done" });
        await closeCapture(mutation);
        held.push(clock.monotonicMs() - started);
      }
      return skipRuns === 3 ? finalFailure : { outcome: "ok", output: null };
    };
    const report = await verifyJourneyMutations({ dir, id: j.metadata.id }, onLine(run));
    expect(held).toEqual(missingControl ? [100] : [100, 100]);
    const proof = report.mutations.find((m) => m.id === "skip:1")?.targeted?.find((t) => t.site === "end-state:0");
    expect(proof).toMatchObject({ relaxedSites: ["step:2"], outcome: "failed", control: missingControl ? "error" : "passed" });
    if (missingControl) {
      expect(proof?.refused).toContain("unmutated control");
      expect(report.assertions.find((a) => a.site === "end-state:0")?.verdict).toBe("cascade");
    }
  });
});
