import { describe, expect, test } from "vitest";
import {
  AdmissionTimeoutError,
  BrowserCrashedError,
  BrowserPool,
  DEFAULT_PRESSURE_THRESHOLDS,
  admissionViolation,
  defaultMaxContexts,
  type PooledBrowser,
} from "./browser-pool.js";
import type { ResourceSample, ResourceSignals } from "./resource-signals.js";

const GiB = 1024 ** 3;
const calm: ResourceSample = {
  cpuPressure: 1,
  cpuMetric: "psi-cpu-some-avg10",
  memPressure: 0,
  memMetric: "psi-memory-full-avg10",
  memAvailableBytes: 8 * GiB,
  source: "fixture:psi",
};

class FakeContext {
  closed = false;
  async close(): Promise<void> {
    this.closed = true;
  }
}

class FakeBrowser implements PooledBrowser<FakeContext, { tag: string }> {
  readonly contexts: FakeContext[] = [];
  closed = false;
  failNewContext = false;
  #onDisconnect: (() => void)[] = [];
  async newContext(): Promise<FakeContext> {
    if (this.failNewContext) throw new Error("newContext boom");
    const c = new FakeContext();
    this.contexts.push(c);
    return c;
  }
  async close(): Promise<void> {
    this.closed = true;
    for (const l of this.#onDisconnect) l();
  }
  on(_event: "disconnected", listener: () => void): this {
    this.#onDisconnect.push(listener);
    return this;
  }
  /** Simulates the browser process dying. */
  crash(): void {
    for (const l of this.#onDisconnect) l();
  }
}

/** Signals that replay a scripted sequence, repeating the last sample. */
function scripted(samples: ResourceSample[]): ResourceSignals & { calls: number } {
  const state = { calls: 0 };
  return Object.assign(state, {
    sample: async (): Promise<ResourceSample> => {
      const s = samples[Math.min(state.calls, samples.length - 1)];
      state.calls += 1;
      if (s === undefined) throw new Error("no samples");
      return s;
    },
  });
}

/** A fake clock whose sleep advances time instantly. */
function fakeClock(): { now: () => number; sleep: (ms: number) => Promise<void>; slept: number[] } {
  let t = 0;
  const slept: number[] = [];
  return {
    now: () => t,
    sleep: async (ms) => {
      slept.push(ms);
      t += ms;
    },
    slept,
  };
}

function launcher(): { launch: () => Promise<FakeBrowser>; browsers: FakeBrowser[] } {
  const browsers: FakeBrowser[] = [];
  return {
    browsers,
    launch: async () => {
      const b = new FakeBrowser();
      browsers.push(b);
      return b;
    },
  };
}

const opts = { tag: "ctx" };

describe("admission policy", () => {
  test("default cap = max(1, min(cores/2, memAvailable/400MB))", () => {
    expect(defaultMaxContexts(16, 8 * GiB, 400 * 1024 ** 2)).toBe(8);
    expect(defaultMaxContexts(16, 1 * GiB, 400 * 1024 ** 2)).toBe(2);
    expect(defaultMaxContexts(1, 100, 400 * 1024 ** 2)).toBe(1);
  });

  test("violation names the metric, value, limit and source", () => {
    expect(admissionViolation({ ...calm, memPressure: 12 }, DEFAULT_PRESSURE_THRESHOLDS, 0)).toBe(
      "memory pressure full avg10=12% > 5% (source=fixture:psi)",
    );
    expect(admissionViolation({ ...calm, memAvailableBytes: 100 * 1024 ** 2 }, DEFAULT_PRESSURE_THRESHOLDS, 400 * 1024 ** 2)).toBe(
      "memory available=100MiB < 400MiB (source=fixture:psi)",
    );
    expect(
      admissionViolation(
        { cpuPressure: 99, cpuMetric: "cpu-busy-delta", memAvailableBytes: GiB, source: "win32:cpus-delta+freemem" },
        { ...DEFAULT_PRESSURE_THRESHOLDS, "cpu-busy-delta": 95 },
        0,
      ),
    ).toBe("cpu busy=99% > 95% (source=win32:cpus-delta+freemem)");
    expect(admissionViolation(calm, DEFAULT_PRESSURE_THRESHOLDS, 0)).toBeUndefined();
  });

  test("non-stall CPU signals are advisory by default; PSI CPU stall still blocks", () => {
    // Regression (PR #59, first macOS CI run): a healthy GitHub macOS runner read loadavg1-per-core
    // ~194% and the old 200% limit held the pool for 129s. Load average / busy% are not stalls.
    const macBusy: ResourceSample = { cpuPressure: 260, cpuMetric: "loadavg1-per-core", memPressure: 1, memMetric: "vm-pressure-level", memAvailableBytes: GiB, source: "darwin" };
    expect(admissionViolation(macBusy, DEFAULT_PRESSURE_THRESHOLDS, 0)).toBeUndefined();
    const winBusy: ResourceSample = { cpuPressure: 100, cpuMetric: "cpu-busy-delta", memAvailableBytes: GiB, source: "win32:cpus-delta+freemem" };
    expect(admissionViolation(winBusy, DEFAULT_PRESSURE_THRESHOLDS, 0)).toBeUndefined();
    // Opt-in enforcement still works per metric.
    expect(admissionViolation(macBusy, { ...DEFAULT_PRESSURE_THRESHOLDS, "loadavg1-per-core": 200 }, 0)).toMatch(/> 200%/);
    // A true CPU stall (Linux PSI) blocks by default.
    const psiStall: ResourceSample = { ...calm, cpuPressure: 90, cpuMetric: "psi-cpu-some-avg10" };
    expect(admissionViolation(psiStall, DEFAULT_PRESSURE_THRESHOLDS, 0)).toMatch(/> 80%/);
  });

  test("macOS warn level admits, critical blocks", () => {
    const mac: ResourceSample = { memPressure: 50, memMetric: "vm-pressure-level", memAvailableBytes: GiB, source: "darwin" };
    expect(admissionViolation(mac, DEFAULT_PRESSURE_THRESHOLDS, 0)).toBeUndefined();
    expect(admissionViolation({ ...mac, memPressure: 100 }, DEFAULT_PRESSURE_THRESHOLDS, 0)).toMatch(/vm level=100% > 50%/);
  });
});

describe("BrowserPool", () => {
  test("one browser serves many contexts; each lease is its own context", async () => {
    const l = launcher();
    const pool = new BrowserPool<FakeContext, { tag: string }>({ signals: scripted([calm]), maxContexts: 4 });
    const a = await pool.acquire("k", l.launch, opts);
    const b = await pool.acquire("k", l.launch, opts);
    expect(l.browsers).toHaveLength(1);
    expect(a.context).not.toBe(b.context);
    expect(a.admission.sample.source).toBe("fixture:psi");
    await a.release();
    await b.release();
    expect(a.context.closed && b.context.closed).toBe(true);
    await pool.close();
  });

  test("cap is respected: the (cap+1)th acquire waits until a lease is released", async () => {
    const l = launcher();
    const pool = new BrowserPool<FakeContext, { tag: string }>({ signals: scripted([calm]), maxContexts: 2 });
    const a = await pool.acquire("k", l.launch, opts);
    await pool.acquire("k", l.launch, opts);
    let third = false;
    const pending = pool.acquire("k", l.launch, opts).then((lease) => {
      third = true;
      return lease;
    });
    await new Promise((r) => setTimeout(r, 20));
    expect(third).toBe(false);
    expect(pool.inUse).toBe(2);
    await a.release();
    const c = await pending;
    expect(third).toBe(true);
    expect(pool.inUse).toBe(2);
    await c.release();
    await pool.close();
  });

  test("unconfigured cap is derived from the first sample", async () => {
    const l = launcher();
    const pool = new BrowserPool<FakeContext, { tag: string }>({
      signals: scripted([{ ...calm, memAvailableBytes: 900 * 1024 ** 2 }]),
      availableParallelism: () => 32,
    });
    const lease = await pool.acquire("k", l.launch, opts);
    expect(pool.maxContexts).toBe(2);
    expect(lease.admission.maxContexts).toBe(2);
    await lease.release();
    await pool.close();
  });

  test("admission blocks while a signal is over threshold, then admits when it drops", async () => {
    const clock = fakeClock();
    const hot = { ...calm, memPressure: 20 };
    const signals = scripted([hot, hot, hot, calm]);
    const pool = new BrowserPool<FakeContext, { tag: string }>({
      signals,
      maxContexts: 1,
      now: clock.now,
      sleep: clock.sleep,
      backoffInitialMs: 100,
      backoffMaxMs: 300,
    });
    const lease = await pool.acquire("k", launcher().launch, opts);
    expect(signals.calls).toBe(4);
    expect(clock.slept).toEqual([100, 200, 300]);
    expect(lease.admission.waitedMs).toBe(600);
    expect(lease.admission.sample).toEqual(calm);
    await lease.release();
    await pool.close();
  });

  test("bounded wait: stays hot past the deadline → actionable AdmissionTimeoutError, slot freed", async () => {
    const clock = fakeClock();
    const pool = new BrowserPool<FakeContext, { tag: string }>({
      signals: scripted([{ ...calm, memPressure: 12 }]),
      maxContexts: 1,
      admissionTimeoutMs: 1_000,
      now: clock.now,
      sleep: clock.sleep,
    });
    const err = await pool.acquire("k", launcher().launch, opts).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AdmissionTimeoutError);
    expect(String(err)).toContain("admission timed out after 1000ms: memory pressure full avg10=12% > 5% (source=fixture:psi)");
    expect(pool.inUse).toBe(0);
  });

  test("bounded wait also covers a busy cap", async () => {
    const pool = new BrowserPool<FakeContext, { tag: string }>({ signals: scripted([calm]), maxContexts: 1, admissionTimeoutMs: 30 });
    const l = launcher();
    const held = await pool.acquire("k", l.launch, opts);
    await expect(pool.acquire("k", l.launch, opts)).rejects.toThrow(/all 1 browser context slot\(s\) stayed busy/);
    expect(pool.inUse).toBe(1);
    await held.release();
    expect(pool.inUse).toBe(0);
    await pool.close();
  });

  test("lease released on throw: withContext body throws → slot free and context closed", async () => {
    const pool = new BrowserPool<FakeContext, { tag: string }>({ signals: scripted([calm]), maxContexts: 1 });
    const l = launcher();
    await expect(
      pool.withContext("k", l.launch, opts, async () => {
        throw new Error("body failed");
      }),
    ).rejects.toThrow("body failed");
    expect(pool.inUse).toBe(0);
    expect(l.browsers[0]?.contexts[0]?.closed).toBe(true);
    // The freed slot is usable again (no deadlock at cap 1).
    await pool.withContext("k", l.launch, opts, async () => undefined);
    await pool.close();
  });

  test("newContext failure frees the slot and propagates", async () => {
    const pool = new BrowserPool<FakeContext, { tag: string }>({ signals: scripted([calm]), maxContexts: 1 });
    const b = new FakeBrowser();
    b.failNewContext = true;
    await expect(pool.acquire("k", async () => b, opts)).rejects.toThrow("newContext boom");
    expect(pool.inUse).toBe(0);
    await pool.close();
  });

  test("launch failure propagates and does not poison the key", async () => {
    const pool = new BrowserPool<FakeContext, { tag: string }>({ signals: scripted([calm]), maxContexts: 1 });
    await expect(pool.acquire("k", async () => Promise.reject(new Error("no chromium")), opts)).rejects.toThrow("no chromium");
    expect(pool.inUse).toBe(0);
    const l = launcher();
    const lease = await pool.acquire("k", l.launch, opts);
    expect(l.browsers).toHaveLength(1);
    await lease.release();
    await pool.close();
  });

  test("browser crash → every live lease fails loudly; next acquire relaunches lazily", async () => {
    const l = launcher();
    const pool = new BrowserPool<FakeContext, { tag: string }>({ signals: scripted([calm]), maxContexts: 4 });
    const a = await pool.acquire("k", l.launch, opts);
    const b = await pool.acquire("k", l.launch, opts);
    l.browsers[0]?.crash();
    expect(a.crash).toBeInstanceOf(BrowserCrashedError);
    expect(b.crash?.message).toMatch(/disconnected unexpectedly .* with 2 live context\(s\)/);
    await expect(a.release()).rejects.toBeInstanceOf(BrowserCrashedError);
    await expect(b.release()).rejects.toThrow(/NOT retried/);
    expect(pool.inUse).toBe(0);
    const c = await pool.acquire("k", l.launch, opts);
    expect(l.browsers).toHaveLength(2);
    expect(c.crash).toBeUndefined();
    await c.release();
    await pool.close();
  });

  test("pool.close() is not a crash", async () => {
    const l = launcher();
    const pool = new BrowserPool<FakeContext, { tag: string }>({ signals: scripted([calm]), maxContexts: 1 });
    const a = await pool.acquire("k", l.launch, opts);
    await pool.close();
    expect(a.crash).toBeUndefined();
    expect(l.browsers[0]?.closed).toBe(true);
  });

  test("idle browser is closed after idleCloseMs; a new lease before that reuses it", async () => {
    const l = launcher();
    const pool = new BrowserPool<FakeContext, { tag: string }>({ signals: scripted([calm]), maxContexts: 1, idleCloseMs: 30 });
    await (await pool.acquire("k", l.launch, opts)).release();
    await (await pool.acquire("k", l.launch, opts)).release();
    expect(l.browsers).toHaveLength(1);
    await new Promise((r) => setTimeout(r, 80));
    expect(l.browsers[0]?.closed).toBe(true);
    await (await pool.acquire("k", l.launch, opts)).release();
    expect(l.browsers).toHaveLength(2);
    await pool.close();
  });

  test("invalid maxContexts is rejected up front", () => {
    expect(() => new BrowserPool({ signals: scripted([calm]), maxContexts: 0 })).toThrow(RangeError);
  });
});
