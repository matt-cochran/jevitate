// finding.ts — the SINGLE construction path for a UxFinding (structural
// evidence+citation gate, spec Global Constraint #2 / FMECA SF4).
//
// `makeFinding` is the only way a `UxFinding` comes into existence: it throws
// unless (a) `rubricItemId` resolves to a loaded rubric entry (whose citation
// it copies), AND (b) every `evidenceRef` resolves to a real ref in the
// analyzed evidence, AND (c) at least one evidenceRef is present, AND (d) it
// carries a non-empty observation, user impact and recommendation. No public
// raw constructor exists — a caller physically cannot emit an uncited,
// evidence-less or observation-less finding.
import type {
  AnalyzedEvidence,
  ConfidenceBasis,
  EvidenceRef,
  PredictedAttention,
  RubricEntry,
  Tier,
  UxFinding,
} from "./types.js";

export class UxFindingError extends Error {
  readonly code = "E_UX_FINDING_INVALID" as const;
  constructor(message: string) {
    super(message);
    this.name = "UxFindingError";
  }
}

export interface MakeFindingInput {
  readonly rubricItemId: string;
  readonly evidenceRefs: readonly EvidenceRef[];
  readonly severity: "info" | "minor" | "major";
  readonly confidence: number;
  readonly observation: string;
  readonly userImpact: string;
  readonly recommendation: string;
  readonly tier: Tier;
  /** Normalized route (URL pathname). */
  readonly route: string;
  readonly controls?: readonly string[];
  readonly quotes?: readonly string[];
  /** Dedupe count (default 1). */
  readonly occurrences?: number;
  /** Every screen-state observed (default: just the analyzed evidence's screen). */
  readonly screenIds?: readonly string[];
  readonly confidenceBasis?: ConfidenceBasis;
  readonly quality?: UxFinding["quality"];
  readonly predictedAttention?: PredictedAttention;
}

export function makeFinding(
  input: MakeFindingInput,
  rubric: ReadonlyMap<string, RubricEntry>,
  evidence: AnalyzedEvidence,
): UxFinding {
  const entry = rubric.get(input.rubricItemId);
  if (!entry) {
    throw new UxFindingError(
      `citation gate: rubricItemId '${input.rubricItemId}' does not resolve to a loaded rubric entry`,
    );
  }
  if (!entry.citation || !entry.citation.source || !entry.citation.ref) {
    throw new UxFindingError(
      `citation gate: rubric entry '${entry.id}' is missing a citation`,
    );
  }
  if (input.evidenceRefs.length === 0) {
    throw new UxFindingError(
      `evidence gate: a finding for '${entry.id}' must carry at least one evidenceRef`,
    );
  }
  for (const ref of input.evidenceRefs) {
    if (!evidence.refs.has(ref.id)) {
      throw new UxFindingError(
        `evidence gate: evidenceRef '${ref.id}' does not resolve in the analyzed evidence for screen '${evidence.screenId}'`,
      );
    }
  }
  for (const [field, value] of [
    ["observation", input.observation],
    ["userImpact", input.userImpact],
    ["recommendation", input.recommendation],
  ] as const) {
    if (value.trim().length === 0) {
      throw new UxFindingError(`specificity gate: a finding for '${entry.id}' must carry a non-empty ${field}`);
    }
  }
  if (!Number.isFinite(input.confidence) || input.confidence < 0 || input.confidence > 1) {
    throw new UxFindingError(`confidence for '${entry.id}' must be in [0,1], got ${input.confidence}`);
  }
  const occurrences = input.occurrences ?? 1;
  if (!Number.isInteger(occurrences) || occurrences < 1) {
    throw new UxFindingError(`occurrences for '${entry.id}' must be a positive integer, got ${occurrences}`);
  }
  const finding: UxFinding = {
    rubricItemId: entry.id,
    citation: { source: entry.citation.source, ref: entry.citation.ref },
    severity: input.severity,
    confidence: input.confidence,
    evidenceRefs: input.evidenceRefs.map((r) => ({ id: r.id })),
    observation: input.observation.trim(),
    userImpact: input.userImpact.trim(),
    recommendation: input.recommendation.trim(),
    tier: input.tier,
    screenId: evidence.screenId,
    route: input.route,
    controls: [...(input.controls ?? [])],
    quotes: [...(input.quotes ?? [])],
    occurrences,
    screenIds: [...(input.screenIds ?? [evidence.screenId])],
    ...(input.confidenceBasis ? { confidenceBasis: { ...input.confidenceBasis } } : {}),
    ...(input.quality ? { quality: { ...input.quality } } : {}),
    ...(input.predictedAttention ? { predictedAttention: input.predictedAttention } : {}),
  };
  return Object.freeze(finding);
}
