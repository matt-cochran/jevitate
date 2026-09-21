import { expect, test } from "vitest";
import { makeFinding, UxFindingError } from "./finding.js";
import type { RubricEntry } from "./types.js";

const rubric = new Map<string, RubricEntry>([
  [
    "nielsen-1",
    {
      id: "nielsen-1",
      principle: "Visibility of system status",
      citation: { source: "NN/g", ref: "nngroup.com/articles/ten-usability-heuristics" },
      tier: "semantic",
      questions: [],
      requiredEvidence: ["controls"],
    },
  ],
]);
const evidence = { screenId: "s1", refs: new Set(["control:0"]) } as const;

test("throws on unknown citationId", () => {
  expect(() =>
    makeFinding(
      {
        rubricItemId: "nope",
        evidenceRefs: [{ id: "control:0" }],
        severity: "minor",
        confidence: 0.8,
        recommendation: "x",
        tier: "semantic",
      },
      rubric,
      evidence,
    ),
  ).toThrow(/citation/i);
});

test("throws on dangling evidenceRef", () => {
  expect(() =>
    makeFinding(
      {
        rubricItemId: "nielsen-1",
        evidenceRefs: [{ id: "control:99" }],
        severity: "minor",
        confidence: 0.8,
        recommendation: "x",
        tier: "semantic",
      },
      rubric,
      evidence,
    ),
  ).toThrow(/evidence/i);
});

test("throws when no evidenceRefs supplied at all", () => {
  expect(() =>
    makeFinding(
      {
        rubricItemId: "nielsen-1",
        evidenceRefs: [],
        severity: "minor",
        confidence: 0.8,
        recommendation: "x",
        tier: "semantic",
      },
      rubric,
      evidence,
    ),
  ).toThrow(/evidence/i);
});

test("builds a finding when both resolve", () => {
  const f = makeFinding(
    {
      rubricItemId: "nielsen-1",
      evidenceRefs: [{ id: "control:0" }],
      severity: "minor",
      confidence: 0.8,
      recommendation: "x",
      tier: "semantic",
    },
    rubric,
    evidence,
  );
  expect(f.citation.source).toBe("NN/g");
  expect(f.rubricItemId).toBe("nielsen-1");
  expect(Object.isFrozen(f)).toBe(true);
});

test("the error is a typed UxFindingError", () => {
  try {
    makeFinding(
      { rubricItemId: "nope", evidenceRefs: [{ id: "control:0" }], severity: "minor", confidence: 0.8, recommendation: "x", tier: "semantic" },
      rubric,
      evidence,
    );
    throw new Error("should have thrown");
  } catch (e) {
    expect(e).toBeInstanceOf(UxFindingError);
  }
});
