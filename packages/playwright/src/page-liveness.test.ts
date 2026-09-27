import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { DEFAULT_PAGE_UNRESPONSIVE_MS, PageLivenessWatchdog, pageUnresponsiveMsFromEnv, type LivenessPage } from "./page-liveness.js";

/** A page whose evaluate answers (or not) on command. */
class FakePage implements LivenessPage {
  answering = true;
  closed = false;
  closeReason: string | undefined;
  probes = 0;
  readonly #listeners = new Map<string, Array<() => void>>();
  evaluate(): Promise<boolean> {
    this.probes += 1;
    return this.answering ? Promise.resolve(true) : new Promise<boolean>(() => undefined);
  }
  isClosed(): boolean {
    return this.closed;
  }
  async close(options?: { reason?: string }): Promise<void> {
    this.closed = true;
    this.closeReason = options?.reason;
    for (const l of this.#listeners.get("close") ?? []) l();
  }
  on(event: "close" | "crash", listener: () => void): this {
    this.#listeners.set(event, [...(this.#listeners.get(event) ?? []), listener]);
    return this;
  }
  emit(event: "close" | "crash"): void {
    for (const l of this.#listeners.get(event) ?? []) l();
  }
}

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe("PageLivenessWatchdog (#220)", () => {
  test("a page that stops answering is closed WITH the reason after unresponsiveMs — so pending operations reject instead of hanging", async () => {
    const page = new FakePage();
    const lost: string[] = [];
    const w = new PageLivenessWatchdog(page, { unresponsiveMs: 3_000, probeIntervalMs: 1_000, now: Date.now, onLost: (r) => lost.push(r) });
    await vi.advanceTimersByTimeAsync(5_000);
    expect(page.closed).toBe(false); // answering: never closed
    page.answering = false;
    await vi.advanceTimersByTimeAsync(2_000);
    expect(page.closed).toBe(false); // still within the bound
    await vi.advanceTimersByTimeAsync(2_000);
    expect(page.closed).toBe(true);
    expect(page.closeReason).toMatch(/page process stopped responding: no answer for \d+s/);
    expect(w.lost).toBe(page.closeReason);
    expect(lost).toEqual([page.closeReason]);
  });

  test("at most one probe is in flight: a frozen page is not flooded with evaluates", async () => {
    const page = new FakePage();
    page.answering = false;
    new PageLivenessWatchdog(page, { unresponsiveMs: 60_000, probeIntervalMs: 1_000, now: Date.now });
    await vi.advanceTimersByTimeAsync(10_000);
    expect(page.probes).toBe(1);
  });

  test("a page that is already gone (closed or crashed) stops the watchdog: nothing more is probed or closed", async () => {
    const closedPage = new FakePage();
    const w1 = new PageLivenessWatchdog(closedPage, { unresponsiveMs: 3_000, probeIntervalMs: 1_000, now: Date.now });
    closedPage.closed = true;
    closedPage.emit("close");
    const crashed = new FakePage();
    crashed.answering = false;
    const w2 = new PageLivenessWatchdog(crashed, { unresponsiveMs: 3_000, probeIntervalMs: 1_000, now: Date.now });
    crashed.emit("crash");
    await vi.advanceTimersByTimeAsync(10_000);
    expect(crashed.closed).toBe(false);
    expect(crashed.probes).toBe(0);
    expect(w1.lost).toBeUndefined();
    expect(w2.lost).toBeUndefined();
  });

  test("stop() (the session closing) ends the watchdog", async () => {
    const page = new FakePage();
    page.answering = false;
    const w = new PageLivenessWatchdog(page, { unresponsiveMs: 3_000, probeIntervalMs: 1_000, now: Date.now });
    w.stop();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(page.closed).toBe(false);
  });

  test("JEVITATE_PAGE_UNRESPONSIVE_MS: default when unset, value when valid, throws when invalid", () => {
    expect(pageUnresponsiveMsFromEnv({})).toBe(DEFAULT_PAGE_UNRESPONSIVE_MS);
    expect(pageUnresponsiveMsFromEnv({ JEVITATE_PAGE_UNRESPONSIVE_MS: "2500" })).toBe(2500);
    expect(() => pageUnresponsiveMsFromEnv({ JEVITATE_PAGE_UNRESPONSIVE_MS: "soon" })).toThrow(RangeError);
  });
});
