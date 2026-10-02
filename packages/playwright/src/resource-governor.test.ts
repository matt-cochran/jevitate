import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MachineBrowserSlots } from "./machine-slots.js";
import {
  DEFAULT_THROTTLE_THRESHOLDS,
  ResourceGovernor,
  defaultMaxBrowsers,
  defaultMemoryCeilingBytes,
  effectiveMaxBrowsers,
  governanceFromEnv,
  pageResourceLimit,
  throttleDecision,
  type GovernanceConfig,
  type HostLoadSample,
  type MemoryWatchedPage,
} from "./resource-governor.js";

/** #205: throttling decisions from injected load samples, the governor's slot/refcount rules and the memory ceiling. */

const GiB = 1024 ** 3;
const MiB = 1024 ** 2;
const CALM: HostLoadSample = { loadPerCore: 0.4, memAvailableBytes: 12 * GiB };

describe("throttleDecision (pure)", () => {
  it("normal on a calm host: no reasons, settle factor 1", () => {
    expect(throttleDecision(CALM)).toMatchObject({ level: "normal", reasons: [], settleFactor: 1 });
  });

  it("throttled above 2 runnable tasks per core (the reported WSL case: load 40 on 16 cores)", () => {
    const d = throttleDecision({ loadPerCore: 40 / 16, memAvailableBytes: 12 * GiB });
    expect(d).toMatchObject({ level: "throttled", reasons: ["load 2.50/core > 2"], settleFactor: 2 });
  });

  it("exactly 2/core is still normal; 4/core is starved", () => {
    expect(throttleDecision({ loadPerCore: 2 }).level).toBe("normal");
    expect(throttleDecision({ loadPerCore: 4 })).toMatchObject({ level: "starved", reasons: ["load 4/core >= 4"] });
  });

  it("low memory throttles, very low memory starves (whatever the load)", () => {
    expect(throttleDecision({ loadPerCore: 0.1, memAvailableBytes: GiB })).toMatchObject({ level: "throttled", reasons: ["memory available 1024 MiB < 1536 MiB"] });
    expect(throttleDecision({ loadPerCore: 0.1, memAvailableBytes: 300 * MiB })).toMatchObject({ level: "starved", reasons: ["memory available 300 MiB < 512 MiB"] });
  });

  it("memory pressure (PSI) throttles; starved keeps the throttle reasons too", () => {
    expect(throttleDecision({ memPressure: 12, memMetric: "psi-memory-full-avg10", memAvailableBytes: 8 * GiB })).toMatchObject({
      level: "throttled",
      reasons: ["memory pressure 12% (psi-memory-full-avg10) > 5%"],
    });
    expect(throttleDecision({ loadPerCore: 5, memPressure: 9 }).reasons).toEqual(["load 5/core >= 4", "memory pressure 9% > 5%"]);
  });

  it("a platform without a load average is judged on memory alone", () => {
    expect(throttleDecision({ memAvailableBytes: 8 * GiB }).level).toBe("normal");
  });

  it("thresholds are injectable", () => {
    expect(throttleDecision({ loadPerCore: 1.5 }, { ...DEFAULT_THROTTLE_THRESHOLDS, throttleLoadPerCore: 1 }).level).toBe("throttled");
  });

  it("the machine cap is halved (at least 1) while loaded", () => {
    expect(effectiveMaxBrowsers(4, "normal")).toBe(4);
    expect(effectiveMaxBrowsers(4, "throttled")).toBe(2);
    expect(effectiveMaxBrowsers(5, "starved")).toBe(2);
    expect(effectiveMaxBrowsers(1, "throttled")).toBe(1);
  });
});

describe("defaults and environment", () => {
  it("default cap: cores/4 within 2..6, and one per 2 GiB", () => {
    expect(defaultMaxBrowsers(16, 24 * GiB)).toBe(4);
    expect(defaultMaxBrowsers(4, 8 * GiB)).toBe(2);
    expect(defaultMaxBrowsers(64, 256 * GiB)).toBe(6);
    expect(defaultMaxBrowsers(32, 6 * GiB)).toBe(3);
  });

  it("default memory ceiling: 4 GiB, or half the RAM", () => {
    expect(defaultMemoryCeilingBytes(24 * GiB)).toBe(4 * GiB);
    expect(defaultMemoryCeilingBytes(4 * GiB)).toBe(2 * GiB);
  });

  it("reads JEVITATE_RESOURCE_GOVERNANCE / JEVITATE_MAX_BROWSERS / JEVITATE_MAX_BROWSER_MEMORY_MB", () => {
    expect(governanceFromEnv({ JEVITATE_MAX_BROWSERS: "3", JEVITATE_MAX_BROWSER_MEMORY_MB: "2048" })).toEqual({ enabled: true, maxBrowsers: 3, memoryCeilingBytes: 2 * GiB });
    expect(governanceFromEnv({ JEVITATE_RESOURCE_GOVERNANCE: "off", JEVITATE_MAX_BROWSER_MEMORY_MB: "off" })).toMatchObject({ enabled: false, memoryCeilingBytes: null });
  });

  it("a set-but-invalid value throws instead of meaning the default", () => {
    expect(() => governanceFromEnv({ JEVITATE_MAX_BROWSERS: "0" })).toThrow(/JEVITATE_MAX_BROWSERS must be a positive integer/);
    expect(() => governanceFromEnv({ JEVITATE_MAX_BROWSER_MEMORY_MB: "2g" })).toThrow(/JEVITATE_MAX_BROWSER_MEMORY_MB/);
    expect(() => governanceFromEnv({ JEVITATE_RESOURCE_GOVERNANCE: "maybe" })).toThrow(/must be on or off/);
  });
});

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "jev-governor-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const ON: GovernanceConfig = { enabled: true, maxBrowsers: 4, memoryCeilingBytes: 2 * GiB };

/** A governor over a private slot dir and a scripted host. */
function governor(host: () => HostLoadSample, extra: Partial<ConstructorParameters<typeof ResourceGovernor>[0]> = {}): ResourceGovernor {
  return new ResourceGovernor({
    config: ON,
    slots: new MachineBrowserSlots({ dir, pollMs: 5 }),
    sampleHost: async () => host(),
    measureMemory: () => undefined,
    decisionTtlMs: 0,
    intervalMs: 60_000,
    admissionTimeoutMs: 200,
    ...extra,
  });
}

describe("ResourceGovernor", () => {
  it("one machine slot per process: nested sessions share it, the last close releases it", async () => {
    const g = governor(() => CALM);
    const a = await g.enter();
    const b = await g.enter(); // an observer opened while the primary is open — never waits on itself
    expect(g.slots.list()).toHaveLength(1);
    a.release();
    expect(g.slots.list()).toHaveLength(1);
    b.release();
    b.release(); // idempotent
    expect(g.slots.list()).toHaveLength(0);
    expect(g.openSessions).toBe(0);
  });

  it("a throttled host halves the machine cap a new run may take, and the summary records it", async () => {
    // Two other jevitate processes already hold slots 0 and 1 (live: this test's own pid).
    const other = new MachineBrowserSlots({ dir });
    const held = [other.tryAcquire(2)!, other.tryAcquire(2)!];
    const loaded = governor(() => ({ loadPerCore: 2.5, memAvailableBytes: 12 * GiB }));
    const started = Date.now();
    await expect(loaded.enter()).rejects.toThrow(/all 2 machine-wide browser slot\(s\) stayed busy/); // 4 → 2 while throttled
    const calm = governor(() => CALM);
    const t = await calm.enter(); // calm: the full cap of 4 → slot 2
    expect(calm.snapshot(started)).toMatchObject({ governance: "on", maxBrowsers: 4, machineSlot: { index: 2 }, throttle: { level: "normal" } });
    t.release();
    const s = loaded.snapshot(started);
    expect(s.throttle).toEqual({ level: "throttled", reasons: ["load 2.50/core > 2"], settleFactor: 2 });
    expect(s.throttleChanges.map((c) => c.level)).toEqual(["throttled"]);
    expect(loaded.settleFactor()).toBe(2);
    for (const h of held) h.release();
  });

  it("adapts as the host changes: every level change is recorded, the worst one summarised", async () => {
    let sample: HostLoadSample = CALM;
    const g = governor(() => sample);
    const t0 = Date.now();
    await g.decide();
    sample = { loadPerCore: 3 };
    await g.decide();
    sample = CALM;
    await g.decide();
    const s = g.snapshot(t0);
    expect(s.throttleChanges.map((c) => c.level)).toEqual(["normal", "throttled", "normal"]);
    expect(s.throttle.level).toBe("throttled");
    expect(g.settleFactor()).toBe(1);
  });

  it("governance off: no machine slot, no throttling, no default ceiling — an explicit limit still applies", async () => {
    const g = governor(() => ({ loadPerCore: 9 }), { config: { ...ON, enabled: false } });
    const t = await g.enter();
    expect(g.slots.list()).toHaveLength(0);
    expect(g.settleFactor()).toBe(1);
    t.release();
    const explicit = await g.enter({ maxBrowsers: 1 });
    expect(g.slots.list()).toHaveLength(1);
    explicit.release();
    expect(g.snapshot(0)).toMatchObject({ governance: "off", memoryCeilingBytes: null, memoryMeasurement: "off", throttle: { level: "normal" } });
  });

  it("over the memory ceiling the session's page is closed with the reason, typed as a resource limit", async () => {
    let bytes = 500 * MiB;
    const g = governor(() => CALM, { measureMemory: () => ({ bytes, metric: "pss", processes: 5 }) });
    const closed: string[] = [];
    const page: MemoryWatchedPage = {
      isClosed: () => closed.length > 0,
      close: async (o) => {
        closed.push(o?.reason ?? "");
      },
      evaluate: async () => 0 as never,
    };
    const t0 = Date.now();
    const ticket = await g.enter({ memoryCeilingBytes: GiB });
    const unwatch = g.watchMemory(page, { memoryCeilingBytes: GiB });
    await g.tick();
    expect(closed).toEqual([]);
    bytes = 1536 * MiB;
    await g.tick();
    expect(closed).toHaveLength(1);
    expect(closed[0]).toMatch(/^resource limit: this run's browser processes used 1536 MiB \(pss of 5 processes\), over the 1024 MiB memory ceiling/);
    expect(pageResourceLimit(page)).toMatchObject({ kind: "memory", measuredBytes: 1536 * MiB, ceilingBytes: GiB, metric: "pss" });
    const s = g.snapshot(t0);
    expect(s).toMatchObject({ memoryCeilingBytes: GiB, peakBrowserMemoryBytes: 1536 * MiB, memoryMeasurement: "pss", resourceLimit: { measuredBytes: 1536 * MiB } });
    unwatch();
    ticket.release();
  });

  it("with several sessions over the ceiling, the page holding the most JS heap is the one ended", async () => {
    const g = governor(() => CALM, { measureMemory: () => ({ bytes: 3 * GiB, metric: "rss", processes: 9 }) });
    const mk = (heap: number): MemoryWatchedPage & { closed: boolean } => {
      const p = {
        closed: false,
        isClosed: () => p.closed,
        close: async () => {
          p.closed = true;
        },
        evaluate: async () => heap as never,
      };
      return p;
    };
    const small = mk(10 * MiB);
    const big = mk(900 * MiB);
    g.watchMemory(small, { memoryCeilingBytes: GiB });
    g.watchMemory(big, { memoryCeilingBytes: GiB });
    await g.tick();
    expect(big.closed).toBe(true);
    expect(small.closed).toBe(false);
    expect(pageResourceLimit(small)).toBeUndefined();
  });

  it("no memory reader on the platform: nothing is closed and the summary says unavailable", async () => {
    const g = governor(() => CALM);
    const page: MemoryWatchedPage = { isClosed: () => false, close: async () => undefined, evaluate: async () => 0 as never };
    g.watchMemory(page, { memoryCeilingBytes: 1 });
    await g.tick();
    expect(pageResourceLimit(page)).toBeUndefined();
    expect(g.snapshot(0).memoryMeasurement).toBe("unavailable");
  });
});
