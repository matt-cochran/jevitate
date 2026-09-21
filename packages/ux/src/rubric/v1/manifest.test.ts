import { describe, expect, it } from "vitest";
import { V1_RUBRIC, loadV1Rubric } from "./index.js";

const NIELSEN_IDS = [
  "nielsen-1",
  "nielsen-2",
  "nielsen-3",
  "nielsen-4",
  "nielsen-5",
  "nielsen-6",
  "nielsen-7",
  "nielsen-8",
  "nielsen-9",
  "nielsen-10",
];
const TIER1_IDS = ["scent", "progressive-disclosure", "cognitive-load", "primary-action", "dark-patterns"];
const A11Y_IDS = ["a11y-control-name", "a11y-focus-order", "a11y-target-size", "a11y-contrast"];

describe("V1_RUBRIC manifest", () => {
  it("loads via loadRubric without throwing", () => {
    expect(() => loadV1Rubric()).not.toThrow();
  });

  it("contains the 10 Nielsen heuristics", () => {
    const ids = new Set(V1_RUBRIC.map((e) => e.id));
    for (const id of NIELSEN_IDS) expect(ids.has(id)).toBe(true);
  });

  it("contains the 5 Tier-1 differentiators", () => {
    const ids = new Set(V1_RUBRIC.map((e) => e.id));
    for (const id of TIER1_IDS) expect(ids.has(id)).toBe(true);
  });

  it("contains the objective-a11y entries", () => {
    const ids = new Set(V1_RUBRIC.map((e) => e.id));
    for (const id of A11Y_IDS) expect(ids.has(id)).toBe(true);
    const a11y = V1_RUBRIC.filter((e) => e.tier === "objective-a11y");
    expect(a11y.length).toBe(A11Y_IDS.length);
  });

  it("every entry has a non-empty citation.ref and ≥1 question", () => {
    for (const e of V1_RUBRIC) {
      expect(e.citation.ref.length).toBeGreaterThan(0);
      expect(e.citation.source.length).toBeGreaterThan(0);
      expect(e.questions.length).toBeGreaterThanOrEqual(1);
    }
  });

  it("has no duplicate ids", () => {
    const ids = V1_RUBRIC.map((e) => e.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("cites nngroup for every Nielsen entry", () => {
    for (const id of NIELSEN_IDS) {
      const e = V1_RUBRIC.find((x) => x.id === id)!;
      expect(e.citation.ref).toContain("nngroup.com/articles/ten-usability-heuristics");
    }
  });

  it("HONEST LABELING: no rubric text mentions eye-tracking or gaze", () => {
    const text = JSON.stringify(V1_RUBRIC).toLowerCase();
    expect(text).not.toContain("eye-tracking");
    expect(text).not.toContain("gaze");
  });

  it("every requiredEvidence key is a known UxEvidence field (loader-enforced)", () => {
    // loadV1Rubric would have thrown on an unknown key; this asserts it did not.
    const map = loadV1Rubric();
    expect(map.size).toBe(V1_RUBRIC.length);
  });

  it("Tier-1 differentiators cite their literature", () => {
    const byId = new Map(V1_RUBRIC.map((e) => [e.id, e]));
    expect(byId.get("scent")!.citation.source.toLowerCase()).toContain("foraging");
    expect(byId.get("cognitive-load")!.citation.source.toLowerCase()).toMatch(/hick|sweller|cognitive load/);
    expect(byId.get("dark-patterns")!.citation.source.toLowerCase()).toMatch(/brignull|deceptive/);
  });
});
