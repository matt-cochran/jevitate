import { expect, test } from "vitest";
import type { Recording, DiffResult } from "@jevitate/recording";
import { autoDecidePostdoc } from "./auto-decide.js";

function baseWithOneFill(): Recording {
  return {
    version: "1.0",
    site: "https://example.test",
    pages: [{ url: "/search", steps: [{ step: { kind: "fill", target: { testId: "q" }, value: { redacted: true, length: 5 }, expect: { kind: "visible", target: { testId: "results" } } } }] }],
  };
}

test("a confident-variable column becomes a 'variable' decision", () => {
  const diff: DiffResult = { columns: [{ kind: "variable", confidence: 0.9, values: ["widgets", "gadgets"], inferredType: "string" }] };
  const decisions = autoDecidePostdoc(baseWithOneFill(), diff);
  expect(decisions).toEqual([{ step: { page: 0, step: 0 }, classify: "variable", name: expect.any(String) }]);
});

test("a constant column becomes a 'constant' decision", () => {
  const diff: DiffResult = { columns: [{ kind: "constant", confidence: 1, values: ["widgets"] }] };
  const decisions = autoDecidePostdoc(baseWithOneFill(), diff);
  expect(decisions).toEqual([{ step: { page: 0, step: 0 }, classify: "constant" }]);
});

test("an ambiguous/noisy column becomes a 'handback' decision, never a guessed constant", () => {
  const diff: DiffResult = { columns: [{ kind: "noise", confidence: 0.2, values: ["a8f0-91-uuid-looking"] }] };
  const decisions = autoDecidePostdoc(baseWithOneFill(), diff);
  expect(decisions[0].classify).toBe("handback");
});

test("a low-confidence variable (below CONFIDENT_VARIABLE_THRESHOLD) is NOT auto-promoted", () => {
  const diff: DiffResult = { columns: [{ kind: "variable", confidence: 0.3, values: ["a", "b"] }] };
  const decisions = autoDecidePostdoc(baseWithOneFill(), diff);
  expect(decisions[0].classify).toBe("handback");
});

test("throws when the base/diff shapes don't correlate", () => {
  const diff: DiffResult = { columns: [] };
  expect(() => autoDecidePostdoc(baseWithOneFill(), diff)).toThrow(/must be take 0/);
});
