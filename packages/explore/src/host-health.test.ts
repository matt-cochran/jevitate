import { describe, expect, it } from "vitest";
import type { HostPressure } from "./host-pressure.js";
import {
  HostHealthSampler,
  STARVATION_WINDOW_MS,
  degradedEnvironmentOutcome,
  starvationAttributionFromEnv,
} from "./host-health.js";
import type { TranscriptEntry } from "./transcript.js";

/** #203 — the host-health sampler over a DETERMINISTIC fake host (never the real machine). */

const GB = 1024 ** 3;
const calm: HostPressure = { sample: { memAvailableBytes: 8 * GB, source: "test" }, overThreshold: null, loadPerCore: 0.4 };

/** A fake host whose next samples are scripted; the clock is the test's. */
function fakeHost(opts: { host?: HostPressure; lag?: number; attribute?: boolean } = {}) {
  const state = { host: opts.host ?? calm, lag: opts.lag ?? 3, at: 1_000_000 };
  const sampler = new HostHealthSampler({
    probe: async () => state.host,
    eventLoopLagMs: () => state.lag,
    now: () => state.at,
    intervalMs: 0,
    attribute: opts.attribute ?? true,
    cores: 8,
  });
  return { state, sampler };
}

const entry = (over: Partial<TranscriptEntry> = {}): TranscriptEntry =>
  ({
    step: 0,
    op: "click",
    target: "Go",
    confidence: null,
    chosenBy: "strategy",
    actOk: true,
    url: "http://app.test/",
    signature: "s",
    controlCount: 1,
    ...over,
  }) as TranscriptEntry;

describe("HostHealthSampler — starvation judged from the injected host", () => {
  it("a calm host is never starved, and its summary carries the peaks", async () => {
    const { sampler } = fakeHost();
    expect(await sampler.judge()).toEqual({ host: calm, starved: null });
    sampler.noteStep(entry({ timing: { route: "/", kind: "navigation", navigation: { ttfbMs: 5, domContentLoadedMs: 120, loadMs: 150 }, settled: true, requests: { count: 1, pending: 0, slowest: [], samples: [] } } }));
    expect(sampler.summary()).toEqual({
      samples: 1,
      cores: 8,
      peakLoadPerCore: 0.4,
      minFreeMemoryBytes: 8 * GB,
      peakEventLoopLagMs: 3,
      slowestRenderMs: 120,
      baselineRenderMs: 120,
      steps: 1,
      degradedSteps: 0,
      degraded: false,
      starvation: [],
      attribution: "on",
    });
    expect(sampler.findings()).toEqual([]);
  });

  it("names each starvation signal: the admission threshold, load per core, driver event-loop lag", async () => {
    const over = fakeHost({ host: { sample: null, overThreshold: "memory available=100MiB < 400MiB (source=test)" } });
    expect((await over.sampler.judge()).starved).toBe("host over threshold: memory available=100MiB < 400MiB (source=test)");
    const loaded = fakeHost({ host: { ...calm, loadPerCore: 3.25 } });
    expect((await loaded.sampler.judge()).starved).toBe("load 3.25/core > 2");
    const lagging = fakeHost({ host: { ...calm, loadPerCore: 1.25 }, lag: 900 });
    expect((await lagging.sampler.judge()).starved).toBe("driver event-loop lag 900ms > 500ms at load 1.25/core");
  });

  it("#213: driver lag with idle cores is the driver's own work, never the host (it needs load ≥ 1/core)", async () => {
    // The dogfood reading: 506ms lag at 0.70 load/core — was `degraded` on 67/121 steps.
    const selfInflicted = fakeHost({ host: { ...calm, loadPerCore: 0.7 }, lag: 506 });
    await selfInflicted.sampler.sample();
    for (let i = 0; i < 4; i++) selfInflicted.sampler.noteStep(entry({ step: i }));
    expect((await selfInflicted.sampler.judge()).starved).toBeNull();
    expect(selfInflicted.sampler.summary()).toMatchObject({ degraded: false, degradedSteps: 0, starvation: [], peakEventLoopLagMs: 506 });
    const noLoad = fakeHost({ host: { sample: null, overThreshold: null }, lag: 2_000 });
    expect((await noLoad.sampler.judge()).starved).toBeNull();
  });

  it("#213: the starvation causes are one per kind of signal, not one per reading", async () => {
    const { state, sampler } = fakeHost({ host: { ...calm, loadPerCore: 3.5 } });
    for (const load of [3.5, 3.52, 3.61]) {
      state.host = { ...calm, loadPerCore: load };
      await sampler.sample();
      sampler.noteStep(entry());
      state.at += 1_000;
    }
    expect(sampler.summary().starvation).toEqual(["load 3.50/core > 2"]);
  });

  it("a starved sample explains what follows it for the window, then expires", async () => {
    const { state, sampler } = fakeHost({ host: { ...calm, loadPerCore: 4 } });
    await sampler.sample();
    state.host = calm;
    state.at += STARVATION_WINDOW_MS - 1;
    expect((await sampler.judge()).starved).toBe("load 4/core > 2");
    state.at += 2;
    await sampler.sample(); // the starved one is now older than the window
    // The peak is kept even after the window moved on.
    expect(sampler.starvedNow()).toBeNull();
    expect(sampler.summary().peakLoadPerCore).toBe(4);
  });

  it("a click timeout met while starved is environment-degraded; most steps starved makes the run degraded", async () => {
    const { sampler } = fakeHost({ host: { ...calm, loadPerCore: 5 } });
    await sampler.sample();
    sampler.noteStep(entry({ step: 0 }));
    sampler.noteStep(entry({ step: 1, actOk: false, reason: "locator.click: Timeout 5000ms exceeded." }));
    // An engine refusal (never a real act) is not a click timeout, whatever its text says.
    sampler.noteStep(entry({ step: 2, actOk: false, origin: "engine", reason: "refused (timeout budget)" }));
    expect(sampler.findings()).toEqual([
      { kind: "environment-degraded", finding: "click-timeout", detail: "locator.click: Timeout 5000ms exceeded.", cause: "load 5/core > 2", step: 1, advisory: true },
    ]);
    expect(sampler.degraded).toBe(true);
    expect(sampler.summary()).toMatchObject({ steps: 3, degradedSteps: 3, degraded: true, starvation: ["load 5/core > 2"] });
  });

  it("the same click timeout on a healthy host stays an ordinary failed action", async () => {
    const { sampler } = fakeHost();
    await sampler.sample();
    sampler.noteStep(entry({ actOk: false, reason: "locator.click: Timeout 5000ms exceeded." }));
    expect(sampler.findings()).toEqual([]);
    expect(sampler.degraded).toBe(false);
  });

  it("a run-wide render slowdown against the run's own baseline counts as starvation; one slow page does not", async () => {
    const { sampler } = fakeHost();
    await sampler.sample();
    const render = (ms: number): TranscriptEntry =>
      entry({ timing: { route: "/", kind: "transition", settleMs: ms, settled: true, requests: { count: 0, pending: 0, slowest: [], samples: [] } } });
    for (const ms of [200, 250, 300]) sampler.noteStep(render(ms));
    sampler.noteStep(render(9_000)); // one slow route
    sampler.noteStep(render(260));
    sampler.noteStep(render(240));
    expect(sampler.starvedNow()).toBeNull();
    for (const ms of [4_000, 5_000, 6_000]) sampler.noteStep(render(ms));
    expect(sampler.starvedNow()).toBe("renders 5000ms vs the run's baseline 250ms (>=5x)");
    expect(sampler.summary()).toMatchObject({ slowestRenderMs: 9_000, baselineRenderMs: 250 });
  });

  it("with attribution off (JEVITATE_HOST_STARVATION=off) the host is sampled and reported, never judged", async () => {
    expect(starvationAttributionFromEnv({ JEVITATE_HOST_STARVATION: "off" })).toBe(false);
    expect(starvationAttributionFromEnv({})).toBe(true);
    const { sampler } = fakeHost({ host: { ...calm, loadPerCore: 9 }, attribute: false });
    expect((await sampler.judge()).starved).toBeNull();
    sampler.noteStep(entry({ actOk: false, reason: "Timeout 5000ms exceeded" }));
    expect(sampler.findings()).toEqual([]);
    expect(sampler.summary()).toMatchObject({ peakLoadPerCore: 9, degraded: false, attribution: "off" });
  });
});

describe("degradedEnvironmentOutcome — a starved run proved nothing", () => {
  const health = (degraded: boolean) => {
    const { sampler } = fakeHost();
    return { ...sampler.summary(), peakLoadPerCore: 3, peakEventLoopLagMs: 900, steps: 4, degradedSteps: degraded ? 3 : 1, degraded, starvation: degraded ? ["load 3/core > 2"] : [] };
  };

  it("clean / exhausted / blocked become inconclusive (degraded-environment) when most steps were starved", () => {
    for (const o of ["clean", "exhausted", "blocked"] as const) {
      const v = degradedEnvironmentOutcome(o, health(true));
      expect(v.outcome).toBe("inconclusive");
      expect(v.failure?.kind).toBe("degraded-environment");
      // #213: one plain sentence with the peak readings — never "degraded-environment — …" (the kind
      // is printed beside it) and never one load reading per sample.
      expect(v.failure?.message).toBe(
        "3/4 steps ran on a starved host (peak load 3/core, peak driver event-loop lag 900ms), so the run proves nothing about the app",
      );
    }
  });

  it("#213: a failed goal keeps its own reason (the check that did not hold) inside the degraded one", () => {
    const v = degradedEnvironmentOutcome("failed", health(true), { wouldHaveBeen: "success check 'textIncludes:Saved' did not hold" });
    expect(v.outcome).toBe("inconclusive");
    expect(v.failure?.message).toMatch(/proves nothing about the app; otherwise it would have ended failed: success check 'textIncludes:Saved' did not hold$/);
  });

  it("#213: a code-verified ending (a usability job whose completion code proved) stands on a starved host", () => {
    expect(degradedEnvironmentOutcome("clean", health(true), { verified: true })).toEqual({ outcome: "clean" });
  });

  it("a confirmed defect, a succeeded goal, a crash and a healthy run keep their outcome", () => {
    for (const o of ["defects-found", "succeeded", "crashed", "hang"] as const) {
      expect(degradedEnvironmentOutcome(o, health(true))).toEqual({ outcome: o });
    }
    expect(degradedEnvironmentOutcome("clean", health(false))).toEqual({ outcome: "clean" });
  });
});
