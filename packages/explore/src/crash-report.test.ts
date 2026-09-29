import { describe, it, expect } from "vitest";
import { sampleHeap } from "./crash-report.js";
import { withSession } from "./testkit.js";

describe("sampleHeap — CDP Runtime.getHeapUsage, not Chromium's bucketed performance.memory (issue #83)", () => {
  it(
    "reads real (not bucketed) heap usage: a real allocation moves the reading",
    async () => {
      await withSession("explore-heap-", async (session) => {
        await session.page.setContent("<!doctype html><html><body></body></html>");
        const before = await sampleHeap(session.page);
        expect(before).not.toBeNull();
        expect(before!.usedBytes).toBeGreaterThan(0);

        // Force real, sizeable heap growth (held via a global so it's never collected) so a
        // precise reading MUST change between samples. The bug this guards against: every
        // sample read the exact same bucketed value (e.g. `usedBytes: 10000000`) regardless
        // of actual allocation, because Chromium quantizes `performance.memory` unless a page
        // opts into precise memory info — which jevitate's pages never do.
        await session.page.evaluate(() => {
          (globalThis as unknown as { __heapHold?: unknown[] }).__heapHold = new Array(2_000_000).fill("x".repeat(64));
        });
        const after = await sampleHeap(session.page);
        expect(after).not.toBeNull();
        expect(after!.usedBytes).toBeGreaterThan(before!.usedBytes);
      });
    },
    120_000,
  );

  it(
    "still reports limitBytes (borrowed from the page — CDP has no equivalent)",
    async () => {
      await withSession("explore-heap-limit-", async (session) => {
        await session.page.setContent("<!doctype html><html><body></body></html>");
        const sample = await sampleHeap(session.page);
        expect(sample).not.toBeNull();
        expect(sample!.limitBytes).toBeGreaterThan(0);
      });
    },
    120_000,
  );
});
