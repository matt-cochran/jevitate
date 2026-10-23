// #644 Regression guard for the accuracy-lab scoring rules and cell plan: the recorded 2026-10-23
// baseline must reproduce its headline goal numbers (precision 8/12, recall 1.0), and a full
// measurement must still cover the clean app on every job plus each seeded variant on its job.
import { expect, test } from "vitest";
import { readResults, loadGroundTruth, scoreRows } from "./score.mjs";
import { buildCells } from "./run-matrix.mjs";

const BASELINE = new URL("./fixtures/baseline-results.jsonl", import.meta.url).pathname;
const report = scoreRows(readResults(BASELINE), loadGroundTruth());

test("baseline goal precision is 0.667", () => {
  expect(report.strategies.goal.precision.toFixed(3)).toBe("0.667");
});

test("baseline goal recall is 1.0", () => {
  expect(report.strategies.goal.recall).toBe(1);
});

test("the matrix plans clean on every job and each seeded variant on its affected job", () => {
  const pairs = [...new Set(buildCells(1).map((c) => `${c.variant}|${c.job}`))].sort();
  expect(pairs).toEqual([
    "clean|J1",
    "clean|J2",
    "clean|J3",
    "j1-5xx|J1",
    "j2-stall|J2",
    "j3-deadend|J3",
    "j3-effort|J3",
  ]);
});
