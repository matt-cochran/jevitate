import { round2 } from "../confidence.js";
import { routeOf } from "../route.js";
import type { EvidenceRef, UxFinding } from "../types.js";
import type { SignalEvidence, SignalKind } from "./types.js";

const NNG = { source: "Nielsen Norman Group — 10 Usability Heuristics", ref: "nngroup.com/articles/ten-usability-heuristics" } as const;

/** The signal "rubric": id → principle, citation, severity. */
export const SIGNAL_RULES: Readonly<
  Record<SignalKind, { readonly id: string; readonly principle: string; readonly citation: { source: string; ref: string }; readonly severity: UxFinding["severity"] }>
> = {
  "hung-request": { id: "signal-hung-request", principle: "Visibility of system status", citation: NNG, severity: "major" },
  "duplicate-write": { id: "signal-duplicate-write", principle: "Error prevention", citation: NNG, severity: "major" },
  "internal-id": { id: "signal-internal-id", principle: "Match between system and the real world", citation: NNG, severity: "minor" },
  "inert-control": { id: "signal-inert-control", principle: "Visibility of system status", citation: NNG, severity: "minor" },
  "stuck-job": { id: "signal-stuck-job", principle: "Visibility of system status", citation: NNG, severity: "major" },
  "repeated-reply": { id: "signal-repeated-reply", principle: "Help users recognize, diagnose, and recover from errors", citation: NNG, severity: "major" },
  "duplicate-create": { id: "signal-duplicate-create", principle: "Error prevention", citation: NNG, severity: "major" },
  "failed-submit": { id: "signal-failed-submit", principle: "Help users recognize, diagnose, and recover from errors", citation: NNG, severity: "major" },
  "url-mismatch": { id: "signal-url-mismatch", principle: "Consistency and standards", citation: NNG, severity: "minor" },
  "horizontal-overflow": { id: "signal-horizontal-overflow", principle: "Flexibility and efficiency of use", citation: NNG, severity: "major" },
  "vertical-clipping": { id: "signal-vertical-clipping", principle: "Visibility of system status", citation: NNG, severity: "major" },
};

export class SignalFindingError extends Error {
  readonly code = "E_UX_FINDING_INVALID" as const;
  constructor(message: string) {
    super(message);
    this.name = "SignalFindingError";
  }
}

interface SignalFindingInput {
  readonly kind: SignalKind;
  readonly confidence: number;
  readonly url: string;
  readonly screenId: string;
  readonly observation: string;
  readonly userImpact: string;
  readonly recommendation: string;
  readonly controls?: readonly string[];
  readonly quotes?: readonly string[];
  readonly occurrences?: number;
  readonly screenIds?: readonly string[];
  readonly evidence: SignalEvidence;
}

/**
 * The single construction path for a signal finding — the same gate as `makeFinding`: a cited
 * rule, at least one step of evidence, a non-empty observation/impact/recommendation, and a
 * confidence in [0,1].
 */
export function makeSignalFinding(input: SignalFindingInput): UxFinding {
  const rule = SIGNAL_RULES[input.kind];
  if (input.evidence.steps.length === 0) throw new SignalFindingError(`evidence gate: a ${rule.id} finding must cite at least one step`);
  for (const [field, value] of [
    ["observation", input.observation],
    ["userImpact", input.userImpact],
    ["recommendation", input.recommendation],
  ] as const) {
    if (value.trim().length === 0) throw new SignalFindingError(`specificity gate: a ${rule.id} finding must carry a non-empty ${field}`);
  }
  if (!Number.isFinite(input.confidence) || input.confidence < 0 || input.confidence > 1) {
    throw new SignalFindingError(`confidence for '${rule.id}' must be in [0,1], got ${input.confidence}`);
  }
  const refs: EvidenceRef[] = [
    ...input.evidence.steps.map((s) => ({ id: `step:${s}` })),
    ...input.evidence.requests.map((r) => ({ id: `request:${r.id}` })),
    ...(input.evidence.screenshot === undefined ? [] : [{ id: `screenshot:${input.evidence.screenshot}` }]),
  ];
  const finding: UxFinding = {
    rubricItemId: rule.id,
    citation: { ...rule.citation },
    severity: rule.severity,
    confidence: round2(input.confidence),
    evidenceRefs: refs,
    observation: input.observation.trim(),
    userImpact: input.userImpact.trim(),
    recommendation: input.recommendation.trim(),
    tier: "signal",
    screenId: input.screenId,
    route: routeOf(input.url),
    controls: [...(input.controls ?? [])],
    quotes: [...(input.quotes ?? [])],
    occurrences: input.occurrences ?? 1,
    screenIds: [...(input.screenIds ?? [input.screenId])],
    signal: input.evidence,
  };
  return Object.freeze(finding);
}
