import { describe, it, expect } from "vitest";
import {
  GTWR_RULES,
  checkJobStory,
  checkPersona,
  checkStatement,
  renderJobStory,
  type GtwrCharacteristic,
} from "./index.js";

// #434: the mechanical INCOSE GtWR writing-rule checks for job stories and persona definitions.

const CLEAN = { trigger: "my invoice is overdue", motivation: "pay it from the reminder email", outcome: "avoid a late fee" };

describe("#434 renderJobStory", () => {
  it("produces the exact job-story template", () => {
    expect(renderJobStory({ trigger: "an invoice is overdue", motivation: "pay it", outcome: "avoid a late fee" })).toBe(
      "When an invoice is overdue, I want to pay it, so I can avoid a late fee.",
    );
  });

  it("strips duplicated prefixes and a trailing outcome period", () => {
    expect(
      renderJobStory({ trigger: "When my invoice is overdue", motivation: "I want to pay it", outcome: "So I can avoid a late fee." }),
    ).toBe("When my invoice is overdue, I want to pay it, so I can avoid a late fee.");
  });
});

describe("#434 checkStatement rules", () => {
  it("fires gtwr:vague-term on a vague term", () => {
    expect(checkStatement("The UI must be user-friendly", "outcome").some((f) => f.ruleId === "gtwr:vague-term")).toBe(true);
  });

  it("fires gtwr:escape-clause on an escape clause", () => {
    expect(checkStatement("Pay it if possible", "outcome").some((f) => f.ruleId === "gtwr:escape-clause")).toBe(true);
  });

  it("fires gtwr:combinator on and/or", () => {
    expect(checkStatement("Export and/or print it", "outcome").some((f) => f.ruleId === "gtwr:combinator")).toBe(true);
  });

  it("fires gtwr:open-ended on a trailing etc", () => {
    expect(checkStatement("Export CSV, PDF, etc.", "outcome").some((f) => f.ruleId === "gtwr:open-ended")).toBe(true);
  });

  it("fires gtwr:absolute on an absolute term", () => {
    expect(checkStatement("Always send a reminder", "outcome").some((f) => f.ruleId === "gtwr:absolute")).toBe(true);
  });

  it("fires gtwr:negative on a negated outcome", () => {
    expect(checkStatement("do not send a duplicate", "outcome").some((f) => f.ruleId === "gtwr:negative")).toBe(true);
  });

  it("fires gtwr:pronoun-reference on an outcome starting with a bare pronoun", () => {
    expect(checkStatement("it pays the invoice", "outcome").some((f) => f.ruleId === "gtwr:pronoun-reference")).toBe(true);
  });

  it("fires gtwr:empty-field for a missing required field", () => {
    expect(checkJobStory({ trigger: "t", motivation: "m" }).some((f) => f.ruleId === "gtwr:empty-field")).toBe(true);
  });

  it("fires gtwr:too-long on a field over 300 chars", () => {
    expect(checkStatement("a ".repeat(200).trim(), "motivation").some((f) => f.ruleId === "gtwr:too-long")).toBe(true);
  });

  it("fires gtwr:multiple-outcomes on a semicolon", () => {
    expect(checkStatement("pay it; avoid a fee", "outcome").some((f) => f.ruleId === "gtwr:multiple-outcomes")).toBe(true);
  });
});

describe("#434 job-story specific rules", () => {
  it("fires gtwr:trigger-is-persona when the trigger starts as a user story", () => {
    expect(checkJobStory({ trigger: "As a buyer", motivation: "pay it", outcome: "avoid a late fee" }).some((f) => f.ruleId === "gtwr:trigger-is-persona")).toBe(true);
  });

  it("fires gtwr:outcome-is-feature when the outcome describes a control", () => {
    expect(checkJobStory({ trigger: "an invoice is overdue", motivation: "pay it", outcome: "use the pay button" }).some((f) => f.ruleId === "gtwr:outcome-is-feature")).toBe(true);
  });
});

describe("#434 result shape and selection", () => {
  it("reports a missing outcome as a fail finding on the outcome field", () => {
    expect(checkJobStory({ trigger: "t", motivation: "m" }).some((f) => f.field === "outcome" && f.severity === "fail")).toBe(true);
  });

  it("fails a blank persona description", () => {
    expect(checkPersona({ description: "  " }).some((f) => f.severity === "fail" && f.field === "description")).toBe(true);
  });

  it("reports etc only as open-ended, not vague-term", () => {
    expect(checkStatement("Export CSV, PDF, etc.", "outcome").map((f) => f.ruleId).filter((id) => id.startsWith("gtwr:"))).toEqual(["gtwr:open-ended"]);
  });

  it("does not treat a word-boundary suffix as a vague term", () => {
    expect(checkStatement("The fastener holds", "motivation").some((f) => f.ruleId === "gtwr:vague-term")).toBe(false);
  });

  it("returns no findings for a clean job story", () => {
    expect(checkJobStory(CLEAN)).toEqual([]);
  });

  it("sorts findings by field, ruleId and match", () => {
    const findings = checkJobStory({ trigger: "As a user", motivation: "be fast and easy", outcome: "" });
    const keys = findings.map((f) => `${f.field}\u0000${f.ruleId}\u0000${f.match ?? ""}`);
    expect(keys).toEqual([...keys].sort());
  });
});

describe("#434 GTWR_RULES catalog", () => {
  it("lists every rule id the checker can emit", () => {
    expect([...GTWR_RULES].map((r) => r.id).sort()).toEqual(
      [
        "gtwr:absolute",
        "gtwr:combinator",
        "gtwr:empty-field",
        "gtwr:escape-clause",
        "gtwr:multiple-outcomes",
        "gtwr:negative",
        "gtwr:open-ended",
        "gtwr:outcome-is-feature",
        "gtwr:pronoun-reference",
        "gtwr:too-long",
        "gtwr:trigger-is-persona",
        "gtwr:vague-term",
      ].sort(),
    );
  });

  it("assigns a valid GtWR characteristic to every rule", () => {
    const valid: readonly GtwrCharacteristic[] = ["necessary", "appropriate", "unambiguous", "complete", "singular", "feasible", "verifiable", "correct", "conforming"];
    expect(GTWR_RULES.every((r) => valid.includes(r.characteristic))).toBe(true);
  });
});
