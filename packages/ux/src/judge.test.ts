import { describe, expect, it, vi } from "vitest";
import type { Answer, JudgmentPort, JudgmentState, Question } from "@jevitate/ai-core";
import { judgeScreen, questionKey } from "./judge.js";
import { redactEvidence } from "./redact.js";
import type { RubricEntry, UxEvidence } from "./types.js";

const evidence: UxEvidence = {
  screenId: "s1",
  url: "https://app.example.com/checkout",
  controls: [
    { index: 0, role: "button", name: "Pay now", tag: "button", inputType: null, enabled: true, summary: 'button "Pay now"' },
    { index: 1, role: "link", name: "Cancel", tag: "a", inputType: null, enabled: true, summary: 'link "Cancel"' },
  ],
  visibleText: "Review your order and pay.",
  appContext: { appClass: "consumer-checkout", persona: "first-time buyer" },
  job: "complete checkout",
  history: [{ screenId: "s0", url: "https://app.example.com/cart" }],
  behavior: { noProgress: false, backtracks: 0, formReentry: 0, dwellMs: 1000, errors: 0 },
  a11yFacts: { controls: [] },
};

const entries: RubricEntry[] = [
  {
    id: "primary-action",
    principle: "p",
    citation: { source: "NN/g", ref: "x" },
    tier: "semantic",
    requiredEvidence: ["controls"],
    questions: [{ id: "unambiguous", instruction: "clear next step?", criteria: "c", kind: "noul", flag: { when: "noul-false" }, severity: "major" }],
  },
  {
    id: "scent",
    principle: "p",
    citation: { source: "IFT", ref: "x" },
    tier: "semantic",
    requiredEvidence: ["controls"],
    questions: [{ id: "strength", instruction: "scent?", criteria: "c", kind: "score", flag: { when: "score-below", threshold: 0.6 }, severity: "minor" }],
  },
  {
    id: "dark-patterns",
    principle: "p",
    citation: { source: "Brignull", ref: "x" },
    tier: "semantic",
    requiredEvidence: ["controls"],
    questions: [
      { id: "confirmshaming", instruction: "shame?", criteria: "c", kind: "noul", flag: { when: "noul-true" }, severity: "major" },
      { id: "misdirection", instruction: "misdirect?", criteria: "c", kind: "noul", flag: { when: "noul-true" }, severity: "major" },
    ],
  },
];

describe("judgeScreen (batched)", () => {
  it("sends ALL entries' questions for one screen-state in ONE systemOne call", async () => {
    let receivedQuestions: Record<string, Question> = {};
    const systemOne = vi.fn(async (args: { state: JudgmentState; questions: Record<string, Question> }) => {
      receivedQuestions = args.questions;
      const out: Record<string, Answer> = {};
      for (const k of Object.keys(args.questions)) out[k] = { kind: "noul", value: false, probability: 0.9 } as Answer;
      return out;
    });
    const port: JudgmentPort = { systemOne };
    const redacted = redactEvidence(evidence, []);

    const answers = await judgeScreen(port, redacted, entries);

    expect(systemOne).toHaveBeenCalledTimes(1);
    // 1 + 1 + 2 = 4 questions across 3 entries, all in the single request
    expect(Object.keys(receivedQuestions).length).toBe(4);
    expect(answers[questionKey("primary-action", "unambiguous")]).toBeDefined();
    expect(answers[questionKey("dark-patterns", "misdirection")]).toBeDefined();
  });

  it("maps each question kind to the right Jev primitive", async () => {
    let received: Record<string, Question> = {};
    const port: JudgmentPort = {
      systemOne: async (args) => {
        received = args.questions;
        const out: Record<string, Answer> = {};
        for (const k of Object.keys(args.questions)) {
          const q = args.questions[k];
          out[k] = q.kind === "score" ? { kind: "score", value: 0.5 } : { kind: "noul", value: false, probability: 0.5 };
        }
        return out;
      },
    };
    const redacted = redactEvidence(evidence, []);
    await judgeScreen(port, redacted, entries);
    expect(received[questionKey("scent", "strength")].kind).toBe("score");
    expect(received[questionKey("primary-action", "unambiguous")].kind).toBe("noul");
  });

  it("carries the appContext + job into the judgment state (calibration)", async () => {
    let state: JudgmentState | undefined;
    const port: JudgmentPort = {
      systemOne: async (args) => {
        state = args.state;
        const out: Record<string, Answer> = {};
        for (const k of Object.keys(args.questions)) out[k] = { kind: "noul", value: false, probability: 0.5 };
        return out;
      },
    };
    const redacted = redactEvidence(evidence, []);
    await judgeScreen(port, redacted, entries);
    expect(state?.goal).toContain("complete checkout");
    expect(state?.goal).toContain("consumer-checkout");
  });
});
