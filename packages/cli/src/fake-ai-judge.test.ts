import { describe, expect, it } from "vitest";
import type { Answer, JudgmentState, Question } from "@jevitate/ai-core";
import { decide, judgeGoalCompletion, TARGET_FREE_ACTIONS, type Control, type Snapshot } from "@jevitate/explore";
import { V1_RUBRIC, gradeCandidates, judgeScreen, redactEvidence, type GradeCandidate, type UxEvidence } from "@jevitate/ux";
import { fakeDoneJudge } from "./program.js";

/**
 * #213: `--fake-ai`'s judge must be TOTAL — it answers every question shape the product actually
 * asks, whatever the mission or rubric names it, and never throws. Before the fix, a "choice"
 * question that did not offer `done` (the UX quality grader's label set, `grade::0`) crashed with
 * "fake judge: question 'grade::0' does not offer 'done'". This walks every real question-building
 * path the product defines — the goal/coverage decision loop, goal completion, the full v1 UX
 * rubric (noul + score families) and the quality grader (a choice family without `done`) — plus a
 * property-style check over arbitrary choice/noul/score shapes, so a new question family cannot
 * silently reintroduce the crash.
 */

function control(index: number, name: string, role = "button"): Control {
  return {
    index,
    descriptor: { role, name },
    stability: "high",
    role,
    name,
    tag: role === "textbox" ? "input" : "button",
    inputType: role === "textbox" ? "text" : null,
    enabled: true,
    summary: `${role} "${name}"`,
  };
}

const snap: Snapshot = {
  url: "http://127.0.0.1:3000/app",
  controls: [control(0, "Username", "textbox"), control(1, "Sign in")],
  truncated: false,
  signature: "sig",
};

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

describe("fakeDoneJudge — total over every question shape the product asks (#213)", () => {
  it("always offers `done` among the goal/coverage loop's action choices, and TARGET_FREE_ACTIONS keeps it there", async () => {
    // The fake judge's `done`-picking behavior (a pipeline smoke that will not drive to a goal, per
    // its own docstring) depends on `done` always being offered — proved directly, not assumed.
    expect(TARGET_FREE_ACTIONS.some((a) => a.op === "done")).toBe(true);
    const judge = fakeDoneJudge();
    const d = await decide(judge, { goal: "sign in", snapshot: snap, history: [] });
    expect(d.op).toBe("done");
    expect(d.control).toBeNull();
  });

  it("answers judgeGoalCompletion's noul questions (goal-met, sign-in, save) without throwing", async () => {
    const judge = fakeDoneJudge();
    const r = await judgeGoalCompletion(judge, {
      goal: "sign in",
      url: "https://app.example.com/",
      pageText: "welcome",
      history: [],
      signInFacts: "typed a password field",
      saveFacts: "submitted a form",
    });
    expect(r).toEqual({ goalMet: 0, goalIsSignIn: 0, goalIsSave: 0 });
  });

  it("answers every real v1 rubric question (noul + score families) without throwing", async () => {
    const judge = fakeDoneJudge();
    const redacted = redactEvidence(evidence, []);
    const answers = await judgeScreen(judge, redacted, V1_RUBRIC);
    const kinds = new Set(V1_RUBRIC.flatMap((e) => e.questions.map((q) => q.kind)));
    expect(kinds.size).toBeGreaterThan(1); // the rubric really does mix noul and score
    expect(Object.keys(answers).length).toBeGreaterThan(0);
    for (const a of Object.values(answers)) expect(["noul", "score"]).toContain(a.kind);
  });

  it("#213 repro: answers the quality grader's choice question (no `done` among its options) without throwing", async () => {
    const judge = fakeDoneJudge();
    const redacted = redactEvidence(evidence, []);
    const candidate: GradeCandidate = {
      key: "finding-1",
      principle: "Visibility of system status",
      observation: "no loading indicator",
      controls: [],
      quotes: [],
    };
    const grades = await gradeCandidates(judge, redacted, [candidate]);
    expect(grades.get("finding-1")?.label).toBeDefined();
  });

  it("is total and deterministic over an arbitrary choice question that never offers `done`", async () => {
    const judge = fakeDoneJudge();
    const state: JudgmentState = { goal: "g", url: "https://x/", controls: [], history: [] };
    const q: Question = { kind: "choice", options: ["actionable", "relevant-minor", "generic", "wrong"] };
    const a1 = await judge.systemOne({ state, questions: { grade0: q } });
    const a2 = await judge.systemOne({ state, questions: { grade0: q } });
    expect(a1.grade0).toEqual(a2.grade0);
    const value = (a1.grade0 as Extract<Answer, { kind: "choice" }>).value;
    expect(q.options).toContain(value);
  });

  it("still throws on a genuinely malformed choice (no options at all) — a bug upstream, not an unknown shape", async () => {
    const judge = fakeDoneJudge();
    const state: JudgmentState = { goal: "g", url: "https://x/", controls: [], history: [] };
    const q: Question = { kind: "choice", options: [] };
    await expect(judge.systemOne({ state, questions: { empty: q } })).rejects.toThrow("offers no options");
  });
});
