import { describe, expect, it } from "vitest";
import { loadRubric, RubricLoadError, RubricEntrySchema } from "./schema.js";

const valid = {
  id: "nielsen-1",
  principle: "Visibility of system status",
  citation: { source: "NN/g", ref: "nngroup.com/articles/ten-usability-heuristics" },
  tier: "semantic",
  questions: [
    {
      id: "status-visible",
      instruction: "Does the screen keep the user informed about what is going on?",
      criteria: "There is a visible, timely indicator of current state/progress relevant to the job.",
      kind: "noul",
      flag: { when: "noul-false" },
      severity: "minor",
    },
  ],
  requiredEvidence: ["controls", "visibleText"],
};

describe("loadRubric", () => {
  it("loads a valid entry into a Map keyed by id", () => {
    const map = loadRubric([valid]);
    expect(map.get("nielsen-1")?.principle).toBe("Visibility of system status");
    expect(map.size).toBe(1);
  });

  it("throws naming the entry when citation is missing", () => {
    const { citation, ...noCitation } = valid;
    void citation;
    expect(() => loadRubric([noCitation as never])).toThrow(RubricLoadError);
    expect(() => loadRubric([noCitation as never])).toThrow(/nielsen-1/);
    expect(() => loadRubric([noCitation as never])).toThrow(/citation/i);
  });

  it("throws when questions is empty", () => {
    expect(() => loadRubric([{ ...valid, questions: [] }])).toThrow(/question/i);
  });

  it("throws when a requiredEvidence key is not a known UxEvidence field", () => {
    expect(() => loadRubric([{ ...valid, requiredEvidence: ["controls", "bogusField"] }] as never)).toThrow(
      RubricLoadError,
    );
    expect(() => loadRubric([{ ...valid, requiredEvidence: ["bogusField"] }] as never)).toThrow(/requiredEvidence|bogusField/i);
  });

  it("throws on duplicate ids", () => {
    expect(() => loadRubric([valid, valid])).toThrow(/duplicate/i);
  });

  it("requires choices when a question kind is choice", () => {
    const bad = {
      ...valid,
      questions: [{ ...valid.questions[0], kind: "choice", flag: { when: "choice-in", options: ["a"] } }],
    };
    expect(() => RubricEntrySchema.parse(bad)).toThrow();
  });
});
