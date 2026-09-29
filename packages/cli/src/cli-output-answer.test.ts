import { describe, expect, it } from "vitest";
import { formatMissionHuman } from "./cli-output.js";

/**
 * #216: the human (non --json) summary of a succeeded find-out prints its answer — the result's
 * `answer` is `{ text, evidence }`, never a bare string — and where the answer came from.
 */
describe("a find-out's human summary prints the answer and its source (#216)", () => {
  it("an answer grounded on a form field's value: ANSWER <text> (from form field …)", () => {
    const text = formatMissionHuman({
      strategy: "goal",
      missionOutcome: "succeeded",
      target: { seedUrl: "http://app.test/profile", allowlist: [] },
      defects: [],
      hangs: [],
      answer: {
        text: "ada@example.test",
        evidence: [
          { claim: "The saved email is ada@example.test", quote: "ada@example.test", url: "http://app.test/profile", grounded: true, source: "control-value", control: "Email" },
        ],
      },
      resultPath: "/runs/goal-1.result.json",
    });
    expect(text.split("\n")).toContain('ANSWER  ada@example.test  (from form field "Email" on /profile)');
  });

  it("an answer grounded on page text across pages names each page once", () => {
    const text = formatMissionHuman({
      strategy: "goal",
      missionOutcome: "succeeded",
      target: { seedUrl: "http://app.test/settings", allowlist: [] },
      defects: [],
      hangs: [],
      answer: {
        text: "Pro plan, 1,200 credits left",
        evidence: [
          { claim: "Pro plan", quote: "Plan: Pro", url: "http://app.test/settings", grounded: true, source: "page-text" },
          { claim: "1,200 credits", quote: "Credits left: 1,200", url: "http://app.test/billing?tab=1", grounded: true, source: "page-text" },
          { claim: "Pro", quote: "Pro", url: "http://app.test/settings", grounded: true, source: "page-text" },
        ],
      },
    });
    expect(text.split("\n")).toContain("ANSWER  Pro plan, 1,200 credits left  (from page text on /settings; page text on /billing?tab=1)");
  });
});
