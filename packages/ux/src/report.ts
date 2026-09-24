// report.ts — UxReport assembly (spec: coverage is first-class, anti-masquerade).
//
// A report with few findings is meaningless if most rubric items were Skipped.
// So the report surfaces coverage prominently and a "clean" verdict is asserted
// ONLY at full coverage with zero findings. Findings are ranked by
// severity × confidence. A `failed` outcome is a non-clean, incomplete report —
// never conflated with "analyzed, zero findings".
//
// Findings below `minConfidence` are SUPPRESSED, not dropped: every suppressed candidate
// (below the cutoff, ungrounded, fabricated evidence, not confirmed) is counted by reason and
// by rubric item in `report.suppressed`, with a compact per-item list.
import type { AnalysisOutcome, Coverage, SuppressedItem, SuppressionReason, UxFinding } from "./types.js";
import { DEFAULT_MIN_CONFIDENCE } from "./confidence.js";
import { DEFAULT_QUALITY_POLICY, type QualityPolicy } from "./grade.js";

export interface SuppressionSummary {
  readonly total: number;
  readonly byReason: Readonly<Record<SuppressionReason, number>>;
  readonly byRubricItem: Readonly<Record<string, number>>;
  /** Counts per `${rubricItemId} ${route}`. */
  readonly byRubricItemRoute: Readonly<Record<string, number>>;
  readonly items: readonly SuppressedItem[];
}

export interface BuildReportOptions {
  /** Findings with confidence below this are suppressed (counted, summarized). Default `DEFAULT_MIN_CONFIDENCE`. */
  readonly minConfidence?: number;
  /** Which quality grades are shown. Default `DEFAULT_QUALITY_POLICY` (actionable + relevant-minor). */
  readonly quality?: QualityPolicy;
}

export interface UxReport {
  /** One line to lead with: kept findings, then "N suppressed (by rubric item: …)". */
  readonly headline: string;
  /** True ONLY at full coverage with zero findings AND zero suppressed candidates. */
  readonly clean: boolean;
  readonly coverageComplete: boolean;
  /** Present (and loud) whenever coverage is incomplete. */
  readonly coverageWarning?: string;
  readonly coverageSummary: string;
  /** Findings ranked by severity × confidence, descending. */
  readonly findings: readonly UxFinding[];
  readonly coverage: Coverage;
  /** The cutoff applied to `findings`. */
  readonly minConfidence: number;
  /** The quality grades shown in `findings` (others are suppressed as quality-policy). */
  readonly qualityShown: readonly string[];
  /** Grade distribution over every graded finding (shown or not). */
  readonly qualityDistribution: Readonly<Record<string, number>>;
  /** Everything flagged that is NOT in `findings`, and why. */
  readonly suppressed: SuppressionSummary;
  /** Flagged per-screen occurrences before adjudication/dedupe/cutoff (volume accounting). */
  readonly rawOccurrences: number;
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
  if (b.confidence !== a.confidence) return b.confidence - a.confidence;
  // Deterministic tie-break so repeated runs list identical findings in identical order.
  return `${a.rubricItemId}|${a.route}|${a.controls.join("+")}`.localeCompare(`${b.rubricItemId}|${b.route}|${b.controls.join("+")}`);
}

function isFullCoverage(c: Coverage): boolean {
  return c.totalItems > 0 && c.evaluated === c.totalItems && c.skipped.length === 0 && c.budgetTruncated.length === 0;
}

function coverageSummary(c: Coverage): string {
  const parts = [`evaluated ${c.evaluated} of ${c.totalItems} items`];
  if (c.skipped.length > 0) parts.push(`skipped ${c.skipped.length}`);
  if ((c.notApplicable?.length ?? 0) > 0) parts.push(`not applicable ${c.notApplicable?.length ?? 0}`);
  if (c.budgetTruncated.length > 0) parts.push(`budget-truncated screens: ${c.budgetTruncated.join(", ")}`);
  return parts.join("; ");
}

const EMPTY_COVERAGE: Coverage = { totalItems: 0, evaluated: 0, skipped: [], budgetTruncated: [] };

function summarize(items: readonly SuppressedItem[]): SuppressionSummary {
  const byReason: Record<SuppressionReason, number> = {
    ungrounded: 0,
    "rejected-evidence": 0,
    "not-confirmed": 0,
    "below-min-confidence": 0,
    "quality-policy": 0,
  };
  const byRubricItem: Record<string, number> = {};
  const byRubricItemRoute: Record<string, number> = {};
  for (const it of items) {
    byReason[it.reason]++;
    byRubricItem[it.rubricItemId] = (byRubricItem[it.rubricItemId] ?? 0) + 1;
    const k = `${it.rubricItemId} ${it.route}`;
    byRubricItemRoute[k] = (byRubricItemRoute[k] ?? 0) + 1;
  }
  return { total: items.length, byReason, byRubricItem, byRubricItemRoute, items };
}

export function buildReport(outcome: AnalysisOutcome, options: BuildReportOptions = {}): UxReport {
  const minConfidence = options.minConfidence ?? DEFAULT_MIN_CONFIDENCE;
  const policy = options.quality ?? DEFAULT_QUALITY_POLICY;
  if (outcome.kind === "failed") {
    return {
      headline: `UX analysis failed: ${outcome.reason}`,
      clean: false,
      coverageComplete: false,
      coverageWarning: `analysis did not complete: ${outcome.reason}`,
      coverageSummary: "analysis failed — no coverage",
      findings: [],
      coverage: EMPTY_COVERAGE,
      minConfidence,
      qualityShown: [...policy.show],
      qualityDistribution: {},
      suppressed: summarize([]),
      rawOccurrences: 0,
      failed: { reason: outcome.reason, screenId: outcome.screenId, rubricItemId: outcome.rubricItemId },
    };
  }

  const complete = isFullCoverage(outcome.coverage);
  const kept: UxFinding[] = [];
  const below: SuppressedItem[] = [];
  const qualityDistribution: Record<string, number> = {};
  for (const f of outcome.findings) {
    if (f.quality) qualityDistribution[f.quality.label] = (qualityDistribution[f.quality.label] ?? 0) + 1;
    // Quality policy first: an ungraded finding (objective tier) is not subject to it.
    if (f.quality && !policy.show.includes(f.quality.label)) {
      below.push({
        rubricItemId: f.rubricItemId,
        route: f.route,
        screenId: f.screenId,
        reason: "quality-policy",
        detail: `graded ${f.quality.label}: ${f.observation.slice(0, 160)}`,
        confidence: f.confidence,
        occurrences: f.occurrences,
        qualityLabel: f.quality.label,
      });
    } else if (f.confidence >= minConfidence) {
      kept.push(f);
    } else {
      below.push({
        rubricItemId: f.rubricItemId,
        route: f.route,
        screenId: f.screenId,
        reason: "below-min-confidence",
        detail: `confidence ${f.confidence} < ${minConfidence}: ${f.observation.slice(0, 160)}`,
        confidence: f.confidence,
        occurrences: f.occurrences,
        ...(f.quality ? { qualityLabel: f.quality.label } : {}),
      });
    }
  }
  const ranked = kept.sort(compareRank);
  const suppressed = summarize([...(outcome.suppressed ?? []), ...below]);
  const summary = `${coverageSummary(outcome.coverage)}; ${ranked.length} finding(s) at finding-confidence ≥ ${minConfidence}; ${suppressed.total} suppressed (${Object.entries(
    suppressed.byReason,
  )
    .filter(([, n]) => n > 0)
    .map(([r, n]) => `${r} ${n}`)
    .join(", ") || "none"})`;

  const byItem = Object.entries(suppressed.byRubricItem)
    .sort((a, b) => b[1] - a[1])
    .map(([id, n]) => `${id} ${n}`)
    .join(", ");
  // "finding-confidence" (not bare "confidence"): --min-confidence gates each finding's OWN
  // confidence (violation/applicability/grounding), never its separate quality.confidence (the
  // independent grader's confidence in the actionable/relevant-minor/... label) — the two read
  // as one number if this says just "confidence" (issue #83 item 6).
  const headline =
    `${ranked.length} finding(s) graded ${policy.show.join("/")} at finding-confidence ≥ ${minConfidence} (deduplicated from ${outcome.rawOccurrences ?? outcome.findings.length} flagged occurrence(s))` +
    (suppressed.total > 0 ? `; ${suppressed.total} suppressed (by rubric item: ${byItem})` : "; none suppressed");
  return {
    headline,
    // Suppression never reads as "no issues": clean needs zero findings AND zero suppressed.
    clean: complete && ranked.length === 0 && suppressed.total === 0,
    coverageComplete: complete,
    ...(complete
      ? {}
      : {
          coverageWarning: `Incomplete coverage — do NOT read this as good UX: ${summary}. Findings reflect only the ${outcome.coverage.evaluated} evaluated item(s).`,
        }),
    coverageSummary: summary,
    findings: ranked,
    coverage: outcome.coverage,
    minConfidence,
    qualityShown: [...policy.show],
    qualityDistribution,
    suppressed,
    rawOccurrences: outcome.rawOccurrences ?? outcome.findings.length,
  };
}
