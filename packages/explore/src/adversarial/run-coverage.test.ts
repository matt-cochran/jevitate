import { describe, expect, it } from "vitest";
import type { Control, Snapshot } from "../snapshot.js";
import { CoverageTracker, DEFAULT_COVERAGE_THRESHOLDS, resolveCoverageThresholds, safetyRefusalsFromTranscript } from "./run-coverage.js";

let n = 0;
function control(name: string, role: string, tag: string, extra: Partial<Control> = {}): Control {
  return {
    index: n++,
    descriptor: { role, name },
    stability: "high",
    role,
    name,
    tag,
    inputType: tag === "input" ? "text" : null,
    enabled: true,
    summary: name,
    form: "form#f",
    ...extra,
  };
}

const NAME = control("Name", "textbox", "input");
const SAVE = control("Save", "button", "button", { submits: true });
const OUT = control("Home", "link", "a", { href: "https://app.test/", form: null });
const snap = (url: string, controls: Control[]): Snapshot => ({ url, controls, truncated: false, signature: url });
const inScope = (url: string): boolean => new URL(url).pathname.startsWith("/profile");

describe("CoverageTracker region mode (#519)", () => {
  const T = { minControlRatio: 0.25, requireFormSubmit: false };
  const URL = "https://app.test/profile";
  const rsnap = (url: string, controls: Control[], matched: number): Snapshot => ({
    ...snap(url, controls),
    region: { matched },
  });
  const regionRun = (): CoverageTracker => {
    const t = new CoverageTracker(inScope, { region: "testId=import-view" });
    const inR = [
      control("Upload", "button", "button", { inRegion: true }),
      control("Continue", "button", "button", { inRegion: true }),
    ];
    const outR = Array.from({ length: 8 }, (_, i) => control(`Row ${i}`, "button", "button", { inRegion: false }));
    t.observe(rsnap(URL, [...inR, ...outR], 1));
    t.acted(URL, inR[0]);
    return t;
  };
  const unmatched = (): CoverageTracker => {
    const t = new CoverageTracker(inScope, { region: "testId=typo" });
    t.observe(rsnap(URL, [control("Row", "button", "button", { inRegion: false })], 0));
    return t;
  };

  it("counts only in-region controls in controls.total", () => {
    expect(regionRun().report(T, 0).controls.total).toBe(2);
  });
  it("counts only the exercised in-region control", () => {
    expect(regionRun().report(T, 0).controls.exercised).toBe(1);
  });
  it("computes the region ratio over in-region controls", () => {
    expect(regionRun().report(T, 0).controls.ratio).toBe(0.5);
  });
  it("reports the route-wide control total in pageControls", () => {
    expect(regionRun().report(T, 0).pageControls?.total).toBe(10);
  });
  it("reports the region spec", () => {
    expect(regionRun().report(T, 0).region?.spec).toBe("testId=import-view");
  });
  it("counts steps whose snapshot matched the region", () => {
    expect(regionRun().report(T, 0).region?.stepsMatched).toBe(1);
  });
  it("counts steps with no region match", () => {
    expect(regionRun().report(T, 0).region?.stepsWithoutRegion).toBe(0);
  });
  it("counts controls excluded from the region", () => {
    expect(regionRun().report(T, 0).region?.outOfRegion).toBe(8);
  });
  it("is sufficient at a 25% threshold", () => {
    expect(regionRun().report(T, 0).sufficient).toBe(true);
  });

  it("an out-of-region action never raises controls.exercised", () => {
    const t = new CoverageTracker(inScope, { region: "testId=x" });
    const a = control("A", "button", "button", { inRegion: true });
    const shell = control("Assistant", "button", "button", { inRegion: false });
    t.observe(rsnap(URL, [a, shell], 1));
    t.acted(URL, shell);
    expect(t.report(T, 0).controls.exercised).toBe(0);
  });

  it("a region that never matched is not sufficient", () => {
    expect(unmatched().report(T, 1).sufficient).toBe(false);
  });
  it("a region that never matched names the spec first", () => {
    expect(unmatched().report(T, 1).shortfalls[0]).toMatch(/scope region testId=typo never appeared/);
  });
  it("a region that never matched counts the region-less step", () => {
    expect(unmatched().report(T, 1).region?.stepsWithoutRegion).toBe(1);
  });

  it("without a region, the report has no pageControls", () => {
    const t = new CoverageTracker(inScope);
    t.observe(snap(URL, [control("A", "button", "button")]));
    expect(t.report(T, 0).pageControls).toBeUndefined();
  });
  it("without a region, the report has no region", () => {
    const t = new CoverageTracker(inScope);
    t.observe(snap(URL, [control("A", "button", "button")]));
    expect(t.report(T, 0).region).toBeUndefined();
  });
});

describe("CoverageTracker", () => {
  it("counts the target's exercisable controls and forms; out-of-scope pages and links never count", () => {
    const t = new CoverageTracker(inScope);
    t.observe(snap("https://app.test/profile", [NAME, SAVE, OUT]));
    t.observe(snap("https://app.test/elsewhere", [control("Other", "button", "button")]));
    t.acted("https://app.test/profile", NAME);
    t.acted("https://app.test/elsewhere", control("Other", "button", "button"));
    const r = t.report(DEFAULT_COVERAGE_THRESHOLDS, 1);
    expect(r.controls).toEqual({ total: 2, exercised: 1, ratio: 0.5 });
    expect(r.forms).toEqual({ found: 1, submitted: 0, blocked: 0 });
    expect(r.actionsOnTarget).toBe(1);
    expect(r.outOfScopeSteps).toBe(1);
    expect(r.sufficient).toBe(false);
    expect(r.shortfalls).toEqual(["no form was submitted (1 found)"]);
  });

  it("a submitted form and enough controls make a run sufficient", () => {
    const t = new CoverageTracker(inScope);
    t.observe(snap("https://app.test/profile", [NAME, SAVE]));
    t.acted("https://app.test/profile", SAVE);
    t.submitted("https://app.test/profile", "form#f");
    const r = t.report(DEFAULT_COVERAGE_THRESHOLDS, 0);
    expect(r).toMatchObject({ sufficient: true, shortfalls: [], forms: { found: 1, submitted: 1, blocked: 0 } });
  });

  it("a submit the browser blocked with native validation never counts as submitted (#155)", () => {
    const t = new CoverageTracker(inScope);
    t.observe(snap("https://app.test/profile", [NAME, SAVE]));
    t.acted("https://app.test/profile", SAVE);
    t.blocked("https://app.test/profile", "form#f", "Please fill out this field");
    const r = t.report(DEFAULT_COVERAGE_THRESHOLDS, 0);
    expect(r.forms).toEqual({ found: 1, submitted: 0, blocked: 1, blockedBy: { validation: 1 } });
    expect(r.sufficient).toBe(false);
    expect(r.shortfalls).toEqual([
      'form submitted 0 times (1 attempt blocked by validation: "Please fill out this field")',
    ]);
  });

  it("several blocked attempts pluralize; a later successful submit still counts as submitted", () => {
    const t = new CoverageTracker(inScope);
    t.observe(snap("https://app.test/profile", [NAME, SAVE]));
    t.acted("https://app.test/profile", SAVE);
    t.blocked("https://app.test/profile", "form#f", "Please fill out this field");
    t.blocked("https://app.test/profile", "form#f", "Please fill out this field");
    t.submitted("https://app.test/profile", "form#f");
    const r = t.report(DEFAULT_COVERAGE_THRESHOLDS, 0);
    expect(r.forms).toEqual({ found: 1, submitted: 1, blocked: 2, blockedBy: { validation: 2 } });
    expect(r.sufficient).toBe(true);
  });

  it("a submit blocked because it was disabled or refused by the safety policy says why (#193)", () => {
    const t = new CoverageTracker(inScope);
    t.observe(snap("https://app.test/profile", [NAME, SAVE]));
    t.acted("https://app.test/profile", NAME);
    t.blocked("https://app.test/profile", "form#f", "the submit control is disabled", "disabled");
    t.blocked("https://app.test/profile", "form#f", "matches --deny Save", "denied");
    t.blocked("https://app.test/profile", "form#f", undefined, "denied");
    const r = t.report(DEFAULT_COVERAGE_THRESHOLDS, 0);
    expect(r.forms).toEqual({ found: 1, submitted: 0, blocked: 3, blockedBy: { disabled: 1, denied: 2 } });
    expect(r.shortfalls).toEqual([
      'form submitted 0 times (1 attempt blocked with the submit disabled: "the submit control is disabled"; 2 attempts blocked by the safety policy: "matches --deny Save")',
    ]);
  });

  it("whatever the thresholds, a run that exercised nothing is never sufficient", () => {
    const t = new CoverageTracker(inScope);
    t.observe(snap("https://app.test/profile", [NAME, SAVE]));
    t.acted("https://app.test/profile", null); // a scroll
    const r = t.report({ minControlRatio: 0, requireFormSubmit: false }, 0);
    expect(r.sufficient).toBe(false);
    expect(r.shortfalls).toEqual(["no target control was exercised"]);
    const empty = new CoverageTracker(inScope).report({ minControlRatio: 0, requireFormSubmit: false }, 0);
    expect(empty.shortfalls).toEqual(["the target offered no control to exercise"]);
  });

  it("a control acted on is always counted exercised, even if observe() never saw it first (#76)", () => {
    const t = new CoverageTracker(inScope);
    // No observe() call at all — the control is discovered mid-episode (e.g. inside a dialog opened
    // by an earlier step of the SAME episode) and acted on directly.
    t.acted("https://app.test/profile", NAME);
    const r = t.report(DEFAULT_COVERAGE_THRESHOLDS, 0);
    // actionsOnTarget and controls.exercised must agree: an action on a target control is never
    // invisible to the coverage ratio.
    expect(r.actionsOnTarget).toBe(1);
    expect(r.controls).toEqual({ total: 1, exercised: 1, ratio: 1 });
  });

  it("records per strategy how often it applied vs found nothing", () => {
    const t = new CoverageTracker(inScope);
    t.strategy("double-submit", true);
    t.strategy("double-submit", true);
    t.strategy("visit-route", false);
    expect(t.report(DEFAULT_COVERAGE_THRESHOLDS, 0).strategies).toEqual({
      "double-submit": { applied: 2, foundNothing: 0 },
      "visit-route": { applied: 0, foundNothing: 1 },
    });
  });

  it("#396: a nameless-control safety refusal is parsed as denied", () => {
    const reason = "refused by the safety policy: a control with no accessible name can't be checked against --deny/--paid";
    expect(safetyRefusalsFromTranscript([{ strategy: "safety-policy", actOk: false, reason }])).toEqual([
      { name: "a control with no accessible name", risk: "denied" },
    ]);
  });

  it("thresholds default to 25% and a required submit, and reject an out-of-range ratio", () => {
    expect(resolveCoverageThresholds()).toEqual({ minControlRatio: 0.25, requireFormSubmit: true });
    expect(resolveCoverageThresholds({ minControlRatio: 0.5 })).toEqual({ minControlRatio: 0.5, requireFormSubmit: true });
    expect(() => resolveCoverageThresholds({ minControlRatio: 1.5 })).toThrow(/between 0 and 1/);
    expect(() => resolveCoverageThresholds({ minControlRatio: Number.NaN })).toThrow(/between 0 and 1/);
  });
});
