import { describe, expect, it } from "vitest";
import { a11yChecks } from "./a11y.js";
import { redactEvidence } from "./redact.js";
import { loadV1Rubric } from "./rubric/v1/index.js";
import type { A11yControlFact, UxEvidence } from "./types.js";

const rubric = loadV1Rubric();

function evidenceWith(facts: A11yControlFact[], controlCount = facts.length): UxEvidence {
  return {
    screenId: "s1",
    url: "https://app.example.com",
    controls: Array.from({ length: controlCount }, (_, i) => ({
      index: i,
      role: "button",
      name: `Control ${i}`,
      tag: "button",
      inputType: null,
      enabled: true,
      summary: `button "Control ${i}"`,
    })),
    visibleText: "screen",
    appContext: { appClass: "admin-tool" },
    history: [],
    behavior: { noProgress: false, backtracks: 0, formReentry: 0, dwellMs: 1, errors: 0 },
    a11yFacts: { controls: facts },
  };
}

describe("a11yChecks (objective, honest)", () => {
  it("a control missing a name yields a finding", () => {
    const redacted = redactEvidence(
      evidenceWith([
        { controlRef: "control:0", accessibleName: null, focusOrder: 0, targetSize: { width: 40, height: 40 }, contrastRatio: 7 },
        { controlRef: "control:1", accessibleName: "Save", focusOrder: 1, targetSize: { width: 40, height: 40 }, contrastRatio: 7 },
      ]),
      [],
    );
    const res = a11yChecks(redacted, rubric);
    expect(res.findings.some((f) => f.rubricItemId === "a11y-control-name")).toBe(true);
    expect(res.checked).toContain("control-name");
  });

  it("reports contrast as notChecked when it is not computable, never assumed passing", () => {
    const redacted = redactEvidence(
      evidenceWith([
        { controlRef: "control:0", accessibleName: "Save", focusOrder: 0, targetSize: { width: 40, height: 40 }, contrastRatio: null },
      ]),
      [],
    );
    const res = a11yChecks(redacted, rubric);
    expect(res.notChecked).toContain("contrast");
    expect(res.checked).not.toContain("contrast");
    expect(res.findings.some((f) => f.rubricItemId === "a11y-contrast")).toBe(false);
  });

  it("flags an undersized target and a low-contrast control", () => {
    const redacted = redactEvidence(
      evidenceWith([
        { controlRef: "control:0", accessibleName: "Tiny", focusOrder: 0, targetSize: { width: 10, height: 10 }, contrastRatio: 2.1 },
      ]),
      [],
    );
    const res = a11yChecks(redacted, rubric);
    expect(res.findings.some((f) => f.rubricItemId === "a11y-target-size")).toBe(true);
    expect(res.findings.some((f) => f.rubricItemId === "a11y-contrast")).toBe(true);
  });

  it("HONEST LABELING: output never claims 'accessible' or 'WCAG-compliant'", () => {
    const redacted = redactEvidence(
      evidenceWith([
        { controlRef: "control:0", accessibleName: "Save", focusOrder: 0, targetSize: { width: 40, height: 40 }, contrastRatio: 7 },
      ]),
      [],
    );
    const res = a11yChecks(redacted, rubric);
    const serialized = JSON.stringify(res).toLowerCase();
    expect(serialized).not.toContain("accessible");
    expect(serialized).not.toContain("wcag-compliant");
  });

  it("all findings are constructed via the finding gate (carry a resolved citation)", () => {
    const redacted = redactEvidence(
      evidenceWith([{ controlRef: "control:0", accessibleName: null, focusOrder: 0, targetSize: null, contrastRatio: null }]),
      [],
    );
    const res = a11yChecks(redacted, rubric);
    for (const f of res.findings) {
      expect(f.citation.ref.length).toBeGreaterThan(0);
      expect(f.evidenceRefs.length).toBeGreaterThanOrEqual(1);
    }
  });
});
