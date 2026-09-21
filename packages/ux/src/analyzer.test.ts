import { describe, expect, it, vi } from "vitest";
import type { Answer, JudgmentPort } from "@jevitate/ai-core";
import { UxAnalyzer, MissingAppContextError } from "./analyzer.js";
import { loadRubric } from "./rubric/schema.js";
import { questionKey } from "./judge.js";
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

describe("UxAnalyzer", () => {
  it("refuses to run without appContext (constraint #5)", async () => {
    const analyzer = new UxAnalyzer({ judge: { systemOne: vi.fn() } });
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
    const analyzer = new UxAnalyzer({ judge });
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
    const analyzer = new UxAnalyzer({ judge });
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
    const analyzer = new UxAnalyzer({ judge: { systemOne } });
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

  it("(d) a positive judgment produces a finding via makeFinding with resolved refs + attention label", async () => {
    const judge: JudgmentPort = {
      systemOne: async (args) => {
        const out: Record<string, Answer> = {};
        // value:false triggers primary-action's noul-false flag → a finding
        out[questionKey("primary-action", "unambiguous")] = { kind: "noul", value: false, probability: 0.82 };
        void args;
        return out;
      },
    };
    const analyzer = new UxAnalyzer({ judge });
    const outcome = await analyzer.analyze({
      screens: [screen()],
      rubric: loadRubric([primaryAction]),
      appContext,
      judgmentBudget: 10,
    });
    expect(outcome.kind).toBe("analyzed");
    if (outcome.kind !== "analyzed") return;
    expect(outcome.findings.length).toBe(1);
    const f = outcome.findings[0];
    expect(f.rubricItemId).toBe("primary-action");
    expect(f.severity).toBe("major");
    expect(f.evidenceRefs.length).toBeGreaterThanOrEqual(1);
    expect(f.citation.source).toBe("NN/g");
    expect(f.predictedAttention?.label).toBe("predicted-from-visual-hierarchy");
    expect(outcome.coverage.evaluated).toBe(1);
  });

  it("a positive property (no problem) yields no finding but still counts as evaluated", async () => {
    const judge: JudgmentPort = {
      systemOne: async () => {
        const out: Record<string, Answer> = {};
        out[questionKey("primary-action", "unambiguous")] = { kind: "noul", value: true, probability: 0.9 };
        return out;
      },
    };
    const analyzer = new UxAnalyzer({ judge });
    const outcome = await analyzer.analyze({ screens: [screen()], rubric: loadRubric([primaryAction]), appContext, judgmentBudget: 10 });
    if (outcome.kind !== "analyzed") throw new Error("expected analyzed");
    expect(outcome.findings.length).toBe(0);
    expect(outcome.coverage.evaluated).toBe(1);
  });
});
