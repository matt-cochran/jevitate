// claims.ts — the UX findings pipeline (#198): findings are CLAIMS that code verifies.
//
// Where a claim comes from (never from a rubric sprayed over every screen):
//   - code: every destructive control the live run's guard probe clicked (writes blocked) — a
//     `destructive-unguarded` claim, its target fixed by code;
//   - product facts (`.jevitate/product.json`): a price/trial on screen that contradicts the facts
//     (`fact-conflict`, found by text matching), and each page whose intended next step the facts
//     name (`next-step-unclear`);
//   - observed friction (friction.ts) no run signal already explains: Jev CATEGORIZES it — a claim
//     type from a closed list (or not-a-problem) and a target control from the page's real
//     controls, bounded below the choice cap (#192).
//
// How it becomes a finding — independent code decides, Jev is advisory:
//   1. verify: every claim is checked by code against what the run measured (the guard probe's
//      dialog/blocked-write record, the product facts, the friction's own steps and the page's
//      controls). A claim that fails is dropped — counted in the claim ledger, never shown;
//   2. merge: same type × route × target merges by code; a finding that shares a route or control
//      with an earlier one gets ONE Jev duplicate choice (merged findings stay as `contributing`);
//   3. grade: two Jev yes/no questions — "do we need this?" and "do we need this to complete and
//      ship this feature?" — mapped to actionable / relevant-minor / generic / wrong by code
//      (`CLAIM_PROMPTS.cutoffs`);
//   4. prose: built from a TEMPLATE over the verified structured fields (`assets/ux-claims.json`).
//      Generated polish is opt-in (`polish`), once per verified finding, citation kept.
//
// Evidence passes the redaction door (redact.ts) before any model call; a model error is a
// `failed` outcome, never an empty `analyzed` one.
//
// The pipeline's phases live in claims-analyze.ts; `analyzeClaims` below is the orchestrator that
// runs them in order.
import { dedupeObjectiveFindings } from "./analyzer.js";
import { CLAIM_PROMPTS, type ClaimPrompts } from "./claim-prompts.js";
import {
  buildClaimFindings,
  buildTemplateProse,
  classifyFrictionCandidates,
  collectA11yFindings,
  collectCandidates,
  gradeDrafts,
  redactScreens,
  summarizeLedger,
  verifyCandidates,
  type ClaimAnalysisRequest,
  type ClaimAnalyzerDeps,
  type ClaimRecord,
  type Screen,
} from "./claims-analyze.js";
import type { AnalysisOutcome, Coverage, SkippedItem, SuppressedItem } from "./types.js";

/** Runs the claim pipeline over one run's screens (see the module header). */
export async function analyzeClaims(request: ClaimAnalysisRequest, deps: ClaimAnalyzerDeps): Promise<AnalysisOutcome> {
  const prompts = deps.prompts ?? CLAIM_PROMPTS;
  const steps = request.steps ?? [];

  const records: ClaimRecord[] = [];
  const suppressed: SuppressedItem[] = [];
  const skipped: SkippedItem[] = [];
  const budgetTruncated = new Set<string>();

  // Redaction door: every screen, before anything reaches a model.
  const redacted = redactScreens(request, deps);
  if (!redacted.ok) return redacted.outcome;
  const screens = redacted.value;
  const onRoute = (route: string): Screen[] => screens.filter((s) => s.route === route);

  // 1–3. Gather the candidates: guard probes, product facts, and friction no run signal explains.
  const gathered = collectCandidates(request, screens, onRoute);
  const candidates = gathered.candidates;
  records.push(...gathered.records);

  // Jev categorization: ONE batched request per screen with friction candidates.
  const classified = await classifyFrictionCandidates(candidates, request, deps, prompts, steps, 0);
  if (!classified.ok) return classified.outcome;
  let calls = classified.value.calls;
  for (const id of classified.value.budgetTruncated) budgetTruncated.add(id);

  // Verification (code) — every candidate.
  const verified = verifyCandidates(candidates, request, screens, onRoute);
  const drafts = verified.drafts;
  records.push(...verified.records);
  skipped.push(...verified.skipped);
  suppressed.push(...verified.suppressed);

  // Template prose (code) for each verified draft.
  const { persona, prose } = buildTemplateProse(drafts, request, prompts);

  // Jev duplicates + two-question grade: ONE batched request per screen.
  const graded = await gradeDrafts(drafts, request, deps, prompts, prose, persona, calls);
  if (!graded.ok) return graded.outcome;
  calls = graded.value.calls;
  for (const id of graded.value.budgetTruncated) budgetTruncated.add(id);

  // Build findings (merges resolved to their root, in index order).
  const builtResult = await buildClaimFindings({ drafts, prose, grades: graded.value.grades, mergedInto: graded.value.mergedInto, request, deps, prompts }, records);
  if (!builtResult.ok) return builtResult.outcome;
  const findings = builtResult.value;

  // Objective a11y tier — deterministic, no model.
  const a11y = collectA11yFindings(request, deps, screens);
  skipped.push(...a11y.skipped);

  const ledger = summarizeLedger(records);
  const coverage: Coverage = {
    totalItems: ledger.candidates + a11y.total,
    evaluated: ledger.verified + ledger.merged + ledger.refuted + ledger.dismissed + a11y.evaluated,
    skipped,
    budgetTruncated: [...budgetTruncated],
  };
  const claimOccurrences = findings.reduce((n, f) => n + f.occurrences + (f.contributing ?? []).reduce((m, c) => m + (c.occurrences ?? 1), 0), 0);
  return {
    kind: "analyzed",
    findings: [...findings, ...dedupeObjectiveFindings(a11y.found, request.rubric)],
    coverage,
    suppressed,
    rawOccurrences: claimOccurrences + suppressed.length + a11y.found.length,
    claims: ledger,
  };
}

/**
 * #198: what the claim pipeline's numbers are NOT yet backed by. Code verification is real; Jev's
 * categorization (claim type, target control, duplicate) and the two-question grade cutoffs are
 * tuned on deterministic edge-case fixtures only — a real-model calibration pass is pending.
 */
export function claimsCaveat(prompts: ClaimPrompts = CLAIM_PROMPTS): string {
  return `claims (${prompts.version}): every shown claim was verified by code, but Jev's friction categorization and the two-question grade cutoffs (need ≥ ${prompts.cutoffs.need}, ship ≥ ${prompts.cutoffs.ship}, wrong ≤ ${prompts.cutoffs.wrong}) are tuned on deterministic fixtures only — real-model calibration pending (#198)`;
}

// The pipeline's public surface stays on this module (importer/API-snapshot compatibility): the
// types, constants and helpers below moved to claims-analyze.ts and are re-exported here.
export { CLAIM_RUBRIC, NONE_TARGET, boundTargetOptions, gradeLabel, summarizeLedger } from "./claims-analyze.js";
export type { ClaimAnalysisRequest, ClaimAnalyzerDeps, ClaimLedger, ClaimRecord, ClaimSource, ClaimStatus, FindingClaim, GuardKind, GuardProbe } from "./claims-analyze.js";
