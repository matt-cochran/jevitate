import { describe, expect, it } from "vitest";
import { HostHealthSampler, type HostPressure } from "@jevitate/explore";
import { attachCdpProbe, failureWithHostStarved, finishHostHealth } from "./host-health-run.js";

/** #452 — the run-level verdict seam: a stall on a starved host is `host-starved`, never a generic failure. */

const GB = 1024 ** 3;
const calm: HostPressure = { sample: { memAvailableBytes: 8 * GB, source: "test" }, overThreshold: null, loadPerCore: 0.4 };
const stalled = { kind: "stalled", message: "the page stopped responding (no step completed in 120s)" };
const noGovernor = { snapshot: () => ({ governance: "off" }) } as never;

function sampler(over: { lag?: number; cdp?: number } = {}): HostHealthSampler {
  return new HostHealthSampler({
    probe: async () => calm,
    eventLoopLagMs: () => over.lag ?? 2,
    cdpLatencyMs: async () => over.cdp ?? 3,
    now: () => 0,
    intervalMs: 0,
    attribute: true,
    cores: 8,
  });
}

describe("finishHostHealth classifies a stall on a starved host (#452)", () => {
  it("injected CDP latency on a stalled run is failure kind host-starved", async () => {
    const v = await finishHostHealth(sampler({ cdp: 4_500 }), "inconclusive", { failure: stalled }, noGovernor);
    expect(v.failure?.kind).toBe("host-starved");
  });

  it("a blocked event loop on a stalled run is failure kind host-starved", async () => {
    const v = await finishHostHealth(sampler({ lag: 2_000 }), "inconclusive", { failure: stalled }, noGovernor);
    expect(v.failure?.kind).toBe("host-starved");
  });

  it("a crashed outcome from a starved stall is reclassified inconclusive", async () => {
    const v = await finishHostHealth(sampler({ cdp: 4_500 }), "crashed", { failure: { kind: "exception", message: "page.goto: Timeout 30000ms exceeded." } }, noGovernor);
    expect(v.outcome).toBe("inconclusive");
  });

  it("a confirmed defect keeps its outcome while the stall is still named host-starved", async () => {
    const v = await finishHostHealth(sampler({ cdp: 4_500 }), "defects-found", { failure: stalled }, noGovernor);
    expect(v.outcome).toBe("defects-found");
  });

  it("the measurement lands in the result's hostHealth", async () => {
    const v = await finishHostHealth(sampler({ cdp: 4_500 }), "inconclusive", { failure: stalled }, noGovernor);
    expect(v.fields.hostHealth.peakCdpLatencyMs).toBe(4_500);
  });

  it("a stalled run on a calm host has no host-starved failure", async () => {
    const v = await finishHostHealth(sampler(), "inconclusive", { failure: stalled }, noGovernor);
    expect(v.failure).toBeUndefined();
  });

  it("host-starved explains the stall before the engine's own failure", () => {
    const own = { kind: "stalled", message: "m" };
    expect(failureWithHostStarved({ failure: { kind: "host-starved", message: "h" } }, own)?.kind).toBe("host-starved");
  });
});

describe("attachCdpProbe (#452)", () => {
  it("measures the round-trip of a cheap browser-level CDP command", async () => {
    const s = sampler();
    const sent: string[] = [];
    const page = { context: () => ({ browser: () => ({ newBrowserCDPSession: async () => ({ send: async (m: string) => void sent.push(m) }) }) }) };
    attachCdpProbe(s, page);
    await s.sample();
    expect(sent).toEqual(["Browser.getVersion"]);
  });

  it("a page without a browser contributes no reading", async () => {
    const s = new HostHealthSampler({ probe: async () => calm, eventLoopLagMs: () => 2, intervalMs: 0, attribute: true, cores: 8 });
    attachCdpProbe(s, { context: () => ({ browser: () => null }) });
    await s.sample();
    expect(s.summary().peakCdpLatencyMs).toBeNull();
  });
});
