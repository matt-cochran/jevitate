import { describe, expect, it } from "vitest";
import { combineConfidence, DEFAULT_MIN_CONFIDENCE, MinConfidenceError, resolveMinConfidence } from "./confidence.js";

describe("combineConfidence", () => {
  it("= mean(violation × applicability × grounding) × occurrences/judged", () => {
    const r = combineConfidence([{ violation: 0.9, applicability: 1, grounding: 1 }, { violation: 0.7, applicability: 1, grounding: 1 }], 4);
    expect(r.confidence).toBe(0.4); // 0.8 × 2/4
    expect(r.basis).toEqual({ violation: 0.8, applicability: 1, grounding: 1, agreement: 0.5 });
  });
  it("a heuristic that does not apply cannot score high, however certain the violation", () => {
    expect(combineConfidence([{ violation: 0.99, applicability: 0.05, grounding: 1 }], 1).confidence).toBeLessThan(0.1);
  });
});

describe("resolveMinConfidence", () => {
  it("defaults to the named constant (re-measured: 0.3, secondary to the quality grade)", () => {
    expect(resolveMinConfidence(undefined, {})).toBe(DEFAULT_MIN_CONFIDENCE);
    expect(DEFAULT_MIN_CONFIDENCE).toBe(0.3);
  });
  it("flag > env > config", () => {
    expect(resolveMinConfidence("0.2", { JEVITATE_UX_MIN_CONFIDENCE: "0.4" }, 0.6)).toBe(0.2);
    expect(resolveMinConfidence(undefined, { JEVITATE_UX_MIN_CONFIDENCE: "0.4" }, 0.6)).toBe(0.4);
    expect(resolveMinConfidence(undefined, {}, 0.6)).toBe(0.6);
  });

  it("issue #97: config ux.minConfidenceByAppClass is a fallback BELOW config ux.minConfidence, ABOVE DEFAULT_MIN_CONFIDENCE", () => {
    expect(resolveMinConfidence(undefined, {}, undefined, 0.55)).toBe(0.55);
    expect(resolveMinConfidence(undefined, {}, 0.6, 0.55)).toBe(0.6); // global config wins over app-class config
    expect(resolveMinConfidence(undefined, {}, undefined, undefined)).toBe(DEFAULT_MIN_CONFIDENCE);
    expect(resolveMinConfidence("0.2", {}, undefined, 0.55)).toBe(0.2); // flag still wins over app-class config
    expect(resolveMinConfidence(undefined, { JEVITATE_UX_MIN_CONFIDENCE: "0.4" }, undefined, 0.55)).toBe(0.4); // env still wins
  });

  it("an invalid app-class config value throws, never silently falls back to the default", () => {
    expect(() => resolveMinConfidence(undefined, {}, undefined, 2)).toThrow(MinConfidenceError);
  });
  it("invalid values throw", () => {
    expect(() => resolveMinConfidence("abc", {})).toThrow(MinConfidenceError);
    expect(() => resolveMinConfidence(undefined, { JEVITATE_UX_MIN_CONFIDENCE: "2" })).toThrow(MinConfidenceError);
  });
});
