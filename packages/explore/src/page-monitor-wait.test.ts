import type { Page } from "playwright";
import { describe, expect, it } from "vitest";
import { PageMonitor } from "./page-monitor.js";

/**
 * #368 — an explicit wait the run chose (a chat reply wait, a job wait, a `wait`) is booked as
 * waiting, never as the transition's render: the timing window carries it so `settleMs` excludes it.
 */

/** A page that never emits an event — the window bookkeeping is all this tests. */
const quietPage = { on: () => undefined, mainFrame: () => null } as unknown as Page;

function monitorAt() {
  const t = { now: 1_000 };
  return { t, monitor: new PageMonitor(quietPage, () => t.now) };
}

describe("PageMonitor.explicitWait — #368", () => {
  it("books the wait after the action into the open window, once even when nested", async () => {
    const { t, monitor } = monitorAt();
    monitor.closeWindow(1_000, null);
    t.now = 1_100;
    monitor.markAction();
    await monitor.explicitWait(async () => {
      t.now += 10_000;
      await monitor.explicitWait(async () => {
        t.now += 20_000;
      });
    });
    expect(monitor.window()).toMatchObject({ actionAt: 1_100, waitedMs: 30_000 });
  });

  it("a wait before the action, or with no action in the window, is not the transition's", async () => {
    const { t, monitor } = monitorAt();
    monitor.closeWindow(1_000, null);
    await monitor.explicitWait(async () => {
      t.now += 5_000;
    });
    expect(monitor.window()).toMatchObject({ actionAt: null, waitedMs: 0 });
    monitor.markAction();
    expect(monitor.window().waitedMs).toBe(0);
  });

  it("closing the window (a perception) starts the next one with nothing waited", async () => {
    const { t, monitor } = monitorAt();
    monitor.markAction();
    await monitor.explicitWait(async () => {
      t.now += 4_000;
    });
    monitor.closeWindow(t.now, null);
    monitor.markAction();
    expect(monitor.window().waitedMs).toBe(0);
  });

  it("a wait that throws is still booked", async () => {
    const { t, monitor } = monitorAt();
    monitor.markAction();
    await expect(
      monitor.explicitWait(async () => {
        t.now += 2_000;
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    expect(monitor.window().waitedMs).toBe(2_000);
  });
});

describe("isRecurringRead — #383: the page's own poll is not pending work", () => {
  const done = (method: string, url: string) => ({ method, url });
  it("a GET whose path already completed twice recently is a poll (query ignored)", async () => {
    const { isRecurringRead } = await import("./page-monitor.js");
    const recent = [done("GET", "https://a.test/api/balance?t=1"), done("GET", "https://a.test/api/balance?t=2")];
    expect(isRecurringRead({ method: "GET", url: "https://a.test/api/balance?t=3" }, recent)).toBe(true);
  });
  it("a first or second occurrence, another path, or a write is not", async () => {
    const { isRecurringRead } = await import("./page-monitor.js");
    const once = [done("GET", "https://a.test/api/balance")];
    expect(isRecurringRead({ method: "GET", url: "https://a.test/api/balance" }, once)).toBe(false);
    const twice = [done("GET", "https://a.test/api/balance"), done("GET", "https://a.test/api/balance")];
    expect(isRecurringRead({ method: "GET", url: "https://a.test/api/apply" }, twice)).toBe(false);
    const posts = [done("POST", "https://a.test/api/apply"), done("POST", "https://a.test/api/apply")];
    expect(isRecurringRead({ method: "POST", url: "https://a.test/api/apply" }, posts)).toBe(false);
  });
});
