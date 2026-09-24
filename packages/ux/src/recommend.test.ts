import { describe, expect, it, vi } from "vitest";
import { FakeGenerationGateway, type GenerationPort } from "@jevitate/ai-core";
import { recommend } from "./recommend.js";
import { redactEvidence } from "./redact.js";
import { makeFinding } from "./finding.js";
import { loadRubric } from "./rubric/schema.js";
import type { RubricEntry, UxEvidence } from "./types.js";

const SECRET = "otp-9931-secret";

const entry: RubricEntry = {
  id: "primary-action",
  principle: "Primary action clarity",
  citation: { source: "Nielsen Norman Group", ref: "nngroup.com/articles/visual-hierarchy-ux-definition" },
  tier: "semantic",
  requiredEvidence: ["controls", "visibleText"],
  questions: [{ id: "unambiguous", instruction: "clear?", criteria: "c", kind: "noul", flag: { when: "noul-false" }, severity: "major" }],
};
const rubric = loadRubric([entry]);

function fixtures() {
  const evidence: UxEvidence = {
    screenId: "s1",
    url: "https://app.example.com/checkout",
    controls: [{ index: 0, role: "button", name: `Pay ${SECRET}`, tag: "button", inputType: null, enabled: true, summary: `button "Pay ${SECRET}"` }],
    visibleText: `Your code is ${SECRET}. Pay now.`,
    appContext: { appClass: "consumer-checkout" },
    job: "complete checkout",
    history: [],
    behavior: { noProgress: false, backtracks: 0, formReentry: 0, dwellMs: 1, errors: 0 },
    a11yFacts: { controls: [] },
  };
  const redacted = redactEvidence(evidence, [SECRET]);
  const finding = makeFinding(
    { rubricItemId: "primary-action", evidenceRefs: [{ id: "control:0" }, { id: "visibleText" }], severity: "major", confidence: 0.8, recommendation: "base", observation: "obs", userImpact: "impact", route: "/checkout", tier: "semantic" },
    rubric,
    redacted,
  );
  return { redacted, finding };
}

describe("recommend (redacted, cited)", () => {
  it("produces a recommendation that includes the citation source", async () => {
    const { redacted, finding } = fixtures();
    const gen = new FakeGenerationGateway();
    const text = await recommend(gen, finding, redacted, [SECRET]);
    expect(text).toContain("Nielsen Norman Group");
  });

  it("the outbound generation payload contains NO declared secret", async () => {
    const { redacted, finding } = fixtures();
    let seenInput: unknown;
    const gen: GenerationPort = {
      generate: vi.fn(async (kind, input) => {
        seenInput = input;
        return { output: { recommendation: "clarify the primary action" }, provenance: { adapter: "fake", model: "fake", promptVersion: "1", latencyMs: 0, responseHash: "h" } } as never;
      }),
    };
    await recommend(gen, finding, redacted, [SECRET]);
    expect(JSON.stringify(seenInput)).not.toContain(SECRET);
    expect(JSON.stringify(seenInput)).toContain("«redacted»");
  });

  it("a generation error propagates (never a silent empty recommendation)", async () => {
    const { redacted, finding } = fixtures();
    const gen: GenerationPort = {
      generate: async () => {
        throw new Error("gen backend down");
      },
    };
    await expect(recommend(gen, finding, redacted, [SECRET])).rejects.toThrow(/gen backend down/);
  });
});
