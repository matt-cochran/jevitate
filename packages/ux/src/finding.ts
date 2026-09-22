// finding.ts — the SINGLE construction path for a UxFinding (structural
// evidence+citation gate, spec Global Constraint #2 / FMECA SF4).
//
// `makeFinding` is the only way a `UxFinding` comes into existence: it throws
// unless (a) `rubricItemId` resolves to a loaded rubric entry (whose citation
// it copies), AND (b) every `evidenceRef` resolves to a real ref in the
// analyzed evidence, AND (c) at least one evidenceRef is present. No public
// raw constructor exists — a caller physically cannot emit an uncited or
// evidence-less finding.
import type {
  AnalyzedEvidence,
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
  readonly recommendation: string;
  readonly tier: Tier;
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
  const finding: UxFinding = {
    rubricItemId: entry.id,
    citation: { source: entry.citation.source, ref: entry.citation.ref },
    severity: input.severity,
    confidence: input.confidence,
    evidenceRefs: input.evidenceRefs.map((r) => ({ id: r.id })),
    recommendation: input.recommendation,
    tier: input.tier,
    ...(input.predictedAttention ? { predictedAttention: input.predictedAttention } : {}),
  };
  return Object.freeze(finding);
}
