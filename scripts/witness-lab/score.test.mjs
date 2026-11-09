// #800 witness lab: the scorer's rules on fixed rows (no browser, no app), and the cell plan's coverage.
import { expect, test } from "vitest";
import { CELLS, JOURNEY_DEFS, buildJourney } from "./journeys.mjs";
import { readArm } from "./run-lab.mjs";
import { renderPrediction, scoreRows } from "./score.mjs";

const row = (arm, journey, variant, flagged, durationMs, extra = {}) => {
  const cell = CELLS.find((c) => c.journey === journey && c.variant === variant);
  return { arm, journey, variant, truth: cell.truth, replicate: 0, flagged, durationMs, usd: 0, ...extra };
};

test("the plan covers every seeded variant of the acceptance, the three weak Journeys and clean cells", () => {
  const variants = new Set(CELLS.map((c) => c.variant));
  for (const v of ["clean", "j1-5xx", "j2-stall", "j3-effort", "j3-deadend"]) expect(variants.has(v)).toBe(true);
  expect(Object.values(JOURNEY_DEFS).filter((d) => d.weakness !== null)).toHaveLength(3);
  expect(CELLS.filter((c) => c.truth === "clean").length).toBeGreaterThan(0);
  expect(buildJourney("j1-strong", "http://127.0.0.1:9").recording.site).toBe("http://127.0.0.1:9");
});

test("lint's one reading per Journey is attributed to each of its cells; catalog-link rules never count", () => {
  const lint = readArm("lint", { ok: true, data: { findings: [{ rule: "job-anchors" }, { rule: "missing-persona" }] } }, 0);
  expect(lint.flagged).toBe(false);
  const weak = readArm("lint", { ok: true, data: { findings: [{ rule: "no-persistence-check" }] } }, 0);
  expect(weak.flagged).toBe(true);
  const report = scoreRows([
    { arm: "lint", journey: "j1-weak-saved", variant: "clean", truth: "weak-clean", replicate: 0, ...weak, durationMs: 1000 },
    row("witness", "j1-weak-saved", "j1-5xx", true, 1000),
  ]);
  expect(report.arms.lint.caught).toEqual({ hit: 1, total: 1 });
  expect(report.arms.lint.weakFlagged).toEqual({ hit: 1, total: 1 });
});

test("the prediction's clauses and the §7 outcome follow the counts and the time ratio", () => {
  const rows = [
    row("witness", "j1-strong", "j1-5xx", true, 10_000),
    row("witness", "j1-strong", "clean", false, 10_000),
    row("mutation", "j1-strong", "j1-5xx", true, 100_000),
    row("mutation", "j1-strong", "clean", false, 100_000),
    row("replay", "j1-strong", "clean", false, 5_000),
  ];
  const report = scoreRows(rows);
  expect(report.prediction).toMatchObject({ catches: true, alarms: true, time: true });
  expect(report.outcome).toBe("Holds");
  expect(renderPrediction(report)).toContain("Prediction held: yes");

  const slower = scoreRows(rows.map((r) => (r.arm === "witness" ? { ...r, durationMs: 50_000 } : r)));
  expect(slower.outcome).toBe("Time over 10%");
  const fewer = scoreRows(rows.map((r) => (r.arm === "witness" && r.truth === "defect" ? { ...r, flagged: false } : r)));
  expect(fewer.outcome).toBe("Witness catches fewer");
});

test("mutation proof reads 0.29.0's `proven` as sensitive (not flagged) and inconclusive/insensitive as flagged", () => {
  expect(readArm("mutation", { ok: true, data: { verdict: "proven" } }, 0).flagged).toBe(false);
  expect(readArm("mutation", { ok: true, data: { verdict: "inconclusive" } }, 2).flagged).toBe(true);
  expect(readArm("mutation", { ok: true, data: { verdict: "insensitive" } }, 1).flagged).toBe(true);
});

test("the recorded 2026-11-09 run reproduces the report's headline table", async () => {
  const { readResults } = await import("./score.mjs");
  const report = scoreRows(readResults(new URL("./results.jsonl", import.meta.url).pathname));
  expect(report.arms.witness.caught).toEqual({ hit: 27, total: 27 });
  expect(report.arms.witness.falseAlarms).toEqual({ hit: 0, total: 12 });
  expect(report.arms.mutation.caught).toEqual({ hit: 24, total: 27 });
  expect(report.arms.mutation.falseAlarms).toEqual({ hit: 6, total: 12 });
  expect(report.arms.lint.caught).toEqual({ hit: 15, total: 27 });
  expect(report.outcome).toBe("Time over 10%");
});
