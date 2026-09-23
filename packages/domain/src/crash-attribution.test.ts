import { describe, expect, it } from "vitest";
import {
  attributeCrash,
  hasOwnFrame,
  isUnboundedHeapGrowth,
  looksLikeRendererOom,
  type CrashEvidence,
  type HeapSample,
} from "./crash-attribution.js";

const ROOT = "/opt/jevitate/packages/";
const OWN_STACK = [
  "Error: boom",
  "    at snapshot (file:///opt/jevitate/packages/explore/dist/snapshot.js:12:5)",
  "    at async explore (/opt/jevitate/packages/explore/dist/explore.js:40:9)",
].join("\n");
const FOREIGN_STACK = [
  "Error: Target page, context or browser has been closed",
  "    at ProtocolError (/opt/jevitate/node_modules/.pnpm/playwright-core/lib/server.js:1:1)",
  "    at process.processTicksAndRejections (node:internal/process/task_queues:95:5)",
].join("\n");

const heap = (...mb: number[]): HeapSample[] => mb.map((m, i) => ({ step: i + 1, usedBytes: m * 1_048_576 }));

const base: CrashEvidence = {
  pageCrashed: false,
  browserDisconnected: false,
  rendererOom: false,
  heapSamples: [],
  hang: false,
};

describe("attributeCrash — the pure attribution rule (owner ruling 3)", () => {
  it.each<[string, Partial<CrashEvidence>, string]>([
    ["own frame, no crash signal → jevitate", { stack: OWN_STACK }, "jevitate"],
    ["page crash wins over an own frame → system under test", { stack: OWN_STACK, pageCrashed: true }, "system-under-test"],
    ["browser crash → system under test", { stack: OWN_STACK, browserDisconnected: true }, "system-under-test"],
    ["renderer OOM → system under test", { rendererOom: true }, "system-under-test"],
    ["unbounded heap growth → system under test", { stack: OWN_STACK, heapSamples: heap(50, 80, 120, 200) }, "system-under-test"],
    ["a hang → system under test", { hang: true }, "system-under-test"],
    ["no own frame, no signal → uncertain", { stack: FOREIGN_STACK }, "uncertain"],
    ["no stack at all → uncertain", {}, "uncertain"],
  ])("%s", (_name, evidence, want) => {
    const r = attributeCrash({ ...base, ...evidence }, [ROOT]);
    expect(r.attribution).toBe(want);
    expect(r.reasons.length).toBeGreaterThan(0);
  });
});

describe("hasOwnFrame — portable stack-frame matching", () => {
  it("matches file:// URLs, plain paths and Windows paths under a code root", () => {
    expect(hasOwnFrame(OWN_STACK, [ROOT])).toBe(true);
    const win = "Error: x\n    at f (file:///C:/Users/me/jevitate/packages/cli/dist/bin.js:1:1)";
    expect(hasOwnFrame(win, ["C:\\Users\\me\\jevitate\\packages\\"])).toBe(true);
  });

  it("a dependency installed beneath the root is not jevitate code", () => {
    const installed = "Error: x\n    at y (/usr/lib/node_modules/@jevitate/node_modules/playwright-core/lib/a.js:1:1)";
    expect(hasOwnFrame(installed, ["/usr/lib/node_modules/@jevitate/"])).toBe(false);
    expect(hasOwnFrame(FOREIGN_STACK, [ROOT])).toBe(false);
    expect(hasOwnFrame(undefined, [ROOT])).toBe(false);
  });
});

describe("isUnboundedHeapGrowth / looksLikeRendererOom", () => {
  it("needs a strictly growing tail that at least doubles", () => {
    expect(isUnboundedHeapGrowth(heap(50, 80, 120, 200))).toBe(true);
    expect(isUnboundedHeapGrowth(heap(10, 50, 80, 120, 200))).toBe(true);
    expect(isUnboundedHeapGrowth(heap(50, 80, 70, 200))).toBe(false); // a GC dip
    expect(isUnboundedHeapGrowth(heap(50, 55, 60, 65))).toBe(false); // modest growth
    expect(isUnboundedHeapGrowth(heap(50, 80, 200))).toBe(false); // too few samples
  });

  it("a crash with the heap at ≥90% of its limit is an OOM", () => {
    const full: HeapSample[] = [{ step: 1, usedBytes: 950, limitBytes: 1000 }];
    expect(looksLikeRendererOom(true, full)).toBe(true);
    expect(looksLikeRendererOom(false, full)).toBe(false);
    expect(looksLikeRendererOom(true, [{ step: 1, usedBytes: 100, limitBytes: 1000 }])).toBe(false);
  });
});
