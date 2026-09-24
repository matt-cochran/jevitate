import { describe, expect, it } from "vitest";
import type { Control, Snapshot } from "../snapshot.js";
import { CoverageTracker, DEFAULT_COVERAGE_THRESHOLDS, resolveCoverageThresholds } from "./run-coverage.js";

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

describe("CoverageTracker", () => {
  it("counts the target's exercisable controls and forms; out-of-scope pages and links never count", () => {
    const t = new CoverageTracker(inScope);
    t.observe(snap("https://app.test/profile", [NAME, SAVE, OUT]));
    t.observe(snap("https://app.test/elsewhere", [control("Other", "button", "button")]));
    t.acted("https://app.test/profile", NAME);
    t.acted("https://app.test/elsewhere", control("Other", "button", "button"));
    const r = t.report(DEFAULT_COVERAGE_THRESHOLDS, 1);
    expect(r.controls).toEqual({ total: 2, exercised: 1, ratio: 0.5 });
    expect(r.forms).toEqual({ found: 1, submitted: 0 });
    expect(r.actionsOnTarget).toBe(1);
    expect(r.outOfScopeSteps).toBe(1);
    expect(r.sufficient).toBe(false);
    expect(r.shortfalls).toEqual(["no form was submitted (1 found)"]);
  });

  it("a submitted form and enough controls make a run sufficient", () => {
    const t = new CoverageTracker(inScope);
    t.observe(snap("https://app.test/profile", [NAME, SAVE]));
    t.acted("https://app.test/profile", SAVE, "form#f");
    const r = t.report(DEFAULT_COVERAGE_THRESHOLDS, 0);
    expect(r).toMatchObject({ sufficient: true, shortfalls: [], forms: { found: 1, submitted: 1 } });
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

  it("thresholds default to 25% and a required submit, and reject an out-of-range ratio", () => {
    expect(resolveCoverageThresholds()).toEqual({ minControlRatio: 0.25, requireFormSubmit: true });
    expect(resolveCoverageThresholds({ minControlRatio: 0.5 })).toEqual({ minControlRatio: 0.5, requireFormSubmit: true });
    expect(() => resolveCoverageThresholds({ minControlRatio: 1.5 })).toThrow(/between 0 and 1/);
    expect(() => resolveCoverageThresholds({ minControlRatio: Number.NaN })).toThrow(/between 0 and 1/);
  });
});
