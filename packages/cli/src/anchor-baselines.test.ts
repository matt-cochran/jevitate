import { describe, expect, it } from "vitest";
import type { Journey } from "@jevitate/journey";
import { anchorBaseline, type BaselineRun } from "./anchor-baselines.js";

const step = (stepId: string) => ({ stepId, step: { kind: "click" } });
function journey(ids: string[], anchors: unknown[]): Journey {
  return { metadata: { anchors }, recording: { pages: [{ steps: ids.map(step) }] } } as unknown as Journey;
}
const J = journey(["s-aaa", "s-bbb", "s-ccc"], [
  { name: "mid", step: 2, stepId: "s-bbb" },
  { name: "end-ish", step: 3 },
]);
const clean: BaselineRun = {
  outcome: "completed",
  steps: [
    { index: 0, atMs: 100, durationMs: 50 },
    { index: 1, atMs: 200, durationMs: 300 },
    { index: 2, atMs: 600, durationMs: 100 },
  ],
};

describe("anchorBaseline", () => {
  it("measures an anchor to its step's completion from the first step's start", () => {
    expect(anchorBaseline(J, clean)!.anchors.find((a) => a.name === "mid")).toEqual({ name: "mid", step: 2, stepId: "s-bbb", atMs: 400 });
  });
  it("reports the total as first start to last completion", () => {
    expect(anchorBaseline(J, clean)!.totalMs).toBe(600);
  });
  it("counts the executed steps", () => {
    expect(anchorBaseline(J, clean)!.steps).toBe(3);
  });
  it("adds job_start at 0 and job_end at the total", () => {
    const a = anchorBaseline(J, clean)!.anchors;
    expect([a[0], a[a.length - 1]]).toEqual([{ name: "job_start", step: 1, atMs: 0 }, { name: "job_end", step: 3, atMs: 600 }]);
  });
  it("yields nothing for a failed run", () => {
    expect(anchorBaseline(J, { ...clean, outcome: "failed" })).toBeUndefined();
  });
  it("yields nothing for a run awaiting a human", () => {
    expect(anchorBaseline(J, { ...clean, outcome: "awaiting_human" })).toBeUndefined();
  });
  it("resolves by stepId after steps shift", () => {
    const shifted = journey(["s-new", "s-aaa", "s-bbb"], [{ name: "mid", step: 2, stepId: "s-bbb" }]);
    expect(anchorBaseline(shifted, clean)!.anchors.find((a) => a.name === "mid")).toMatchObject({ step: 3, atMs: 600 });
  });
  it("omits an anchor whose step did not execute", () => {
    const run: BaselineRun = { outcome: "completed", steps: clean.steps.slice(0, 2) };
    expect(anchorBaseline(J, run)!.anchors.map((a) => a.name)).toEqual(["job_start", "mid", "job_end"]);
  });
});
