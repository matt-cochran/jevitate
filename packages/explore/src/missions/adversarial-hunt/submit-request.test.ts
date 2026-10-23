import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FakeClock, installClock, resetClock } from "@jevitate/domain";
import type { InflightRequest, PageMonitor } from "../../page-monitor.js";
import { submitRequestSentWithin } from "./helpers.js";

/**
 * #657: Playwright reports a request to Node asynchronously, so a submit that did send its write can
 * still show no request at the instant the click resolves. A submit no field blocked is given a
 * bounded moment to show its request before it is counted as blocked.
 */
function monitorWith(requests: InflightRequest[]): PageMonitor {
  return { pending: () => requests, completedSince: () => [] } as unknown as PageMonitor;
}

describe("submitRequestSentWithin (#657)", () => {
  let fake: FakeClock;
  beforeEach(() => {
    fake = new FakeClock();
    installClock(fake);
  });
  afterEach(() => resetClock());

  it("counts a write that Playwright reports after the click resolved", async () => {
    const requests: InflightRequest[] = [];
    const since = fake.now();
    const sent = submitRequestSentWithin(monitorWith(requests), since, 1_000);
    await fake.advanceBy(200);
    requests.push({ url: "http://app/api/import", method: "POST", resourceType: "fetch", startedAt: since + 200 });
    await fake.advanceBy(100);
    await fake.runUntilIdle();
    expect(await sent).toBe(true);
  });

  it("gives up once the bound passes with no request", async () => {
    const sent = submitRequestSentWithin(monitorWith([]), fake.now(), 1_000);
    await fake.runUntilIdle();
    expect(await sent).toBe(false);
  });
});
