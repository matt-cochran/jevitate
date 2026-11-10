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

describe("PageMonitor.pendingWork — #241: an action found to have started nothing owns no later read", () => {
  /** A page whose `request` events the test fires by hand (a first background poll). */
  function pollingPage() {
    const handlers: Array<(r: unknown) => void> = [];
    const page = { on: (ev: string, h: (r: unknown) => void) => void (ev === "request" && handlers.push(h)), mainFrame: () => null } as unknown as Page;
    const fire = (method: string, url: string) => {
      const req = { url: () => url, method: () => method, resourceType: () => "fetch", isNavigationRequest: () => false, frame: () => null, headers: () => ({}), postData: () => null };
      for (const h of handlers) h(req);
    };
    const t = { now: 1_000 };
    return { t, fire, monitor: new PageMonitor(page, () => t.now) };
  }

  it("a first poll that starts just after an action is the action's work (it may have caused it)", () => {
    const { t, fire, monitor } = pollingPage();
    monitor.markAction();
    t.now = 1_800;
    fire("GET", "http://a.test/api/balance");
    expect(monitor.pendingWork().map((r) => r.url)).toEqual(["http://a.test/api/balance"]);
  });

  it("once the action is found to have started nothing, a read that starts after that is background, not pending work", () => {
    const { t, fire, monitor } = pollingPage();
    monitor.markAction();
    t.now = 1_300;
    monitor.markActionInert();
    t.now = 1_800;
    fire("GET", "http://a.test/api/balance");
    expect(monitor.pendingWork()).toEqual([]);
    // A write still counts, and a new action owns its own window again.
    fire("POST", "http://a.test/api/apply");
    expect(monitor.pendingWork().map((r) => r.method)).toEqual(["POST"]);
    t.now = 2_000;
    monitor.markAction();
    t.now = 2_200;
    fire("GET", "http://a.test/api/apply/status");
    expect(monitor.pendingWork().map((r) => r.url)).toContain("http://a.test/api/apply/status");
  });
});
