import { describe, expect, test } from "vitest";
import {
  assessCoverageSufficiency,
  resolveCoverageSufficiencyThresholds,
  DEFAULT_COVERAGE_SUFFICIENCY_THRESHOLDS,
} from "./sufficiency.js";

const T = DEFAULT_COVERAGE_SUFFICIENCY_THRESHOLDS;

describe("assessCoverageSufficiency (#75, mirroring the adversarial coverage thresholds from #69)", () => {
  test("no action taken at all is insufficient", () => {
    const r = assessCoverageSufficiency({ actions: 0, failedActions: 0, nonNavActionsExercised: 0 }, T);
    expect(r.sufficient).toBe(false);
    expect(r.shortfalls).toContain("no action was taken");
  });

  test("100% failed actions (only a skip link, nothing else tried) is insufficient — never clean", () => {
    const r = assessCoverageSufficiency({ actions: 1, failedActions: 1, nonNavActionsExercised: 0 }, T);
    expect(r.sufficient).toBe(false);
    expect(r.failedActionRatio).toBe(1);
  });

  test("≥25% failed actions is insufficient (the #75 threshold)", () => {
    const r = assessCoverageSufficiency({ actions: 4, failedActions: 1, nonNavActionsExercised: 1 }, T);
    expect(r.failedActionRatio).toBe(0.25);
    expect(r.sufficient).toBe(false);
    expect(r.shortfalls.join(" ")).toContain("1/4 actions failed");
  });

  test("only global nav exercised (no non-nav control) is insufficient even with zero failures", () => {
    const r = assessCoverageSufficiency({ actions: 3, failedActions: 0, nonNavActionsExercised: 0 }, T);
    expect(r.sufficient).toBe(false);
    expect(r.shortfalls).toContain("no non-nav (in-page) control was exercised — only global navigation");
  });

  test("under the failure threshold with a non-nav control exercised is sufficient", () => {
    const r = assessCoverageSufficiency({ actions: 10, failedActions: 1, nonNavActionsExercised: 2 }, T);
    expect(r.sufficient).toBe(true);
    expect(r.shortfalls).toEqual([]);
  });

  test("resolveCoverageSufficiencyThresholds rejects an out-of-range ratio", () => {
    expect(() => resolveCoverageSufficiencyThresholds({ maxFailedActionRatio: 1.5 })).toThrow();
    expect(() => resolveCoverageSufficiencyThresholds({ maxFailedActionRatio: -0.1 })).toThrow();
  });

  test("requireNonNavControl: false lifts the non-nav requirement", () => {
    const lenient = resolveCoverageSufficiencyThresholds({ requireNonNavControl: false });
    const r = assessCoverageSufficiency({ actions: 3, failedActions: 0, nonNavActionsExercised: 0 }, lenient);
    expect(r.sufficient).toBe(true);
  });
});
