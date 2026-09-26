import { describe, expect, it } from "vitest";
import { buildReport, DEFAULT_MAX_FINDINGS_PER_ROUTE, MaxFindingsPerRouteError, resolveMaxFindingsPerRoute } from "./report.js";
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

/** #132: a finding grounded in observed friction (what the live/offline paths attach via groundFindings). */
function grounded(f: UxFinding, impact: NonNullable<UxFinding["impact"]> = "slowed", steps: number[] = [2, 3]): UxFinding {
  return { ...f, impact, journeyEvidence: { id: `retry@${steps[0]}-${steps[steps.length - 1]}`, kind: "retry", steps, detail: "repeated" } };
}

const fullCoverage: Coverage = { totalItems: 2, evaluated: 2, skipped: [], budgetTruncated: [] };
const partialCoverage: Coverage = {
  totalItems: 4,
  evaluated: 2,
  skipped: [{ rubricItemId: "minor-1", screenId: "s2", reason: "missing required evidence: controls" }],
  budgetTruncated: ["s3"],
};

describe("buildReport", () => {
  it("ranks findings by severity × confidence (major before minor) within one impact", () => {
    const outcome: AnalysisOutcome = { kind: "analyzed", findings: [grounded(finding("minor-1", "minor", 0.99)), grounded(finding("major-1", "major", 0.5, true))], coverage: fullCoverage };
    const report = buildReport(outcome, { minConfidence: 0 });
    expect(report.findings[0].rubricItemId).toBe("major-1");
    expect(report.findings[1].rubricItemId).toBe("minor-1");
  });

  it("#132: ranks by observed impact on the job first — blocked > slowed > confused", () => {
    const outcome: AnalysisOutcome = {
      kind: "analyzed",
      findings: [grounded(finding("major-1", "major", 0.99), "confused"), grounded(finding("minor-1", "minor", 0.4), "blocked")],
      coverage: fullCoverage,
    };
    expect(buildReport(outcome, { minConfidence: 0 }).findings.map((f) => f.impact)).toEqual(["blocked", "confused"]);
  });

  it("#132: a rubric finding with no behavioral evidence is heuristic-only — capped at info, in the appendix, not the findings", () => {
    const outcome: AnalysisOutcome = { kind: "analyzed", findings: [finding("major-1", "major", 0.9), grounded(finding("minor-1", "minor", 0.5))], coverage: fullCoverage };
    const report = buildReport(outcome, { minConfidence: 0 });
    expect(report.findings.map((f) => f.rubricItemId)).toEqual(["minor-1"]);
    expect(report.findings[0]!.journeyEvidence?.steps).toEqual([2, 3]);
    expect(report.heuristicAppendix).toHaveLength(1);
    expect(report.heuristicAppendix[0]).toMatchObject({ rubricItemId: "major-1", severity: "info", heuristicOnly: true });
    expect(report.headline).toMatch(/1 heuristic-only \(no observed friction, info\) in the appendix/);
    // Nothing above minor without behavioral evidence, anywhere in the report.
    for (const f of [...report.findings, ...report.heuristicAppendix]) {
      if (f.severity === "major") expect(f.journeyEvidence ?? f.signal).toBeDefined();
    }
    // An appendix-only report is not clean.
    expect(buildReport({ kind: "analyzed", findings: [finding("major-1", "major", 0.9)], coverage: fullCoverage }, { minConfidence: 0 }).clean).toBe(false);
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
    const report = buildReport({ kind: "analyzed", findings: [grounded(finding("major-1", "major", 0.9, true))], coverage: fullCoverage });
    expect(report.findings[0].predictedAttention?.label).toBe("predicted-from-visual-hierarchy");
  });

  it("HONEST LABELING: the report never contains 'eye-tracking' or 'gaze' as a verdict field", () => {
    const report = buildReport(
      { kind: "analyzed", findings: [finding("major-1", "major", 0.9, true), grounded(finding("major-1", "major", 0.9, true))], coverage: fullCoverage },
    );
    // predictedAttention.note is a provenance disclaimer, not a verdict; strip it before scanning verdicts.
    const strip = (f: UxFinding) => ({ ...f, predictedAttention: f.predictedAttention?.label });
    const scrubbed = { ...report, findings: report.findings.map(strip), heuristicAppendix: report.heuristicAppendix.map(strip) };
    const text = JSON.stringify(scrubbed).toLowerCase();
    expect(text).not.toContain("eye-tracking");
    expect(text).not.toContain("gaze");
  });

  it("findings below minConfidence are suppressed, counted by reason/item/route, and summarized — never silently dropped", () => {
    const outcome: AnalysisOutcome = {
      kind: "analyzed",
      findings: [grounded(finding("major-1", "major", 0.9)), grounded(finding("minor-1", "minor", 0.4)), grounded(finding("minor-1", "minor", 0.3))],
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
    expect(report.headline).toMatch(
      /^\[PREVIEW:.*\] 1 finding\(s\) grounded in observed run behavior, shown with their quality grade \(not filtered by it\), at finding-confidence ≥ 0\.75 .*12 flagged.*3 suppressed \(by rubric item: minor-1 2, major-1 1\)/,
    );
    expect(report.coverageSummary).toMatch(/3 suppressed/);
  });

  it("#133: by default the (uncalibrated) grader filters nothing — every finding is shown with its grade", () => {
    const graded = (id: string, label: "actionable" | "relevant-minor" | "generic" | "wrong") =>
      ({ ...grounded(finding(id, "minor", 0.9)), quality: { label, confidence: 0.8 } }) as UxFinding;
    const outcome: AnalysisOutcome = {
      kind: "analyzed",
      findings: [graded("major-1", "actionable"), graded("minor-1", "generic"), graded("minor-1", "wrong"), graded("major-1", "relevant-minor")],
      coverage: fullCoverage,
    };
    const report = buildReport(outcome, { minConfidence: 0 });
    expect(report.findings.map((f) => f.quality?.label).sort()).toEqual(["actionable", "generic", "relevant-minor", "wrong"]);
    expect(report.qualityFiltered).toBe(false);
    expect(report.suppressed.byReason["quality-policy"]).toBe(0);
    expect(report.headline).toMatch(/shown with their quality grade \(not filtered by it\)/);
    expect(report.qualityDistribution).toEqual({ actionable: 1, generic: 1, wrong: 1, "relevant-minor": 1 });
    expect(report.clean).toBe(false);
  });

  it("the opt-in quality filter suppresses the other grades, counted", () => {
    const graded = (id: string, label: "actionable" | "relevant-minor" | "generic" | "wrong") =>
      ({ ...grounded(finding(id, "minor", 0.9)), quality: { label, confidence: 0.8 } }) as UxFinding;
    const outcome: AnalysisOutcome = {
      kind: "analyzed",
      findings: [graded("major-1", "actionable"), graded("minor-1", "generic"), graded("minor-1", "wrong"), graded("major-1", "relevant-minor")],
      coverage: fullCoverage,
    };
    const report = buildReport(outcome, { minConfidence: 0, quality: { show: ["actionable", "relevant-minor"] } });
    expect(report.findings.map((f) => f.quality?.label).sort()).toEqual(["actionable", "relevant-minor"]);
    expect(report.qualityFiltered).toBe(true);
    expect(report.suppressed.byReason["quality-policy"]).toBe(2);
    expect(report.suppressed.items.map((i) => i.qualityLabel).sort()).toEqual(["generic", "wrong"]);
    expect(report.headline).toMatch(/graded actionable\/relevant-minor/);
    expect(buildReport(outcome, { minConfidence: 0, quality: { show: ["actionable"] } }).findings).toHaveLength(1);
  });

  it("defaults the cutoff to DEFAULT_MIN_CONFIDENCE", () => {
    const report = buildReport({ kind: "analyzed", findings: [finding("major-1", "major", 0.29)], coverage: fullCoverage });
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

  it("0.2.0 (#133/#198): every report — analyzed or failed — carries preview: true and the preview note in its headline", () => {
    const analyzed = buildReport({ kind: "analyzed", findings: [], coverage: fullCoverage });
    expect(analyzed.preview).toBe(true);
    expect(analyzed.headline).toMatch(/^\[PREVIEW:.*#133.*#198.*\]/);
    const failed = buildReport({ kind: "failed", reason: "jev down" });
    expect(failed.preview).toBe(true);
    expect(failed.headline).toMatch(/^\[PREVIEW:.*#133.*#198.*\]/);
  });

  describe("#198 interim: per-page (per-route) finding cap", () => {
    const onRoute = (route: string, confidence: number) => ({ ...grounded(finding("minor-1", "minor", confidence)), route });

    it("defaults to DEFAULT_MAX_FINDINGS_PER_ROUTE", () => {
      expect(buildReport({ kind: "analyzed", findings: [], coverage: fullCoverage }).maxFindingsPerRoute).toBe(DEFAULT_MAX_FINDINGS_PER_ROUTE);
    });

    it("caps findings per route, highest-confidence first, and counts the rest as suppressed (per-page-cap) — never dropped silently", () => {
      // The motivating case (#198): 7 findings collapsed onto one route/link.
      const seven = [0.9, 0.8, 0.7, 0.6, 0.5, 0.4, 0.3].map((c) => onRoute("/decisions", c));
      const report = buildReport({ kind: "analyzed", findings: seven, coverage: fullCoverage }, { minConfidence: 0, maxFindingsPerRoute: 3 });
      expect(report.maxFindingsPerRoute).toBe(3);
      expect(report.findings).toHaveLength(3);
      expect(report.findings.map((f) => f.confidence)).toEqual([0.9, 0.8, 0.7]);
      expect(report.suppressed.byReason["per-page-cap"]).toBe(4);
      expect(report.suppressed.total).toBe(4);
      expect(report.suppressed.items.filter((i) => i.reason === "per-page-cap").every((i) => i.route === "/decisions")).toBe(true);
    });

    it("the cap applies PER ROUTE — a busy route never suppresses another route's findings", () => {
      const findings = [
        ...[0.9, 0.8, 0.7].map((c) => onRoute("/a", c)),
        ...[0.9, 0.8, 0.7].map((c) => onRoute("/b", c)),
      ];
      const report = buildReport({ kind: "analyzed", findings, coverage: fullCoverage }, { minConfidence: 0, maxFindingsPerRoute: 2 });
      expect(report.findings.filter((f) => f.route === "/a")).toHaveLength(2);
      expect(report.findings.filter((f) => f.route === "/b")).toHaveLength(2);
      expect(report.suppressed.byReason["per-page-cap"]).toBe(2);
    });

    it("an invalid --max-findings-per-page style value is refused, never silently replaced by the default", () => {
      expect(() => buildReport({ kind: "analyzed", findings: [], coverage: fullCoverage }, { maxFindingsPerRoute: 0 })).not.toThrow();
      // Validation lives in resolveMaxFindingsPerRoute (the CLI layering entry point); buildReport trusts its input.
      expect(() => resolveMaxFindingsPerRoute("0", {})).toThrow(MaxFindingsPerRouteError);
      expect(() => resolveMaxFindingsPerRoute(undefined, { JEVITATE_UX_MAX_FINDINGS_PER_PAGE: "-1" })).toThrow(MaxFindingsPerRouteError);
    });
  });

  describe("resolveMaxFindingsPerRoute — flag > env > config > default (same layering as resolveMinConfidence)", () => {
    it("defaults to DEFAULT_MAX_FINDINGS_PER_ROUTE", () => {
      expect(resolveMaxFindingsPerRoute(undefined, {})).toBe(DEFAULT_MAX_FINDINGS_PER_ROUTE);
      expect(DEFAULT_MAX_FINDINGS_PER_ROUTE).toBe(5);
    });
    it("flag > env > config", () => {
      expect(resolveMaxFindingsPerRoute("2", { JEVITATE_UX_MAX_FINDINGS_PER_PAGE: "4" }, 6)).toBe(2);
      expect(resolveMaxFindingsPerRoute(undefined, { JEVITATE_UX_MAX_FINDINGS_PER_PAGE: "4" }, 6)).toBe(4);
      expect(resolveMaxFindingsPerRoute(undefined, {}, 6)).toBe(6);
    });
    it("invalid values throw", () => {
      expect(() => resolveMaxFindingsPerRoute("abc", {})).toThrow(MaxFindingsPerRouteError);
      expect(() => resolveMaxFindingsPerRoute("0", {})).toThrow(MaxFindingsPerRouteError);
      expect(() => resolveMaxFindingsPerRoute("1.5", {})).toThrow(MaxFindingsPerRouteError);
    });
  });

  describe("calibrationCaveats (issue #97 guardrail)", () => {
    const outcome: AnalysisOutcome = { kind: "analyzed", findings: [finding("major-1", "major", 0.9)], coverage: fullCoverage };

    it("an uncalibrated-target caveat is surfaced both in the headline AND report.calibrationCaveats", () => {
      const report = buildReport(outcome, {
        minConfidence: 0,
        calibrationCaveats: ['app class "admin-tool" is outside the grader\'s calibration corpus — UNVERIFIED for this target'],
      });
      expect(report.calibrationCaveats).toEqual(['app class "admin-tool" is outside the grader\'s calibration corpus — UNVERIFIED for this target']);
      expect(report.headline).toMatch(/CALIBRATION/);
      expect(report.headline).toMatch(/admin-tool/);
      expect(report.headline).toMatch(/UNVERIFIED/);
    });

    it("a failed outcome still carries the calibration caveat in its headline", () => {
      const report = buildReport(
        { kind: "failed", reason: "jev down", screenId: "s1", rubricItemId: "major-1" },
        { calibrationCaveats: ["no app class was given — UNVERIFIED"] },
      );
      expect(report.calibrationCaveats).toEqual(["no app class was given — UNVERIFIED"]);
      expect(report.headline).toMatch(/CALIBRATION/);
      expect(report.headline).toMatch(/no app class was given/);
    });

    it("omitting calibrationCaveats (or passing empty ones) never adds a spurious guardrail marker", () => {
      expect(buildReport(outcome, { minConfidence: 0 }).calibrationCaveats).toBeUndefined();
      expect(buildReport(outcome, { minConfidence: 0 }).headline).not.toMatch(/CALIBRATION/);
      expect(buildReport(outcome, { minConfidence: 0, calibrationCaveats: [] }).calibrationCaveats).toBeUndefined();
      expect(buildReport(outcome, { minConfidence: 0, calibrationCaveats: [""] }).calibrationCaveats).toBeUndefined();
    });

    it("multiple caveats are all folded into the headline, joined", () => {
      const report = buildReport(outcome, { minConfidence: 0, calibrationCaveats: ["caveat one", "caveat two"] });
      expect(report.headline).toMatch(/caveat one \| caveat two/);
    });
  });
});
