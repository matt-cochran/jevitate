import { afterEach, describe, expect, it, vi } from "vitest";
import { FakeClock, clock, installClock, resetClock } from "@jevitate/domain";
import type { Page } from "playwright";
import type { Journey, JourneyNetworkCheck } from "@jevitate/journey";
import type { Actor } from "@jevitate/screenplay";
import type { CapturedRequest } from "@jevitate/explore";

/**
 * #617: a step's request window is membership by IDENTITY — each `beforeStep` starts a fresh
 * `RequestCapture`, so a request begun under an earlier attempt (or step) is never its own, even
 * when the clock reads the same millisecond. The page monitor is faked so the test can feed a
 * request that began before one window and finished after the next began.
 */
const harness = vi.hoisted(() => {
  type Capture = {
    began(key: object, r: unknown): void;
    ended(key: object, f: unknown | null): void;
  };
  type Monitor = {
    instrument(): Promise<void>;
    startCapture(): Capture;
    stopCapture(c: Capture): void;
    waitSettled(): Promise<{ settled: boolean; waitedMs: number; pending: unknown[] }>;
    began(key: object, r: unknown): void;
    ended(key: object, f: unknown | null): void;
  };
  const monitors = new WeakMap<object, Monitor>();
  const forPage = (page: object, Ctor: new () => Capture): Monitor => {
    let m = monitors.get(page);
    if (m === undefined) {
      const captures = new Set<Capture>();
      m = {
        instrument: async () => undefined,
        startCapture: () => {
          const c = new Ctor();
          captures.add(c);
          return c;
        },
        stopCapture: (c) => {
          captures.delete(c);
        },
        waitSettled: async () => ({ settled: true, waitedMs: 0, pending: [] }),
        began: (key, r) => {
          for (const c of captures) c.began(key, r);
        },
        ended: (key, f) => {
          for (const c of captures) c.ended(key, f);
        },
      };
      monitors.set(page, m);
    }
    return m;
  };
  return { monitors, forPage };
});

vi.mock("@jevitate/explore", async (importOriginal) => {
  const real = await importOriginal<typeof import("@jevitate/explore")>();
  return { ...real, monitorFor: (page: object) => harness.forPage(page, real.RequestCapture) };
});

const { JourneyOutcomeChecks } = await import("./journey-network-checks.js");

function journey(id: string, networkChecks: JourneyNetworkCheck[]): Journey {
  return {
    metadata: { id, name: "Save settings", promoted: false, params: [], createdAtIso: "2026-10-03T00:00:00.000Z", networkChecks },
    recording: {
      version: "1",
      site: "https://app.test",
      pages: [
        {
          url: "/app",
          steps: [
            { step: { kind: "navigate", url: "/app", expect: { kind: "visible", target: { role: "heading", name: "Settings" } } } },
            { step: { kind: "click", target: { role: "button", name: "Save" }, expect: { kind: "visible", target: { role: "button", name: "Save" } } } },
          ],
        },
      ],
    },
  };
}

/** The fixture with a step-request expectation on its second (1-based) step. */
function journeyWithStepRequests(id: string, requests: JourneyNetworkCheck[]): Journey {
  const j = journey(id, []);
  const steps = j.recording.pages[0].steps;
  steps[1] = { ...steps[1], expectRequests: requests };
  return j;
}

/** A recorded request on the step's clock. */
function request(path: string): CapturedRequest {
  return { method: "POST", url: `https://app.test${path}`, path, status: 204, failed: false, startedAt: clock.now() };
}

const actor = {} as Actor;
const recorded = { step: { kind: "click", target: { role: "button", name: "Save" } } } as never;

describe("JourneyOutcomeChecks step-window membership by identity (#617)", () => {
  afterEach(() => resetClock());

  it("a request begun under the first attempt does not satisfy the restarted window, even at one clock tick", async () => {
    installClock(new FakeClock({ startMs: 1_000_000 }));
    const page = {} as Page;
    const checks = new JourneyOutcomeChecks(page, journeyWithStepRequests("membership-restart", [{ kind: "requestMade", method: "POST", pathGlob: "/api/save" }]));
    const observer = checks.observer()!;
    const key = {};
    await checks.run(actor, async () => {
      const monitor = harness.monitors.get(page)!;
      await observer.beforeStep!({ actor, index: 1, recorded });
      monitor.began(key, request("/api/save"));
      await observer.beforeStep!({ actor, index: 1, recorded });
      monitor.ended(key, request("/api/save"));
      return { outcome: "ok", output: null };
    });

    expect(checks.lastFailures).toEqual([{ where: "step-request", step: 2, checkIndex: 0, detail: expect.any(String) }]);
  });

  it("a retry request begun inside the restarted window satisfies the check at the same clock tick", async () => {
    installClock(new FakeClock({ startMs: 1_000_000 }));
    const page = {} as Page;
    const checks = new JourneyOutcomeChecks(page, journeyWithStepRequests("membership-retry", [{ kind: "requestMade", method: "POST", pathGlob: "/api/save" }]));
    const observer = checks.observer()!;
    const key = {};
    await checks.run(actor, async () => {
      const monitor = harness.monitors.get(page)!;
      await observer.beforeStep!({ actor, index: 1, recorded });
      await observer.beforeStep!({ actor, index: 1, recorded });
      monitor.began(key, request("/api/save"));
      monitor.ended(key, request("/api/save"));
      return { outcome: "ok", output: null };
    });

    expect(checks.lastFailures).toEqual([]);
  });
});
