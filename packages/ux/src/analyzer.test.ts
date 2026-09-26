import { describe, expect, it, vi } from "vitest";
import { FakeGenerationGateway, type Answer, type GenerationPort, type JudgmentPort } from "@jevitate/ai-core";
import { UxAnalyzer, MissingAppContextError, evaluateFlag } from "./analyzer.js";
import { loadRubric } from "./rubric/schema.js";
import { APPLIES_QUESTION_ID, questionKey } from "./judge.js";
import type { UxSpecificsItem } from "./specifics.js";
import { UX_PROMPTS } from "./prompts.js";
import type { AppContext, RubricEntry, UxEvidence } from "./types.js";

const appContext: AppContext = { appClass: "consumer-checkout", persona: "first-time buyer" };

function screen(overrides: Partial<UxEvidence> = {}): UxEvidence {
  return {
    screenId: "s1",
    url: "https://app.example.com/checkout",
    controls: [{ index: 0, role: "button", name: "Pay", tag: "button", inputType: null, enabled: true, summary: 'button "Pay"' }],
    visibleText: "Pay for your order.",
    appContext,
    job: "complete checkout",
    history: [],
    behavior: { noProgress: false, backtracks: 0, formReentry: 0, dwellMs: 100, errors: 0 },
    a11yFacts: { controls: [] },
    ...overrides,
  };
}

const primaryAction: RubricEntry = {
  id: "primary-action",
  principle: "Primary action clarity",
  citation: { source: "NN/g", ref: "nngroup" },
  tier: "semantic",
  requiredEvidence: ["controls", "visibleText", "job"],
  attentionProvenance: "predicted-from-visual-hierarchy",
  questions: [{ id: "unambiguous", instruction: "clear?", criteria: "c", kind: "noul", flag: { when: "noul-false" }, severity: "major" }],
};

// Requires behavior signals that a bare screen still has, but needs `history`.
const recognition: RubricEntry = {
  id: "nielsen-6",
  principle: "Recognition rather than recall",
  citation: { source: "NN/g", ref: "nngroup" },
  tier: "semantic",
  requiredEvidence: ["controls", "history"],
  questions: [{ id: "recall", instruction: "recall?", criteria: "c", kind: "noul", flag: { when: "noul-false" }, severity: "minor" }],
};

const gen = new FakeGenerationGateway();

/** A generation port that returns scripted specifics for every flagged item. */
function scriptedGen(make: (rubricItemId: string) => Omit<UxSpecificsItem, "rubricItemId">): GenerationPort & { calls: number } {
  const port = {
    calls: 0,
    async generate(kind: string, input: unknown) {
      port.calls++;
      if (kind !== "ux.specifics") throw new Error(`unexpected task ${kind}`);
      const items = (input as { items: { rubricItemId: string }[] }).items.map((i) => ({ rubricItemId: i.rubricItemId, ...make(i.rubricItemId) }));
      return { output: { items }, provenance: { adapter: "fake", model: "fake", promptVersion: "1", latencyMs: 0, responseHash: "h" } };
    },
  };
  return port as unknown as GenerationPort & { calls: number };
}

/** Jev: primary-action flagged (P(clear)=pClear) and applicability P(applies)=pApplies. */
function flaggingJudge(pClear: number, pApplies: number, grade = "actionable"): JudgmentPort {
  return {
    systemOne: async (args) => {
      const out: Record<string, Answer> = {};
      for (const [k, q] of Object.entries(args.questions)) {
        out[k] =
          q.kind === "choice"
            ? { kind: "choice", value: grade, confidence: 0.8 } // the independent quality grader
            : k.endsWith(`::${APPLIES_QUESTION_ID}`)
              ? { kind: "noul", value: pApplies >= 0.5, probability: pApplies }
              : { kind: "noul", value: pClear >= 0.5, probability: pClear };
      }
      return out;
    },
  };
}

const twoButtons = [
  { index: 0, role: "button", name: "Pay", tag: "button", inputType: null, enabled: true, summary: 'button "Pay"' },
  { index: 1, role: "button", name: "Pay later", tag: "button", inputType: null, enabled: true, summary: 'button "Pay later"' },
];

const grounded = (): Omit<UxSpecificsItem, "rubricItemId"> => ({
  violated: true,
  implicatedControls: [0, 1],
  quotes: ["Pay for your order"],
  observation: 'button "Pay" and button "Pay later" look identical, so the next step toward checkout is ambiguous.',
  userImpact: "A first-time buyer may defer payment by mistake.",
  recommendation: 'Make "Pay" the filled primary button and demote "Pay later" to a text link.',
});

describe("UxAnalyzer", () => {
  it("refuses to run without appContext (constraint #5)", async () => {
    const analyzer = new UxAnalyzer({ judge: { systemOne: vi.fn() }, gen });
    await expect(
      analyzer.analyze({ screens: [screen()], rubric: loadRubric([primaryAction]), appContext: undefined as never, judgmentBudget: 10 }),
    ).rejects.toBeInstanceOf(MissingAppContextError);
  });

  it("(a) an item whose requiredEvidence is absent is Skipped, not a finding", async () => {
    // history is empty → `recognition` (requires history) must be Skipped.
    const judge: JudgmentPort = {
      systemOne: async (args) => {
        const out: Record<string, Answer> = {};
        for (const k of Object.keys(args.questions)) out[k] = { kind: "noul", value: true, probability: 0.9 };
        return out;
      },
    };
    const analyzer = new UxAnalyzer({ judge, gen });
    const outcome = await analyzer.analyze({
      screens: [screen({ history: [] })],
      rubric: loadRubric([primaryAction, recognition]),
      appContext,
      judgmentBudget: 10,
    });
    expect(outcome.kind).toBe("analyzed");
    if (outcome.kind !== "analyzed") return;
    const skipIds = outcome.coverage.skipped.map((s) => s.rubricItemId);
    expect(skipIds).toContain("nielsen-6");
    expect(outcome.findings.some((f) => f.rubricItemId === "nielsen-6")).toBe(false);
    // and the skip carries a human reason naming the missing field
    expect(outcome.coverage.skipped.find((s) => s.rubricItemId === "nielsen-6")!.reason).toMatch(/history/);
  });

  it("(b) a thrown model error becomes `failed`, never `analyzed` with []", async () => {
    const judge: JudgmentPort = {
      systemOne: async () => {
        throw new Error("jev backend exploded");
      },
    };
    const analyzer = new UxAnalyzer({ judge, gen });
    const outcome = await analyzer.analyze({
      screens: [screen()],
      rubric: loadRubric([primaryAction]),
      appContext,
      judgmentBudget: 10,
    });
    expect(outcome.kind).toBe("failed");
    if (outcome.kind !== "failed") return;
    expect(outcome.screenId).toBe("s1");
    expect(outcome.rubricItemId).toBe("primary-action");
    expect(outcome.reason).toMatch(/exploded|judgment/i);
  });

  it("(c) budget exhausted before a screen keeps outcome `analyzed` and records budgetTruncated", async () => {
    const systemOne = vi.fn(async (args: { questions: Record<string, unknown> }) => {
      const out: Record<string, Answer> = {};
      for (const k of Object.keys(args.questions)) out[k] = { kind: "noul", value: true, probability: 0.9 };
      return out;
    });
    const analyzer = new UxAnalyzer({ judge: { systemOne }, gen });
    const outcome = await analyzer.analyze({
      screens: [screen({ screenId: "s1" }), screen({ screenId: "s2" })],
      rubric: loadRubric([primaryAction]),
      appContext,
      judgmentBudget: 1, // only the first screen's batch fits
    });
    expect(outcome.kind).toBe("analyzed");
    if (outcome.kind !== "analyzed") return;
    expect(systemOne).toHaveBeenCalledTimes(1);
    expect(outcome.coverage.budgetTruncated).toContain("s2");
    expect(outcome.coverage.budgetTruncated).not.toContain("s1");
  });

  it("(d) a flagged judgment becomes a SPECIFIC finding: observation, narrowed refs, route, calibrated confidence", async () => {
    const specifics = scriptedGen(() => grounded());
    const analyzer = new UxAnalyzer({ judge: flaggingJudge(0.18, 0.9), gen: specifics });
    const outcome = await analyzer.analyze({
      screens: [screen({ controls: [...twoButtons, { index: 2, role: "link", name: "Help", tag: "a", inputType: null, enabled: true, summary: 'link "Help"' }] })],
      rubric: loadRubric([primaryAction]),
      appContext,
      judgmentBudget: 10,
    });
    expect(outcome.kind).toBe("analyzed");
    if (outcome.kind !== "analyzed") return;
    expect(specifics.calls).toBe(1);
    expect(outcome.findings.length).toBe(1);
    const f = outcome.findings[0]!;
    expect(f.rubricItemId).toBe("primary-action");
    expect(f.severity).toBe("major");
    expect(f.citation.source).toBe("NN/g");
    expect(f.predictedAttention?.label).toBe("predicted-from-visual-hierarchy");
    // Narrowed: only the implicated controls (+ the quoted text), NOT every control on the page.
    expect(f.evidenceRefs.map((r) => r.id)).toEqual(["control:0", "control:1", "visibleText"]);
    expect(f.controls).toEqual(['button "Pay"', 'button "Pay later"']);
    expect(f.quotes).toEqual(["Pay for your order"]);
    expect(f.observation).toContain("Pay later");
    expect(f.recommendation).not.toMatch(/^Address "/);
    expect(f.route).toBe("/checkout");
    expect(f.screenId).toBe("s1");
    expect(f.occurrences).toBe(1);
    // J-1: noul-false violation = 1 − P(clear) = 0.82 (not P(clear)); × applicability 0.9 × grounding 1 × agreement 1.
    expect(f.confidenceBasis).toEqual({ violation: 0.82, applicability: 0.9, grounding: 1, agreement: 1 });
    expect(f.confidence).toBe(0.74);
    expect(outcome.coverage.evaluated).toBe(1);
  });

  it("REJECTS specifics that cite a control absent from the observed screen (independent adjudication)", async () => {
    const analyzer = new UxAnalyzer({ judge: flaggingJudge(0.1, 0.9), gen: scriptedGen(() => ({ ...grounded(), implicatedControls: [0, 7] })) });
    const outcome = await analyzer.analyze({ screens: [screen({ controls: twoButtons })], rubric: loadRubric([primaryAction]), appContext, judgmentBudget: 10 });
    if (outcome.kind !== "analyzed") throw new Error("expected analyzed");
    expect(outcome.findings).toHaveLength(0);
    expect(outcome.suppressed).toEqual([
      expect.objectContaining({ rubricItemId: "primary-action", route: "/checkout", reason: "rejected-evidence", detail: expect.stringContaining("control:7") }),
    ]);
  });

  it("REJECTS specifics that quote text not on the screen", async () => {
    const analyzer = new UxAnalyzer({ judge: flaggingJudge(0.1, 0.9), gen: scriptedGen(() => ({ ...grounded(), quotes: ["Free shipping over $50"] })) });
    const outcome = await analyzer.analyze({ screens: [screen({ controls: twoButtons })], rubric: loadRubric([primaryAction]), appContext, judgmentBudget: 10 });
    if (outcome.kind !== "analyzed") throw new Error("expected analyzed");
    expect(outcome.findings).toHaveLength(0);
    expect(outcome.suppressed?.[0]?.reason).toBe("rejected-evidence");
  });

  it("a judgment that cannot name specific evidence is NOT a finding (suppressed as ungrounded, counted)", async () => {
    const analyzer = new UxAnalyzer({
      judge: flaggingJudge(0.1, 0.9),
      gen: scriptedGen(() => ({ ...grounded(), implicatedControls: [], quotes: [], observation: "The screen could be clearer." })),
    });
    const outcome = await analyzer.analyze({ screens: [screen({ controls: twoButtons })], rubric: loadRubric([primaryAction]), appContext, judgmentBudget: 10 });
    if (outcome.kind !== "analyzed") throw new Error("expected analyzed");
    expect(outcome.findings).toHaveLength(0);
    expect(outcome.suppressed?.[0]).toMatchObject({ reason: "ungrounded", rubricItemId: "primary-action" });
    expect(outcome.rawOccurrences).toBe(1);
  });

  it("the specifics step can refute Jev (violated=false) — suppressed as not-confirmed", async () => {
    const analyzer = new UxAnalyzer({ judge: flaggingJudge(0.1, 0.9), gen: scriptedGen(() => ({ ...grounded(), violated: false })) });
    const outcome = await analyzer.analyze({ screens: [screen({ controls: twoButtons })], rubric: loadRubric([primaryAction]), appContext, judgmentBudget: 10 });
    if (outcome.kind !== "analyzed") throw new Error("expected analyzed");
    expect(outcome.findings).toHaveLength(0);
    expect(outcome.suppressed?.[0]?.reason).toBe("not-confirmed");
  });

  it("a near-coin-flip violation (below the asset's minViolation margin) is counted, never sent for specifics", async () => {
    const specifics = scriptedGen(() => grounded());
    const analyzer = new UxAnalyzer({ judge: flaggingJudge(0.45, 0.9), gen: specifics });
    const saved = UX_PROMPTS.thresholds.minViolation;
    UX_PROMPTS.thresholds.minViolation = 0.6; // the shipped asset may disable the margin (0); exercise the mechanism
    const outcome = await analyzer
      .analyze({ screens: [screen({ controls: twoButtons })], rubric: loadRubric([primaryAction]), appContext, judgmentBudget: 10 })
      .finally(() => {
        UX_PROMPTS.thresholds.minViolation = saved;
      });
    if (outcome.kind !== "analyzed") throw new Error("expected analyzed");
    expect(specifics.calls).toBe(0);
    expect(outcome.findings).toHaveLength(0);
    expect(outcome.suppressed?.[0]).toMatchObject({ reason: "not-confirmed", detail: expect.stringContaining("margin") });
  });

  it("a heuristic Jev judges inapplicable to the screen cannot score high", async () => {
    const analyzer = new UxAnalyzer({ judge: flaggingJudge(0.01, 0.1), gen: scriptedGen(() => grounded()) });
    const outcome = await analyzer.analyze({ screens: [screen({ controls: twoButtons })], rubric: loadRubric([primaryAction]), appContext, judgmentBudget: 10 });
    if (outcome.kind !== "analyzed") throw new Error("expected analyzed");
    expect(outcome.findings[0]?.confidence).toBeLessThanOrEqual(0.1);
  });

  it("the deterministic applicability gate: choice overload on a 2-control screen is never judged (notApplicable, still evaluated)", async () => {
    const overload: RubricEntry = {
      id: "cognitive-load",
      principle: "Choice overload",
      citation: { source: "Hick", ref: "lawsofux.com/hicks-law" },
      tier: "semantic",
      requiredEvidence: ["controls", "job"],
      applicability: { minControls: 6 },
      questions: [{ id: "burden", instruction: "burden?", criteria: "c", kind: "score", flag: { when: "score-below", threshold: 0.5 }, severity: "minor" }],
    };
    const systemOne = vi.fn(async () => ({}) as Record<string, Answer>);
    const analyzer = new UxAnalyzer({ judge: { systemOne }, gen });
    const outcome = await analyzer.analyze({ screens: [screen({ controls: twoButtons })], rubric: loadRubric([overload]), appContext, judgmentBudget: 10 });
    if (outcome.kind !== "analyzed") throw new Error("expected analyzed");
    expect(systemOne).not.toHaveBeenCalled();
    expect(outcome.findings).toHaveLength(0);
    expect(outcome.coverage.notApplicable?.[0]?.reason).toMatch(/2 control\(s\) < 6/);
    expect(outcome.coverage.evaluated).toBe(1);
    expect(outcome.coverage.skipped).toHaveLength(0);
  });

  it("dedupes the same item × route × controls into ONE finding with an occurrence count; agreement discounts states that did not flag", async () => {
    let call = 0;
    const judge: JudgmentPort = {
      systemOne: async (args) => {
        const out: Record<string, Answer> = {};
        const isGrader = Object.values(args.questions).some((q) => q.kind === "choice");
        if (!isGrader) call++;
        for (const [k, q] of Object.entries(args.questions)) {
          if (q.kind === "choice") {
            out[k] = { kind: "choice", value: "relevant-minor", confidence: 0.7 };
            continue;
          }
          out[k] = k.endsWith(`::${APPLIES_QUESTION_ID}`)
            ? { kind: "noul", value: true, probability: 1 }
            : // 3 of the 4 states on /checkout flag it (P(clear)=0), the 4th passes.
              { kind: "noul", value: call === 4, probability: call === 4 ? 0.9 : 0 };
        }
        return out;
      },
    };
    const analyzer = new UxAnalyzer({ judge, gen: scriptedGen(() => grounded()) });
    const screens = [1, 2, 3, 4].map((i) => screen({ screenId: `s${i}`, url: `https://app.example.com/checkout?step=${i}`, controls: twoButtons }));
    const outcome = await analyzer.analyze({ screens, rubric: loadRubric([primaryAction]), appContext, judgmentBudget: 10 });
    if (outcome.kind !== "analyzed") throw new Error("expected analyzed");
    expect(outcome.rawOccurrences).toBe(3);
    expect(outcome.findings).toHaveLength(1);
    const f = outcome.findings[0]!;
    expect(f.occurrences).toBe(3);
    expect(f.screenIds).toEqual(["s1", "s2", "s3"]);
    expect(f.confidenceBasis?.agreement).toBe(0.75);
    expect(f.confidence).toBe(0.75);
    expect(f.quality).toEqual({ label: "relevant-minor", confidence: 0.7 });
  });

  it("the quality grade is a SEPARATE Jev request (own question/criteria), recorded on the finding", async () => {
    const requests: string[][] = [];
    const base = flaggingJudge(0.1, 0.9, "generic");
    const judge: JudgmentPort = {
      systemOne: async (args) => {
        requests.push(Object.keys(args.questions));
        return base.systemOne(args);
      },
    };
    const analyzer = new UxAnalyzer({ judge, gen: scriptedGen(() => grounded()) });
    const outcome = await analyzer.analyze({ screens: [screen({ controls: twoButtons })], rubric: loadRubric([primaryAction]), appContext, judgmentBudget: 10 });
    if (outcome.kind !== "analyzed") throw new Error("expected analyzed");
    expect(requests).toHaveLength(2);
    expect(requests[1]).toEqual(["grade::0"]);
    expect(requests[0]).not.toContain("grade::0");
    expect(outcome.findings[0]?.quality?.label).toBe("generic");
  });

  it("occurrences citing OVERLAPPING controls on the same route merge into one finding (no near-duplicates)", async () => {
    let n = 0;
    const gen = scriptedGen(() => ({ ...grounded(), implicatedControls: n++ === 0 ? [0, 1] : [0] }));
    const analyzer = new UxAnalyzer({ judge: flaggingJudge(0.1, 0.9), gen });
    const screens = [1, 2].map((i) => screen({ screenId: `s${i}`, url: `https://app.example.com/checkout#${i}`, controls: twoButtons }));
    const outcome = await analyzer.analyze({ screens, rubric: loadRubric([primaryAction]), appContext, judgmentBudget: 10 });
    if (outcome.kind !== "analyzed") throw new Error("expected analyzed");
    expect(outcome.findings).toHaveLength(1);
    expect(outcome.findings[0]?.occurrences).toBe(2);
    expect(outcome.findings[0]?.confidenceBasis?.agreement).toBe(1);
  });

  describe("0.2.0 (#198 interim): grouping findings by control — several rubric items on ONE control collapse", () => {
    const nielsen1: RubricEntry = {
      id: "nielsen-1",
      principle: "Visibility of system status",
      citation: { source: "NN/g", ref: "n1" },
      tier: "semantic",
      requiredEvidence: ["controls", "visibleText", "job"],
      questions: [{ id: "q", instruction: "clear?", criteria: "c", kind: "noul", flag: { when: "noul-false" }, severity: "major" }],
    };
    const nielsen2: RubricEntry = { ...nielsen1, id: "nielsen-2", principle: "Match with the real world", citation: { source: "NN/g", ref: "n2" } };
    const nielsen3: RubricEntry = { ...nielsen1, id: "nielsen-3", principle: "User control and freedom", citation: { source: "NN/g", ref: "n3" } };

    /** Every entry's own question flags (noul-false), with a per-entry violation probability; applicability always 1. */
    function multiEntryJudge(violationByEntry: Record<string, number>): JudgmentPort {
      return {
        systemOne: async (args) => {
          const out: Record<string, Answer> = {};
          for (const [k, q] of Object.entries(args.questions)) {
            if (q.kind === "choice") {
              out[k] = { kind: "choice", value: "actionable", confidence: 0.8 };
              continue;
            }
            const [entryId, qid] = k.split("::");
            out[k] =
              qid === APPLIES_QUESTION_ID
                ? { kind: "noul", value: true, probability: 1 }
                : { kind: "noul", value: false, probability: 1 - (violationByEntry[entryId!] ?? 0) };
          }
          return out;
        },
      };
    }

    it("the SAME control firing on 7 (here: 3) rubric items becomes ONE finding, listing every citation, led by the highest confidence", async () => {
      // Highest violation probability (and so highest confidence) on nielsen-1.
      const judge = multiEntryJudge({ "nielsen-1": 0.95, "nielsen-2": 0.5, "nielsen-3": 0.2 });
      const gen = scriptedGen((id) => ({
        violated: true,
        implicatedControls: [0], // the SAME single control ("Pay") for every rubric item
        quotes: ["Pay for your order"],
        observation: `${id}: button "Pay" is unclear on this screen`,
        userImpact: "a buyer may hesitate at checkout",
        recommendation: 'make "Pay" the clear next step',
      }));
      const analyzer = new UxAnalyzer({ judge, gen });
      const outcome = await analyzer.analyze({ screens: [screen()], rubric: loadRubric([nielsen1, nielsen2, nielsen3]), appContext, judgmentBudget: 10 });
      if (outcome.kind !== "analyzed") throw new Error("expected analyzed");
      expect(outcome.findings).toHaveLength(1);
      const f = outcome.findings[0]!;
      expect(f.rubricItemId).toBe("nielsen-1");
      expect(f.contributing?.map((c) => c.rubricItemId).sort()).toEqual(["nielsen-2", "nielsen-3"]);
      // every citation is kept, not just the lead's
      expect(f.citation).toEqual({ source: "NN/g", ref: "n1" });
      expect(f.contributing?.find((c) => c.rubricItemId === "nielsen-2")?.citation).toEqual({ source: "NN/g", ref: "n2" });
      expect(f.contributing?.find((c) => c.rubricItemId === "nielsen-3")?.citation).toEqual({ source: "NN/g", ref: "n3" });
      expect(f.contributing?.every((c) => c.occurrences === 1)).toBe(true);
    });

    it("different rubric items on DIFFERENT controls on the same route stay separate findings", async () => {
      const judge = multiEntryJudge({ "nielsen-1": 0.9, "nielsen-2": 0.9 });
      const gen = scriptedGen((id) => ({
        violated: true,
        implicatedControls: id === "nielsen-1" ? [0] : [1],
        quotes: [],
        observation: `${id}: this control is a problem`,
        userImpact: "confusing",
        recommendation: "fix it",
      }));
      const analyzer = new UxAnalyzer({ judge, gen });
      const outcome = await analyzer.analyze({ screens: [screen({ controls: twoButtons })], rubric: loadRubric([nielsen1, nielsen2]), appContext, judgmentBudget: 10 });
      if (outcome.kind !== "analyzed") throw new Error("expected analyzed");
      expect(outcome.findings).toHaveLength(2);
      expect(outcome.findings.map((f) => f.rubricItemId).sort()).toEqual(["nielsen-1", "nielsen-2"]);
      expect(outcome.findings.every((f) => f.contributing === undefined)).toBe(true);
    });
  });

  it("a specifics-generation error becomes `failed`, never a silent empty result", async () => {
    const broken: GenerationPort = { generate: async () => { throw new Error("openrouter down"); } };
    const analyzer = new UxAnalyzer({ judge: flaggingJudge(0.1, 0.9), gen: broken });
    const outcome = await analyzer.analyze({ screens: [screen({ controls: twoButtons })], rubric: loadRubric([primaryAction]), appContext, judgmentBudget: 10 });
    expect(outcome).toMatchObject({ kind: "failed", screenId: "s1", rubricItemId: "primary-action" });
  });

  it("(#85) a vocabulary-sensitive finding whose quote matches a value the run itself typed is suppressed, not reported", async () => {
    const vocab: RubricEntry = {
      id: "nielsen-2",
      principle: "Match between system and the real world",
      citation: { source: "NN/g", ref: "nngroup" },
      tier: "semantic",
      requiredEvidence: ["controls", "visibleText"],
      vocabularySensitive: true,
      questions: [{ id: "real-world-language", instruction: "jargon?", criteria: "c", kind: "noul", flag: { when: "noul-false" }, severity: "minor" }],
    };
    const analyzer = new UxAnalyzer({
      judge: flaggingJudge(0.1, 0.9),
      gen: scriptedGen(() => ({ ...grounded(), quotes: ["Jevitate CLI"], implicatedControls: [] })),
    });
    const outcome = await analyzer.analyze({
      screens: [screen({ controls: twoButtons, visibleText: "Jevitate CLI\nPay for your order.", typedValues: ["Jevitate CLI"] })],
      rubric: loadRubric([vocab]),
      appContext,
      judgmentBudget: 10,
    });
    if (outcome.kind !== "analyzed") throw new Error("expected analyzed");
    expect(outcome.findings).toHaveLength(0);
    expect(outcome.suppressed?.[0]).toMatchObject({ rubricItemId: "nielsen-2", reason: "user-authored-content" });
  });

  it("(#85) a vocabulary-sensitive finding whose quote does NOT match anything typed is still reported", async () => {
    const vocab: RubricEntry = {
      id: "nielsen-2",
      principle: "Match between system and the real world",
      citation: { source: "NN/g", ref: "nngroup" },
      tier: "semantic",
      requiredEvidence: ["controls", "visibleText"],
      vocabularySensitive: true,
      questions: [{ id: "real-world-language", instruction: "jargon?", criteria: "c", kind: "noul", flag: { when: "noul-false" }, severity: "minor" }],
    };
    const analyzer = new UxAnalyzer({
      judge: flaggingJudge(0.1, 0.9),
      gen: scriptedGen(() => ({ ...grounded(), quotes: ["Pay for your order"], implicatedControls: [] })),
    });
    const outcome = await analyzer.analyze({
      screens: [screen({ controls: twoButtons, visibleText: "Pay for your order.", typedValues: ["Jevitate CLI"] })],
      rubric: loadRubric([vocab]),
      appContext,
      judgmentBudget: 10,
    });
    if (outcome.kind !== "analyzed") throw new Error("expected analyzed");
    expect(outcome.findings).toHaveLength(1);
  });

  it("a positive property (no problem) yields no finding but still counts as evaluated", async () => {
    const judge: JudgmentPort = {
      systemOne: async () => {
        const out: Record<string, Answer> = {};
        out[questionKey("primary-action", "unambiguous")] = { kind: "noul", value: true, probability: 0.9 };
        return out;
      },
    };
    const analyzer = new UxAnalyzer({ judge, gen });
    const outcome = await analyzer.analyze({ screens: [screen()], rubric: loadRubric([primaryAction]), appContext, judgmentBudget: 10 });
    if (outcome.kind !== "analyzed") throw new Error("expected analyzed");
    expect(outcome.findings.length).toBe(0);
    expect(outcome.coverage.evaluated).toBe(1);
  });
});

describe("evaluateFlag — violation probability is oriented by the flag rule (J-1)", () => {
  it("noul-false: a noul's probability is P(true), so the violation probability is 1 − P(true)", () => {
    expect(evaluateFlag({ when: "noul-false" }, { kind: "noul", value: false, probability: 0.1 })).toEqual({ triggered: true, violation: 0.9 });
  });
  it("noul-true: violation = P(true)", () => {
    expect(evaluateFlag({ when: "noul-true" }, { kind: "noul", value: true, probability: 0.8 })).toEqual({ triggered: true, violation: 0.8 });
  });
  it("score-below: violation is the margin below the threshold, normalized", () => {
    expect(evaluateFlag({ when: "score-below", threshold: 0.5 }, { kind: "score", value: 0.25 })).toEqual({ triggered: true, violation: 0.5 });
    expect(evaluateFlag({ when: "score-below", threshold: 0.5 }, { kind: "score", value: 0.6 }).triggered).toBe(false);
  });
});
