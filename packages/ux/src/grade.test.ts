import { describe, expect, it } from "vitest";
import type { Answer, JudgmentPort, JudgmentState, Question } from "@jevitate/ai-core";
import {
  CALIBRATED_QUALITY_POLICY,
  DEFAULT_QUALITY_POLICY,
  defaultQualityPolicy,
  describeCandidate,
  gradeCandidates,
  parseQualityPolicy,
  policyFilters,
  QualityPolicyError,
  resolveQualityPolicy,
} from "./grade.js";
import { redactEvidence } from "./redact.js";
import { UX_PROMPTS } from "./prompts.js";
import type { UxEvidence } from "./types.js";

const evidence: UxEvidence = {
  screenId: "s1",
  url: "https://app.example.com/settings",
  controls: [{ index: 0, role: "button", name: "Save", tag: "button", inputType: null, enabled: true, summary: 'button "Save"' }],
  visibleText: "Notification settings",
  appContext: { appClass: "consumer" },
  job: "turn off email alerts",
  history: [],
  behavior: { noProgress: false, backtracks: 0, formReentry: 0, dwellMs: 0, errors: 0 },
  a11yFacts: { controls: [] },
};

const candidate = {
  key: "k1",
  principle: "Visibility of system status",
  observation: 'button "Save" gives no saved confirmation',
  userImpact: "The user saves twice",
  recommendation: 'Show "Saved" next to the Save button',
  controls: ['button "Save"'],
  quotes: [],
};

describe("gradeCandidates", () => {
  it("asks ONE batched Jev choice question per finding with the asset's label criteria, grounded in the screen state", async () => {
    let seen: { state: JudgmentState; questions: Record<string, Question> } | undefined;
    const port: JudgmentPort = {
      async systemOne(args) {
        seen = args;
        return { "grade::0": { kind: "choice", value: "actionable", confidence: 0.7 } } as Record<string, Answer>;
      },
    };
    const grades = await gradeCandidates(port, redactEvidence(evidence, []), [candidate]);
    expect(grades.get("k1")).toEqual({ label: "actionable", confidence: 0.7 });
    const q = seen?.questions["grade::0"];
    expect(q?.kind).toBe("choice");
    if (q?.kind !== "choice") return;
    expect(q.options).toEqual(["actionable", "relevant-minor", "generic", "wrong"]);
    expect(q.descriptions).toEqual(UX_PROMPTS.grader.labels);
    expect(q.instructions).toContain('button "Save" gives no saved confirmation');
    expect(seen?.state.controls).toEqual(['button "Save"']);
    expect(seen?.state.goal).toContain("turn off email alerts");
  });

  it("fails closed on a missing/invalid label (never a silent pass)", async () => {
    const port: JudgmentPort = { async systemOne() { return {}; } };
    await expect(gradeCandidates(port, redactEvidence(evidence, []), [candidate])).rejects.toThrow(/no valid label/);
  });

  it("a legacy finding without an observation is graded on the principle vs the screen", () => {
    expect(describeCandidate({ key: "x", principle: "Error prevention", controls: [], quotes: [] })).toMatch(/no observation was given/);
  });
});

describe("quality policy", () => {
  it("#133: the default shows every grade — the uncalibrated grader labels, it does not filter", () => {
    expect(resolveQualityPolicy(undefined, {})).toEqual(DEFAULT_QUALITY_POLICY);
    expect(DEFAULT_QUALITY_POLICY.show).toEqual(["actionable", "relevant-minor", "generic", "wrong"]);
    expect(policyFilters(DEFAULT_QUALITY_POLICY)).toBe(false);
    // "consumer" has only single-app evidence with a held-out kappa of 0.15 < 0.4: still no default filtering.
    expect(resolveQualityPolicy(undefined, {}, undefined, "consumer")).toEqual(DEFAULT_QUALITY_POLICY);
    expect(defaultQualityPolicy("admin")).toEqual(DEFAULT_QUALITY_POLICY);
  });
  it("the filter stays an opt-in", () => {
    expect(resolveQualityPolicy("actionable,relevant-minor", {}, undefined, "consumer")).toEqual(CALIBRATED_QUALITY_POLICY);
    expect(policyFilters(CALIBRATED_QUALITY_POLICY)).toBe(true);
  });
  it("precedence: flag > env > config > default", () => {
    expect(resolveQualityPolicy("actionable", { JEVITATE_UX_SHOW: "wrong" }, ["generic"]).show).toEqual(["actionable"]);
    expect(resolveQualityPolicy(undefined, { JEVITATE_UX_SHOW: "wrong,generic" }, ["generic"]).show).toEqual(["wrong", "generic"]);
    expect(resolveQualityPolicy(undefined, {}, ["generic"]).show).toEqual(["generic"]);
  });
  it("unknown labels throw", () => {
    expect(() => parseQualityPolicy("actionable,great", "--show")).toThrow(QualityPolicyError);
    expect(() => parseQualityPolicy("", "--show")).toThrow(QualityPolicyError);
  });
});
