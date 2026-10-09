import { describe, expect, it } from "vitest";
import { DEFAULT_HEAL_BUDGET, type JourneyRunResult } from "@jevitate/runtime";
import type { Step } from "@jevitate/recording";
import { ChangesArgsError } from "./change-context.js";
import { JourneyHealArgsError, MCP_HEAL_NAMES, journeyHealBudget, journeyRunSummary, journeyStepRisk, validateJourneyHeal } from "./journey-heal.js";

describe("#453 validateJourneyHeal (Q1)", () => {
  it("a heal mode needs --changes and/or --change-note", () => {
    expect(() => validateJourneyHeal({ selfHeal: "hybrid", changeNotes: [] })).toThrow(JourneyHealArgsError);
    expect(() => validateJourneyHeal({ selfHeal: "full", changeNotes: [] })).toThrow(/needs a change context/);
    expect(() => validateJourneyHeal({ selfHeal: "hybrid", changeNotes: ["renamed a to b"] })).not.toThrow();
    expect(() => validateJourneyHeal({ selfHeal: "hybrid", changes: "HEAD~1..HEAD", changeNotes: [] })).not.toThrow();
  });
  it("the change and budget inputs need a heal mode; MCP names its own arguments", () => {
    expect(() => validateJourneyHeal({ selfHeal: "fail-closed", changes: "HEAD~1..HEAD", changeNotes: [] })).toThrow(/--changes needs --self-heal/);
    expect(() => validateJourneyHeal({ selfHeal: "fail-closed", changeNotes: [], maxRunMs: 5 })).toThrow(/--heal-max-\* needs/);
    expect(() => validateJourneyHeal({ selfHeal: "fail-closed", changeNotes: ["x"] }, MCP_HEAL_NAMES)).toThrow(/'changeNote' needs 'selfHeal'/);
    expect(() => validateJourneyHeal({ selfHeal: "fail-closed", changeNotes: [] })).not.toThrow();
  });
  it("refuses a per-run attempt limit below the per-step limit", () => {
    expect(() => validateJourneyHeal({ selfHeal: "hybrid", changeNotes: ["x"], maxRunAttempts: 1 })).toThrow(/--heal-max-run-attempts 1 is below the per-step limit 2/);
  });
  it("refuses a per-run time limit below the per-step limit", () => {
    expect(() => validateJourneyHeal({ selfHeal: "hybrid", changeNotes: ["x"], maxMs: 1_000, maxRunMs: 500 }, MCP_HEAL_NAMES)).toThrow(/'healMaxRunMs' 500 is below/);
  });
  it("an unsafe range is refused by its syntax alone", () => {
    for (const r of ["a;id", "--output=/tmp/x", "a..b..c", "$(id)"]) expect(() => validateJourneyHeal({ selfHeal: "hybrid", changes: r, changeNotes: [] }), r).toThrow(ChangesArgsError);
  });
});

describe("#453 journeyHealBudget", () => {
  it("the defaults, with the given limits; a run limit never below its step limit", () => {
    expect(journeyHealBudget({ selfHeal: "hybrid", changeNotes: [] })).toEqual(DEFAULT_HEAL_BUDGET);
    const b = journeyHealBudget({ selfHeal: "hybrid", changeNotes: [], maxAttempts: 7, maxModelCalls: 20, maxMs: 500, maxRunMs: 900 });
    expect(b.perStep).toEqual({ maxAttempts: 7, maxModelCalls: 20, maxMs: 500 });
    expect(b.perRun).toMatchObject({ maxAttempts: 7, maxModelCalls: 20, maxMs: 900, maxBrokenSteps: DEFAULT_HEAL_BUDGET.perRun.maxBrokenSteps });
    expect(journeyHealBudget({ selfHeal: "hybrid", changeNotes: [], maxAttempts: 1, maxRunAttempts: 1 }).perRun.maxAttempts).toBe(1);
  });
});

describe("#453 journeyStepRisk (Q2)", () => {
  const click = (target: Record<string, string>): Step => ({ kind: "click", target });
  const risk = journeyStepRisk();
  it("a risky name, label or test id is classified; a plain control is not", () => {
    expect(risk(click({ role: "button", name: "Create" }))).toBeNull();
    expect(risk(click({ role: "button", name: "Delete account" }))).toBe("destructive");
    expect(risk(click({ testId: "delete-account" }))).toBe("destructive");
    expect(risk(click({ role: "button", name: "Log out" }))).toBe("session-end");
  });
  it("a control with no readable anchor cannot be classified, so it is treated as risky", () => {
    expect(risk(click({ role: "button" }))).toBe("unclassifiable");
  });
});

describe("#453 journeyRunSummary", () => {
  const before: Step = { kind: "click", target: { role: "button", name: "Create New" } };
  const after: Step = { kind: "click", target: { role: "button", name: "Create" } };
  const pending = {
    outcome: "healed-pending-review",
    output: {},
    revision: { recording: { version: "1", site: "https://x.test", pages: [] }, steps: [{ index: 1, before, after, attempt: 1, hypothesis: "copy 'Create New' → 'Create'", evidence: [] }] },
  } as JourneyRunResult;
  it("a pending revision names the step; next: lines only once a proposal id is on the result", () => {
    const text = journeyRunSummary("j", pending);
    expect(text).toMatch(/healed-pending-review/);
    expect(text).toMatch(/step 2:/);
    expect(text).not.toMatch(/^next:/m);
    const withProposal = journeyRunSummary("j", { ...pending, proposal: { id: "p1" } });
    expect(withProposal).toMatch(/^next: jevitate journey review j$/m);
    expect(withProposal).toMatch(/^next: jevitate journey promote j --proposal p1$/m);
  });
  it("an unexplained break names the step in its reason", () => {
    expect(journeyRunSummary("j", { outcome: "quarantined", reason: 'step 2 failed: x — step 2 "Create New" (click) is not explained by the change', at: 1 })).toMatch(/quarantined — step 2/);
  });
});
