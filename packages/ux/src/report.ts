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
//
// #132: a rubric (semantic/behavioral) finding with no behavioral evidence — no observed journey
// friction (`journeyEvidence`, see friction.ts) — is heuristic-only: capped at `info` and reported
// in `report.heuristicAppendix`, never among the ranked findings. Ranked findings are ordered by
// observed impact on the job (blocked > slowed > confused > cosmetic), then severity, confidence.
// An ungrounded objective-a11y finding (a computed fact) stays ranked but is capped at `minor`.
//
// #133: the quality grade is shown on each finding; the default policy hides no grade.
import type { AnalysisOutcome, Coverage, JobImpact, SuppressedItem, SuppressionReason, UxFinding } from "./types.js";
import { DEFAULT_MIN_CONFIDENCE } from "./confidence.js";
import { DEFAULT_QUALITY_POLICY, policyFilters, type QualityPolicy } from "./grade.js";

export interface SuppressionSummary {
  readonly total: number;
  readonly byReason: Readonly<Record<SuppressionReason, number>>;
  readonly byRubricItem: Readonly<Record<string, number>>;
  /** Counts per `${rubricItemId} ${route}`. */
  readonly byRubricItemRoute: Readonly<Record<string, number>>;
  readonly items: readonly SuppressedItem[];
}

/**
 * Default cap on `findings` PER ROUTE (issue #198 interim fix, 0.2.0). Five is enough room for a
 * page to carry a few genuinely distinct, independently-actionable problems (a form AND its submit
 * button AND its error copy, say) while still reading as a short, actionable list rather than a
 * wall of findings — the motivating case (issue #198) was one link on one route filing 7 findings
 * at once. `groupFindingsByControl` (analyzer.ts) already collapses same-control noise; this cap is
 * the backstop for whatever is still left after that. Overridable the same way as `minConfidence`.
 */
export const DEFAULT_MAX_FINDINGS_PER_ROUTE = 5;

/** Env var override — see `resolveMaxFindingsPerRoute`. Config-file key: `ux.maxFindingsPerPage`. */
export const MAX_FINDINGS_PER_ROUTE_ENV = "JEVITATE_UX_MAX_FINDINGS_PER_PAGE";

export class MaxFindingsPerRouteError extends Error {
  readonly code = "E_UX_MAX_FINDINGS_PER_PAGE" as const;
  constructor(value: string, source: string) {
    super(`${source} must be a positive integer, got '${value}'`);
    this.name = "MaxFindingsPerRouteError";
  }
}

/**
 * Precedence: explicit flag (`--max-findings-per-page`) > `JEVITATE_UX_MAX_FINDINGS_PER_PAGE` >
 * config `ux.maxFindingsPerPage` (`~/.jevitate/config.json`) > `DEFAULT_MAX_FINDINGS_PER_ROUTE` —
 * the same layering as `resolveMinConfidence`/`resolveQualityPolicy`. An invalid value throws,
 * never silently falls back to the default.
 */
export function resolveMaxFindingsPerRoute(flag: number | string | undefined, env: Readonly<Record<string, string | undefined>>, configValue?: number): number {
  const parse = (raw: string, source: string): number => {
    const n = Number(raw);
    if (raw.trim().length === 0 || !Number.isInteger(n) || n < 1) throw new MaxFindingsPerRouteError(raw, source);
    return n;
  };
  if (flag !== undefined) return parse(String(flag), "--max-findings-per-page");
  const fromEnv = env[MAX_FINDINGS_PER_ROUTE_ENV];
  if (fromEnv !== undefined) return parse(fromEnv, MAX_FINDINGS_PER_ROUTE_ENV);
  if (configValue !== undefined) return parse(String(configValue), "config ux.maxFindingsPerPage");
  return DEFAULT_MAX_FINDINGS_PER_ROUTE;
}

export interface BuildReportOptions {
  /** Findings with confidence below this are suppressed (counted, summarized). Default `DEFAULT_MIN_CONFIDENCE`. */
  readonly minConfidence?: number;
  /** Which quality grades are shown. Default `DEFAULT_QUALITY_POLICY` (every grade, shown on each finding — #133). */
  readonly quality?: QualityPolicy;
  /**
   * Cap on `findings` per route (issue #198 interim, 0.2.0), highest-confidence kept first. The
   * rest are not dropped: counted in `suppressed` with reason `per-page-cap`. Default
   * `DEFAULT_MAX_FINDINGS_PER_ROUTE`. Applies only to ranked `findings`, not `heuristicAppendix`.
   */
  readonly maxFindingsPerRoute?: number;
  /**
   * What this analysis honestly could NOT see (#85), e.g. an offline `jevitate ux` run with no
   * mission result/transcript to source blocked/disabled-target evidence from — the same evidence
   * a live usability run sees via `Control.enabled`. Surfaced verbatim on the report, never
   * silently omitted.
   */
  readonly evidenceCaveats?: readonly string[];
  /**
   * The grader-calibration caveat(s) for this target (issue #97), e.g. from
   * `calibration.ts`'s `calibrationCaveat(appContext.appClass)`. Folded into the headline AND
   * returned verbatim as `report.calibrationCaveats` — a target outside (or only weakly inside)
   * the calibration corpus is never presented as if `minConfidence`/the quality grade generalized
   * to it. Optional so existing callers that predate #97 keep compiling; omitting it should be
   * treated as a gap to fix, not a green light.
   */
  readonly calibrationCaveats?: readonly string[];
}

export interface UxReport {
  /** One line to lead with: kept findings, then "N suppressed (by rubric item: …)". */
  readonly headline: string;
  /**
   * 0.2.0 (#133/#198): UX quality findings are a preview — the independent quality grader is still
   * being calibrated, and finding grouping/dedup is still being redesigned (#198). Always `true` in
   * 0.2.0; a machine-readable counterpart to the same note in `headline` and the CLI/docs.
   */
  readonly preview: true;
  /** True ONLY at full coverage with zero findings AND zero suppressed candidates. */
  readonly clean: boolean;
  readonly coverageComplete: boolean;
  /** Present (and loud) whenever coverage is incomplete. */
  readonly coverageWarning?: string;
  readonly coverageSummary: string;
  /**
   * Findings grounded in behavioral evidence (run signals, observed friction) or computed a11y
   * facts, ranked by impact on the job, then severity, then confidence.
   */
  readonly findings: readonly UxFinding[];
  /**
   * #132: heuristic-only findings — a rubric judgment with no observed friction behind it. Capped
   * at `info`, ranked by confidence; an appendix, not the report's findings.
   */
  readonly heuristicAppendix: readonly UxFinding[];
  readonly coverage: Coverage;
  /** The cutoff applied to `findings`. */
  readonly minConfidence: number;
  /** The per-route cap applied to `findings` (issue #198 interim) — see `suppressed` reason `per-page-cap`. */
  readonly maxFindingsPerRoute: number;
  /** The quality grades shown in `findings` (others are suppressed as quality-policy). */
  readonly qualityShown: readonly string[];
  /** #133: did the quality grade hide anything? False by default (every grade shown). */
  readonly qualityFiltered: boolean;
  /** Grade distribution over every graded finding (shown or not). */
  readonly qualityDistribution: Readonly<Record<string, number>>;
  /** Everything flagged that is NOT in `findings`, and why. */
  readonly suppressed: SuppressionSummary;
  /** Flagged per-screen occurrences before adjudication/dedupe/cutoff (volume accounting). */
  readonly rawOccurrences: number;
  readonly failed?: { readonly reason: string; readonly screenId?: string; readonly rubricItemId?: string };
  /** What this analysis honestly could not see (see `BuildReportOptions.evidenceCaveats`). */
  readonly evidenceCaveats?: readonly string[];
  /** See `BuildReportOptions.calibrationCaveats`. */
  readonly calibrationCaveats?: readonly string[];
}

const SEVERITY_WEIGHT = { info: 1, minor: 2, major: 3 } as const;
const IMPACT_WEIGHT: Readonly<Record<JobImpact, number>> = { blocked: 3, slowed: 2, confused: 1, cosmetic: 0 };

/**
 * Rank order: observed impact on the job first (#132 — blocked > slowed > confused > cosmetic),
 * then severity, then confidence. A major issue always outranks a minor one of the same impact —
 * a high-confidence trivial finding must never bury a serious one.
 */
function compareRank(a: UxFinding, b: UxFinding): number {
  const byImpact = IMPACT_WEIGHT[b.impact ?? "cosmetic"] - IMPACT_WEIGHT[a.impact ?? "cosmetic"];
  if (byImpact !== 0) return byImpact;
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

/**
 * #132, enforced by code: a rubric finding without behavioral evidence is heuristic-only (info,
 * appendix); an objective finding without it is capped at minor. Signal findings ARE the evidence.
 */
function applyGroundingRule(f: UxFinding): { finding: UxFinding; appendix: boolean } {
  if (f.tier === "signal" || f.journeyEvidence !== undefined) return { finding: f, appendix: false };
  if (f.tier === "objective-a11y") {
    return { finding: f.severity === "major" ? Object.freeze({ ...f, severity: "minor" as const }) : f, appendix: false };
  }
  return { finding: Object.freeze({ ...f, severity: "info" as const, heuristicOnly: true, impact: "cosmetic" as const }), appendix: true };
}

function summarize(items: readonly SuppressedItem[]): SuppressionSummary {
  const byReason: Record<SuppressionReason, number> = {
    ungrounded: 0,
    "rejected-evidence": 0,
    "not-confirmed": 0,
    "below-min-confidence": 0,
    "quality-policy": 0,
    "user-authored-content": 0,
    "per-page-cap": 0,
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

/**
 * 0.2.0 (#133/#198): a short, factual preview note prefixed to every headline — findings and the
 * quality grader here are still being calibrated/redesigned, never present them as a finished
 * verdict. `report.preview` carries the same fact machine-readably.
 */
const PREVIEW_NOTE = "[PREVIEW: UX quality findings, grader calibration in progress — #133/#198]";

export function buildReport(outcome: AnalysisOutcome, options: BuildReportOptions = {}): UxReport {
  const minConfidence = options.minConfidence ?? DEFAULT_MIN_CONFIDENCE;
  const policy = options.quality ?? DEFAULT_QUALITY_POLICY;
  const maxFindingsPerRoute = options.maxFindingsPerRoute ?? DEFAULT_MAX_FINDINGS_PER_ROUTE;
  const calibrationCaveats = (options.calibrationCaveats ?? []).filter((c) => c.length > 0);
  // Issue #97 guardrail: never let a report read as if the grader's threshold/labels were
  // calibrated for this target when they were not measured on it. Folded into every headline
  // (failed or not) so it cannot be missed by only reading `report.findings`.
  const calibrationSuffix = calibrationCaveats.length > 0 ? ` [CALIBRATION: ${calibrationCaveats.join(" | ")}]` : "";
  if (outcome.kind === "failed") {
    return {
      headline: `${PREVIEW_NOTE} UX analysis failed: ${outcome.reason}${calibrationSuffix}`,
      preview: true,
      clean: false,
      coverageComplete: false,
      coverageWarning: `analysis did not complete: ${outcome.reason}`,
      coverageSummary: "analysis failed — no coverage",
      findings: [],
      heuristicAppendix: [],
      coverage: EMPTY_COVERAGE,
      minConfidence,
      maxFindingsPerRoute,
      qualityShown: [...policy.show],
      qualityFiltered: policyFilters(policy),
      qualityDistribution: {},
      suppressed: summarize([]),
      rawOccurrences: 0,
      failed: { reason: outcome.reason, screenId: outcome.screenId, rubricItemId: outcome.rubricItemId },
      ...(options.evidenceCaveats && options.evidenceCaveats.length > 0 ? { evidenceCaveats: options.evidenceCaveats } : {}),
      ...(calibrationCaveats.length > 0 ? { calibrationCaveats } : {}),
    };
  }

  const complete = isFullCoverage(outcome.coverage);
  const kept: UxFinding[] = [];
  const appendix: UxFinding[] = [];
  const below: SuppressedItem[] = [];
  const qualityDistribution: Record<string, number> = {};
  for (const raw of outcome.findings) {
    const { finding: f, appendix: heuristic } = applyGroundingRule(raw);
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
      (heuristic ? appendix : kept).push(f);
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
  const rankedAll = kept.sort(compareRank);
  const heuristicAppendix = appendix.sort(compareRank);
  // #198 interim per-page cap: `rankedAll` is already ordered highest-confidence-first (within
  // impact/severity), so taking the first `maxFindingsPerRoute` PER ROUTE in that same order keeps
  // exactly the top N for each page. The rest are not dropped — counted below as `per-page-cap`.
  const ranked: UxFinding[] = [];
  const shownPerRoute = new Map<string, number>();
  for (const f of rankedAll) {
    const shown = shownPerRoute.get(f.route) ?? 0;
    if (shown < maxFindingsPerRoute) {
      ranked.push(f);
      shownPerRoute.set(f.route, shown + 1);
    } else {
      below.push({
        rubricItemId: f.rubricItemId,
        route: f.route,
        screenId: f.screenId,
        reason: "per-page-cap",
        detail: `${f.route} already has ${maxFindingsPerRoute} finding(s) shown (highest-confidence first): ${f.observation.slice(0, 160)}`,
        confidence: f.confidence,
        occurrences: f.occurrences,
        ...(f.quality ? { qualityLabel: f.quality.label } : {}),
      });
    }
  }
  const filtered = policyFilters(policy);
  const suppressed = summarize([...(outcome.suppressed ?? []), ...below]);
  const summary = `${coverageSummary(outcome.coverage)}; ${ranked.length} finding(s) at finding-confidence ≥ ${minConfidence}; ${heuristicAppendix.length} heuristic-only in the appendix; ${suppressed.total} suppressed (${Object.entries(
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
  // #133: say whether the (uncalibrated) grader filtered anything, or only labelled.
  const graded = filtered ? `graded ${policy.show.join("/")}` : "shown with their quality grade (not filtered by it)";
  const headline =
    `${PREVIEW_NOTE} ${ranked.length} finding(s) grounded in observed run behavior, ${graded}, at finding-confidence ≥ ${minConfidence} (deduplicated from ${outcome.rawOccurrences ?? outcome.findings.length} flagged occurrence(s))` +
    `; ${heuristicAppendix.length} heuristic-only (no observed friction, info) in the appendix` +
    (suppressed.total > 0 ? `; ${suppressed.total} suppressed (by rubric item: ${byItem})` : "; none suppressed") +
    calibrationSuffix;
  return {
    headline,
    preview: true,
    // Suppression never reads as "no issues": clean needs zero findings (appendix included) AND zero suppressed.
    clean: complete && ranked.length === 0 && heuristicAppendix.length === 0 && suppressed.total === 0,
    coverageComplete: complete,
    ...(complete
      ? {}
      : {
          coverageWarning: `Incomplete coverage — do NOT read this as good UX: ${summary}. Findings reflect only the ${outcome.coverage.evaluated} evaluated item(s).`,
        }),
    coverageSummary: summary,
    findings: ranked,
    heuristicAppendix,
    coverage: outcome.coverage,
    minConfidence,
    maxFindingsPerRoute,
    qualityShown: [...policy.show],
    qualityFiltered: filtered,
    qualityDistribution,
    suppressed,
    rawOccurrences: outcome.rawOccurrences ?? outcome.findings.length,
    ...(options.evidenceCaveats && options.evidenceCaveats.length > 0 ? { evidenceCaveats: options.evidenceCaveats } : {}),
    ...(calibrationCaveats.length > 0 ? { calibrationCaveats } : {}),
  };
}
