import { describe, expect, it } from "vitest";
import { buildReport } from "./report.js";
import { DEFAULT_MIN_CONFIDENCE } from "./confidence.js";
import { makeFinding } from "./finding.js";
import { loadRubric } from "./rubric/schema.js";
import type { AnalysisOutcome, Coverage, RubricEntry, UxFinding } from "./types.js";

const entries: RubricEntry[] = [
  { id: "major-1", principle: "P", citation: { source: "S", ref: "r1" }, tier: "semantic", requiredEvidence: ["controls"], attentionProvenance: "predicted-from-visual-hierarchy", questions: [{ id: "q", instruction: "i", criteria: "c", kind: "noul", flag: { when: "noul-false" }, severity: "major" }] },
  { id: "minor-1", principle: "P", citation: { source: "S", ref: "r2" }, tier: "semantic", requiredEvidence: ["controls"], questions: [{ id: "q", instruction: "i", criteria: "c", kind: "noul", flag: { when: "noul-false" }, severity: "minor" }] },
];
const rubric = loadRubric(entries);
const analyzed = { screenId: "s1", refs: new Set(["control:0"]) };

function finding(id: string, severity: UxFinding["severity"], confidence: number, attention = false): UxFinding {
  return makeFinding(
    {
      rubricItemId: id,
      evidenceRefs: [{ id: "control:0" }],
      severity,
      confidence,
      recommendation: "fix it",
      observation: `observation for ${id}`,
      userImpact: "impact",
      route: `/route-${id}`,
      tier: "semantic",
      ...(attention ? { predictedAttention: { label: "predicted-from-visual-hierarchy", note: "inferred, not gaze data" } } : {}),
    },
    rubric,
    analyzed,
  );
}

const fullCoverage: Coverage = { totalItems: 2, evaluated: 2, skipped: [], budgetTruncated: [] };
const partialCoverage: Coverage = {
  totalItems: 4,
  evaluated: 2,
  skipped: [{ rubricItemId: "minor-1", screenId: "s2", reason: "missing required evidence: controls" }],
  budgetTruncated: ["s3"],
};

describe("buildReport", () => {
  it("ranks findings by severity × confidence (major before minor)", () => {
    const outcome: AnalysisOutcome = { kind: "analyzed", findings: [finding("minor-1", "minor", 0.99), finding("major-1", "major", 0.5, true)], coverage: fullCoverage };
    const report = buildReport(outcome, { minConfidence: 0 });
    expect(report.findings[0].rubricItemId).toBe("major-1");
    expect(report.findings[1].rubricItemId).toBe("minor-1");
  });

  it("a report with less than full coverage is not complete and warns prominently", () => {
    const outcome: AnalysisOutcome = { kind: "analyzed", findings: [], coverage: partialCoverage };
    const report = buildReport(outcome);
    expect(report.coverageComplete).toBe(false);
    expect(report.coverageWarning).toBeDefined();
    expect(report.coverageWarning!).toMatch(/coverage|skipped|truncat/i);
  });

  it("a 'clean' verdict is only possible at full coverage with zero findings", () => {
    expect(buildReport({ kind: "analyzed", findings: [], coverage: fullCoverage }).clean).toBe(true);
    // zero findings but partial coverage → NOT clean
    expect(buildReport({ kind: "analyzed", findings: [], coverage: partialCoverage }).clean).toBe(false);
    // full coverage but a finding → NOT clean
    expect(buildReport({ kind: "analyzed", findings: [finding("major-1", "major", 0.5)], coverage: fullCoverage }, { minConfidence: 0 }).clean).toBe(false);
    // full coverage, the only finding suppressed below the cutoff → STILL not clean (suppression ≠ "no issues")
    expect(buildReport({ kind: "analyzed", findings: [finding("major-1", "major", 0.5)], coverage: fullCoverage }, { minConfidence: 0.75 }).clean).toBe(false);
  });

  it("predicted-attention findings keep their provenance label", () => {
    const report = buildReport({ kind: "analyzed", findings: [finding("major-1", "major", 0.9, true)], coverage: fullCoverage });
    expect(report.findings[0].predictedAttention?.label).toBe("predicted-from-visual-hierarchy");
  });

  it("HONEST LABELING: the report never contains 'eye-tracking' or 'gaze' as a verdict field", () => {
    const report = buildReport({ kind: "analyzed", findings: [finding("major-1", "major", 0.9, true)], coverage: fullCoverage });
    // predictedAttention.note is a provenance disclaimer, not a verdict; strip it before scanning verdicts.
    const scrubbed = { ...report, findings: report.findings.map((f) => ({ ...f, predictedAttention: f.predictedAttention?.label })) };
    const text = JSON.stringify(scrubbed).toLowerCase();
    expect(text).not.toContain("eye-tracking");
    expect(text).not.toContain("gaze");
  });

  it("findings below minConfidence are suppressed, counted by reason/item/route, and summarized — never silently dropped", () => {
    const outcome: AnalysisOutcome = {
      kind: "analyzed",
      findings: [finding("major-1", "major", 0.9), finding("minor-1", "minor", 0.4), finding("minor-1", "minor", 0.3)],
      coverage: fullCoverage,
      suppressed: [{ rubricItemId: "major-1", route: "/x", screenId: "s9", reason: "rejected-evidence", detail: "cites control:9 absent" }],
      rawOccurrences: 12,
    };
    const report = buildReport(outcome, { minConfidence: 0.75 });
    expect(report.minConfidence).toBe(0.75);
    expect(report.findings.map((f) => f.rubricItemId)).toEqual(["major-1"]);
    expect(report.suppressed.total).toBe(3);
    expect(report.suppressed.byReason["below-min-confidence"]).toBe(2);
    expect(report.suppressed.byReason["rejected-evidence"]).toBe(1);
    expect(report.suppressed.byRubricItem).toEqual({ "minor-1": 2, "major-1": 1 });
    expect(report.suppressed.byRubricItemRoute["minor-1 /route-minor-1"]).toBe(2);
    expect(report.suppressed.items.filter((i) => i.reason === "below-min-confidence").every((i) => i.confidence !== undefined)).toBe(true);
    expect(report.rawOccurrences).toBe(12);
    expect(report.headline).toMatch(/^1 finding\(s\) at confidence ≥ 0\.75 .*12 flagged.*3 suppressed \(by rubric item: minor-1 2, major-1 1\)/);
    expect(report.coverageSummary).toMatch(/3 suppressed/);
  });

  it("defaults the cutoff to DEFAULT_MIN_CONFIDENCE", () => {
    const report = buildReport({ kind: "analyzed", findings: [finding("major-1", "major", 0.74)], coverage: fullCoverage });
    expect(report.minConfidence).toBe(DEFAULT_MIN_CONFIDENCE);
    expect(report.findings).toHaveLength(0);
    expect(report.suppressed.byReason["below-min-confidence"]).toBe(1);
  });

  it("a failed outcome surfaces as a non-clean, incomplete report", () => {
    const report = buildReport({ kind: "failed", reason: "jev down", screenId: "s1", rubricItemId: "major-1" });
    expect(report.clean).toBe(false);
    expect(report.coverageComplete).toBe(false);
    expect(report.failed?.reason).toBe("jev down");
  });
});
