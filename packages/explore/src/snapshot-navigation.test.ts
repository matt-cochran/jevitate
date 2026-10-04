import type { Page } from "playwright";
import { afterEach, describe, expect, it } from "vitest";
import { FakeClock, installClock, resetClock } from "@jevitate/domain";
import { isNavigationInterruption, NAVIGATION_RETRIES, PageNavigatingError, snapshot } from "./snapshot.js";

/**
 * #372: the snapshot read retries ONLY a read cut off by a navigation (bounded), and lets every
 * other error through unchanged. A fake page: `elementHandles` fails with the scripted errors, then
 * returns no candidates (an empty, valid snapshot).
 */

const NAV = "locator.elementHandles: Execution context was destroyed, most likely because of a navigation.";
const CLOSED = "locator.elementHandles: Target page, context or browser has been closed";

function fakePage(failures: string[]): { page: Page; reads: () => number; waits: () => number } {
  let reads = 0;
  let waits = 0;
  const locator = {
    elementHandles: async () => {
      reads += 1;
      const f = failures.shift();
      if (f !== undefined) throw new Error(f);
      return [];
    },
    evaluateAll: async () => [],
  };
  const page = {
    url: () => "http://app.test/ended",
    viewportSize: () => ({ width: 800, height: 600 }),
    isClosed: () => false,
    locator: () => locator,
    waitForLoadState: async () => {
      waits += 1;
    },
  } as unknown as Page;
  return { page, reads: () => reads, waits: () => waits };
}

afterEach(() => resetClock());

describe("snapshot — navigation interruptions (#372)", () => {
  it("classifies only the navigation case as an interruption", () => {
    expect(isNavigationInterruption(new Error(NAV))).toBe(true);
    expect(isNavigationInterruption(new Error("Protocol error (Runtime.callFunctionOn): Cannot find context with specified id"))).toBe(true);
    expect(isNavigationInterruption(new Error(CLOSED))).toBe(false);
    expect(isNavigationInterruption(new Error("boom"))).toBe(false);
  });

  it("waits for the navigation and re-reads: a read cut off twice still returns the new page", async () => {
    installClock(new FakeClock());
    const f = fakePage([NAV, NAV]);
    const snap = await snapshot(f.page);
    expect(snap.url).toBe("http://app.test/ended");
    expect(f.reads()).toBe(3);
    expect(f.waits()).toBe(2);
  });

  it("is bounded: a page that never stops navigating ends in the typed PageNavigatingError", async () => {
    installClock(new FakeClock());
    const f = fakePage(Array.from({ length: 10 }, () => NAV));
    const err = await snapshot(f.page).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PageNavigatingError);
    expect((err as PageNavigatingError).attempts).toBe(NAVIGATION_RETRIES + 1);
    expect(f.reads()).toBe(NAVIGATION_RETRIES + 1);
  });

  it("propagates a non-navigation error unchanged, without retrying", async () => {
    installClock(new FakeClock());
    const f = fakePage(["boom"]);
    await expect(snapshot(f.page)).rejects.toThrow(/^boom$/);
    expect(f.reads()).toBe(1);
    expect(f.waits()).toBe(0);
  });

  it("propagates a closed page/context/browser unchanged (not a navigation)", async () => {
    installClock(new FakeClock());
    const f = fakePage([CLOSED]);
    const err = await snapshot(f.page).catch((e: unknown) => e);
    expect(err).not.toBeInstanceOf(PageNavigatingError);
    expect((err as Error).message).toBe(CLOSED);
    expect(f.reads()).toBe(1);
  });
});
