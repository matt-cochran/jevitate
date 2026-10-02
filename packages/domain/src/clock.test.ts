import { afterEach, describe, expect, it } from "vitest";
import { FakeClock, TimeSkippingClock, clock, installClock, realClock, resetClock, currentClock } from "./clock.js";

afterEach(() => resetClock());

describe("clock (default: the real platform clock)", () => {
  it("reads real time and schedules real timers", async () => {
    expect(currentClock()).toBe(realClock);
    const before = Date.now();
    expect(Math.abs(clock.now() - before)).toBeLessThan(1_000);
    expect(new Date(clock.nowIso()).getTime()).toBeGreaterThanOrEqual(before);
    const t0 = clock.monotonicMs();
    await clock.sleep(5);
    expect(clock.monotonicMs()).toBeGreaterThan(t0);
    let fired = false;
    const h = clock.setTimeout(() => (fired = true), 1);
    expect(typeof h.unref).toBe("function");
    await clock.sleep(10);
    expect(fired).toBe(true);
  });
});

describe("FakeClock", () => {
  it("only moves when advanced, firing timers in due order (ties in scheduling order)", async () => {
    const fake = new FakeClock({ startMs: Date.UTC(2026, 0, 1) });
    installClock(fake);
    const log: string[] = [];
    clock.setTimeout(() => log.push("b@20"), 20);
    clock.setTimeout(() => log.push("a@10"), 10);
    clock.setTimeout(() => log.push("c@10"), 10);
    expect(clock.nowIso()).toBe("2026-01-01T00:00:00.000Z");
    await fake.advanceBy(9);
    expect(log).toEqual([]);
    await fake.advanceBy(11);
    expect(log).toEqual(["a@10", "c@10", "b@20"]);
    expect(clock.monotonicMs()).toBe(20);
    expect(clock.now()).toBe(Date.UTC(2026, 0, 1) + 20);
  });

  it("resolves sleeps and lets awaited work continue between timers", async () => {
    const fake = new FakeClock();
    installClock(fake);
    const log: number[] = [];
    void (async () => {
      for (let i = 0; i < 3; i++) {
        await clock.sleep(1_000);
        await Promise.resolve();
        log.push(clock.monotonicMs());
      }
    })();
    await fake.advanceBy(15_000);
    expect(log).toEqual([1_000, 2_000, 3_000]);
  });

  it("interleaves real I/O turns between fake ticks", async () => {
    const fake = new FakeClock({ ioTurns: 2 });
    installClock(fake);
    const seen: string[] = [];
    void (async () => {
      await clock.sleep(100);
      await new Promise<void>((r) => setImmediate(r));
      seen.push("after-io");
      await clock.sleep(100);
      seen.push("second");
    })();
    await fake.advanceBy(200);
    expect(seen).toEqual(["after-io", "second"]);
  });

  it("clears timeouts and intervals; intervals repeat", async () => {
    const fake = new FakeClock();
    installClock(fake);
    let ticks = 0;
    const iv = clock.setInterval(() => ticks++, 100);
    const t = clock.setTimeout(() => (ticks += 1_000), 50);
    clock.clearTimeout(t);
    await fake.advanceBy(350);
    expect(ticks).toBe(3);
    clock.clearInterval(iv);
    await fake.advanceBy(1_000);
    expect(ticks).toBe(3);
    expect(fake.pending()).toBe(0);
  });

  it("runUntilIdle drains chained timers; an endless interval is bounded", async () => {
    const fake = new FakeClock();
    installClock(fake);
    let n = 0;
    const chain = (): void => {
      if (++n < 5) clock.setTimeout(chain, 1_000);
    };
    clock.setTimeout(chain, 1_000);
    await fake.runUntilIdle();
    expect(n).toBe(5);
    expect(clock.monotonicMs()).toBe(5_000);
    clock.setInterval(() => undefined, 10);
    await expect(fake.runUntilIdle(20)).rejects.toThrow(/still busy/);
  });

  it("warp runs fake time faster than real time", async () => {
    const fake = new FakeClock();
    installClock(fake);
    fake.warp(1_000, 2);
    const started = Date.now();
    await clock.sleep(15_000);
    fake.stopWarp();
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(clock.monotonicMs()).toBeGreaterThanOrEqual(15_000);
  });

  it("fake handles look like Node timeouts", () => {
    const fake = new FakeClock();
    installClock(fake);
    const h = clock.setTimeout(() => undefined, 10).unref();
    expect(h.hasRef()).toBe(true);
    expect(Number(h)).toBeGreaterThan(0);
    clock.clearTimeout(h);
    expect(fake.pending()).toBe(0);
  });

  it("resetClock restores the real clock", () => {
    installClock(new FakeClock({ startMs: 0 }));
    expect(clock.now()).toBe(0);
    resetClock();
    expect(clock.now()).toBeGreaterThan(1_000_000);
  });
});

describe("TimeSkippingClock", () => {
  it("flows in real time but skips idle waits, in order", async () => {
    const skipping = new TimeSkippingClock({ idleMs: 5 });
    installClock(skipping);
    const started = Date.now();
    const t0 = clock.monotonicMs();
    const log: number[] = [];
    clock.setTimeout(() => log.push(2), 20_000);
    clock.setTimeout(() => log.push(1), 10_000);
    await clock.sleep(30_000);
    expect(log).toEqual([1, 2]);
    expect(clock.monotonicMs() - t0).toBeGreaterThanOrEqual(30_000);
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(skipping.skipped.jumps).toBeGreaterThanOrEqual(3);
    skipping.stop();
  });

  it("never skips while canSkip vetoes (outside work in flight); onSkip sees every jump", async () => {
    let busy = true;
    const jumps: number[] = [];
    const skipping = new TimeSkippingClock({ idleMs: 1, canSkip: () => !busy, onSkip: (ms) => void jumps.push(ms) });
    installClock(skipping);
    let fired = false;
    clock.setTimeout(() => (fired = true), 5_000);
    await new Promise((r) => setTimeout(r, 50));
    expect(fired).toBe(false);
    busy = false;
    await new Promise((r) => setTimeout(r, 50));
    expect(fired).toBe(true);
    expect(jumps.length).toBe(1);
    expect(jumps[0]).toBeGreaterThan(4_000);
    skipping.stop();
  });

  it("skips a long wait in steps of at most maxSkipMs", async () => {
    const jumps: number[] = [];
    const skipping = new TimeSkippingClock({ idleMs: 1, maxSkipMs: 1_000, onSkip: (ms) => void jumps.push(ms) });
    installClock(skipping);
    await clock.sleep(5_000);
    expect(jumps.length).toBeGreaterThanOrEqual(5);
    expect(Math.max(...jumps)).toBeLessThanOrEqual(1_000);
    skipping.stop();
  });

  it("does not skip while the process keeps using the clock", async () => {
    const skipping = new TimeSkippingClock({ idleMs: 30 });
    installClock(skipping);
    let fired = false;
    clock.setTimeout(() => (fired = true), 5_000);
    const until = Date.now() + 100;
    while (Date.now() < until) {
      clock.now();
      await new Promise((r) => setTimeout(r, 2));
    }
    expect(fired).toBe(false);
    skipping.stop();
  });
});
