import { describe, expect, it } from "vitest";
import { CALIBRATION_KNOWN_APP_CLASSES, GRADER_FILTER_KAPPA_GATE, calibrationCaveat, calibrationNoteFor, graderMayFilterByDefault } from "./calibration.js";

describe("calibrationNoteFor", () => {
  it("finds the known-class entry case-insensitively", () => {
    expect(calibrationNoteFor("consumer")).toBe(CALIBRATION_KNOWN_APP_CLASSES[0]);
    expect(calibrationNoteFor("Consumer")).toBe(CALIBRATION_KNOWN_APP_CLASSES[0]);
    expect(calibrationNoteFor(" CONSUMER  ")).toBe(CALIBRATION_KNOWN_APP_CLASSES[0]);
  });

  it("is undefined for an app class not in the table, or an empty/undefined app class", () => {
    expect(calibrationNoteFor("B2B SaaS marketing site")).toBeUndefined();
    expect(calibrationNoteFor("")).toBeUndefined();
    expect(calibrationNoteFor(undefined)).toBeUndefined();
  });
});

describe("calibrationCaveat", () => {
  it("a known-but-only-weakly-evidenced app class still gets a caveat, never a silent pass", () => {
    const c = calibrationCaveat("consumer");
    expect(c).toMatch(/consumer/i);
    expect(c).toMatch(/tuning app only/i);
  });

  it("an app class outside the calibration corpus is flagged as UNVERIFIED, naming the class", () => {
    const c = calibrationCaveat("B2B SaaS marketing site");
    expect(c).toMatch(/B2B SaaS marketing site/);
    expect(c).toMatch(/UNVERIFIED/);
    expect(c).toMatch(/outside the grader's calibration corpus/);
  });

  it("a missing app class still returns a non-empty caveat", () => {
    const c = calibrationCaveat(undefined);
    expect(c.length).toBeGreaterThan(0);
    expect(c).toMatch(/no app class was given/);
    expect(c).toMatch(/UNVERIFIED/);
  });

  it("never returns an empty string for any input (report.ts relies on this to decide whether to show the guardrail)", () => {
    for (const appClass of ["consumer", "admin", "B2B SaaS marketing site", "", undefined]) {
      expect(calibrationCaveat(appClass).length).toBeGreaterThan(0);
    }
  });
});

describe("grader filtering gate (#133)", () => {
  it("no app class clears the held-out kappa gate yet, so the grader filters nothing by default", () => {
    expect(GRADER_FILTER_KAPPA_GATE).toBe(0.4);
    for (const appClass of ["consumer", "admin", "B2B SaaS marketing site", "", undefined]) {
      expect(graderMayFilterByDefault(appClass)).toBe(false);
    }
  });

  it("every caveat says the grade is shown, not used to hide findings, and how to opt in", () => {
    for (const appClass of ["consumer", "admin", undefined]) {
      const c = calibrationCaveat(appClass);
      expect(c).toMatch(/does NOT hide findings by default/);
      expect(c).toMatch(/--show actionable,relevant-minor/);
    }
  });
});
