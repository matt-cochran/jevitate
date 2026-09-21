import { describe, it, expect } from "vitest";
import {
  DEFAULT_BOUNDS,
  resolveBounds,
  BoundsTracker,
  NoProgressDetector,
} from "./index.js";

describe("bounds — hard ceilings (guardrail #2)", () => {
  it("defaults match the design (60 actions / 120 decisions / 250 candidates)", () => {
    expect(DEFAULT_BOUNDS).toEqual({ maxActions: 60, maxDecisions: 120, maxCandidates: 250 });
  });

  it("resolveBounds merges a partial override over the defaults", () => {
    expect(resolveBounds({ maxActions: 5 })).toEqual({
      maxActions: 5,
      maxDecisions: 120,
      maxCandidates: 250,
    });
  });

  it("resolveBounds fails closed on a non-positive / non-integer ceiling", () => {
    expect(() => resolveBounds({ maxActions: 0 })).toThrow(/positive integer/);
    expect(() => resolveBounds({ maxDecisions: -1 })).toThrow(/positive integer/);
    expect(() => resolveBounds({ maxCandidates: 2.5 })).toThrow(/positive integer/);
  });

  it("BoundsTracker refuses the N+1th decision and action", () => {
    const t = new BoundsTracker(resolveBounds({ maxActions: 2, maxDecisions: 3 }));
    expect(t.mayDecide()).toBe(true);
    t.countDecision();
    t.countDecision();
    t.countDecision();
    expect(t.decisions).toBe(3);
    expect(t.mayDecide()).toBe(false); // 4th refused

    t.countAction();
    t.countAction();
    expect(t.actions).toBe(2);
    expect(t.mayAct()).toBe(false); // 3rd refused
  });
});

describe("NoProgressDetector — 3 consecutive non-wait steps, unchanged signature", () => {
  it("trips on the 3rd unchanged non-wait step", () => {
    const d = new NoProgressDetector(3);
    expect(d.note("click", "sig-A")).toBe(false); // baseline
    expect(d.note("click", "sig-A")).toBe(false); // streak 1
    expect(d.note("click", "sig-A")).toBe(false); // streak 2
    expect(d.note("click", "sig-A")).toBe(true); // streak 3 -> trip
  });

  it("resets the streak on any signature change (real progress)", () => {
    const d = new NoProgressDetector(3);
    d.note("click", "sig-A");
    d.note("click", "sig-A"); // streak 1
    expect(d.note("click", "sig-B")).toBe(false); // progress -> reset
    expect(d.streak).toBe(0);
    d.note("click", "sig-B"); // streak 1
    d.note("click", "sig-B"); // streak 2
    expect(d.note("click", "sig-B")).toBe(true); // streak 3 -> trip
  });

  it("a wait step neither advances nor trips the streak", () => {
    const d = new NoProgressDetector(3);
    d.note("click", "sig-A");
    d.note("click", "sig-A"); // streak 1
    expect(d.note("wait", "sig-A")).toBe(false); // wait: no advance
    expect(d.streak).toBe(1);
    d.note("click", "sig-A"); // streak 2
    expect(d.note("click", "sig-A")).toBe(true); // streak 3 -> trip
  });

  it("rejects a non-positive limit", () => {
    expect(() => new NoProgressDetector(0)).toThrow(/positive integer/);
  });
});
