// report.ts — UxReport assembly (spec: coverage is first-class, anti-masquerade).
//
// A report with few findings is meaningless if most rubric items were Skipped.
// So the report surfaces coverage prominently and a "clean" verdict is asserted
// ONLY at full coverage with zero findings. Findings are ranked by
// severity × confidence. A `failed` outcome is a non-clean, incomplete report —
// never conflated with "analyzed, zero findings".
import type { AnalysisOutcome, Coverage, UxFinding } from "./types.js";

export interface UxReport {
  /** True ONLY at full coverage with zero findings. */
  readonly clean: boolean;
  readonly coverageComplete: boolean;
  /** Present (and loud) whenever coverage is incomplete. */
  readonly coverageWarning?: string;
  readonly coverageSummary: string;
  /** Findings ranked by severity × confidence, descending. */
  readonly findings: readonly UxFinding[];
  readonly coverage: Coverage;
  readonly failed?: { readonly reason: string; readonly screenId?: string; readonly rubricItemId?: string };
}

const SEVERITY_WEIGHT = { info: 1, minor: 2, major: 3 } as const;

/**
 * Rank order: severity tier dominates, then confidence within a tier. A major
 * issue always outranks a minor one — a high-confidence trivial finding must
 * never bury a serious one (which a raw severity×confidence product would allow).
 */
function compareRank(a: UxFinding, b: UxFinding): number {
  const bySeverity = SEVERITY_WEIGHT[b.severity] - SEVERITY_WEIGHT[a.severity];
  if (bySeverity !== 0) return bySeverity;
  return b.confidence - a.confidence;
}

function isFullCoverage(c: Coverage): boolean {
  return c.totalItems > 0 && c.evaluated === c.totalItems && c.skipped.length === 0 && c.budgetTruncated.length === 0;
}

function coverageSummary(c: Coverage): string {
  const parts = [`evaluated ${c.evaluated} of ${c.totalItems} items`];
  if (c.skipped.length > 0) parts.push(`skipped ${c.skipped.length}`);
  if (c.budgetTruncated.length > 0) parts.push(`budget-truncated screens: ${c.budgetTruncated.join(", ")}`);
  return parts.join("; ");
}

const EMPTY_COVERAGE: Coverage = { totalItems: 0, evaluated: 0, skipped: [], budgetTruncated: [] };

export function buildReport(outcome: AnalysisOutcome): UxReport {
  if (outcome.kind === "failed") {
    return {
      clean: false,
      coverageComplete: false,
      coverageWarning: `analysis did not complete: ${outcome.reason}`,
      coverageSummary: "analysis failed — no coverage",
      findings: [],
      coverage: EMPTY_COVERAGE,
      failed: { reason: outcome.reason, screenId: outcome.screenId, rubricItemId: outcome.rubricItemId },
    };
  }

  const complete = isFullCoverage(outcome.coverage);
  const ranked = [...outcome.findings].sort(compareRank);
  const summary = coverageSummary(outcome.coverage);

  return {
    clean: complete && ranked.length === 0,
    coverageComplete: complete,
    ...(complete
      ? {}
      : {
          coverageWarning: `Incomplete coverage — do NOT read this as good UX: ${summary}. Findings reflect only the ${outcome.coverage.evaluated} evaluated item(s).`,
        }),
    coverageSummary: summary,
    findings: ranked,
    coverage: outcome.coverage,
  };
}
