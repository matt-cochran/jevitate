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
    // #209: the shortfall now ends with a hint on how to reach clean.
    expect(r.shortfalls.some((x) => x.startsWith("no non-nav (in-page) control was exercised — only global navigation"))).toBe(true);
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

describe("#213 — shortfalls say why and how to reach clean", () => {
  test("a failure that timed out (after a retry) advises re-running / raising the timeout, never --deny", () => {
    const r = assessCoverageSufficiency({ actions: 3, failedActions: 1, nonNavActionsExercised: 2, timedOutActions: 1 }, T);
    const s = r.shortfalls.join(" ");
    expect(s).toContain("every one timed out, even after a retry");
    expect(s).toContain("re-run it, or raise the click timeout with JEVITATE_CLICK_TIMEOUT_MS");
    expect(s).not.toContain("--deny");
  });

  test("a non-timeout failure keeps the --deny advice", () => {
    const r = assessCoverageSufficiency({ actions: 3, failedActions: 1, nonNavActionsExercised: 2, timedOutActions: 0 }, T);
    expect(r.shortfalls.join(" ")).toContain("--deny");
  });

  test("no action: every control refused by the safety policy names them and --allow-destructive", () => {
    const r = assessCoverageSufficiency(
      {
        actions: 0,
        failedActions: 0,
        nonNavActionsExercised: 0,
        noAction: { seedCandidates: 2, refused: [{ name: "Delete account", risk: "destructive" }, { name: "Buy", risk: "paid" }], outOfScopeChrome: 0 },
      },
      T,
    );
    const s = r.shortfalls[0] ?? "";
    expect(s).toMatch(/^no action was taken — 2 control\(s\) were refused by the safety policy: "Delete account" \(destructive\), "Buy" \(paid\); to reach clean: --allow-destructive/);
  });

  test("no action: only out-of-scope chrome points at --route / --scope app", () => {
    const r = assessCoverageSufficiency(
      { actions: 0, failedActions: 0, nonNavActionsExercised: 0, noAction: { seedCandidates: 3, refused: [], outOfScopeChrome: 3 } },
      T,
    );
    expect(r.shortfalls[0]).toContain("navigation chrome leaving the route scope");
    expect(r.shortfalls[0]).toContain("--route '<glob>' or --scope app");
  });

  test("no action: an empty start page says so", () => {
    const r = assessCoverageSufficiency(
      { actions: 0, failedActions: 0, nonNavActionsExercised: 0, noAction: { seedCandidates: 0, refused: [], outOfScopeChrome: 0 } },
      T,
    );
    expect(r.shortfalls[0]).toContain("the start page offered no enabled control");
    expect(r.shortfalls[0]).toContain("to reach clean: start --url on a page with its own controls");
  });
});
