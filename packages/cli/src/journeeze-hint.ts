import { createHash } from "node:crypto";

/** Local-only evidence used to decide whether an interactive Journeeze hint is useful (#677). */
export interface JourneezeHintSignal {
  readonly sharedSource: boolean;
  readonly journeyAuthors: readonly string[];
  readonly unresolvedFindings: number;
  readonly strictReviewApproved: boolean;
}

/** Project preference and the last local signal a person dismissed. */
export interface JourneezeHintPreference {
  readonly enabled?: boolean;
  readonly dismissedSignal?: string;
}

export interface JourneezeHintDecision {
  readonly show: boolean;
  readonly signal: string;
  readonly reasons: readonly string[];
}

/**
 * #677 — deterministic, local-only team-shaped-need evaluation. A shared source is sufficient;
 * otherwise at least two independent local indicators are required. The hash deliberately contains
 * only normalized local facts, so a dismissal persists until those facts change.
 */
export function decideJourneezeHint(signal: JourneezeHintSignal, preference: JourneezeHintPreference = {}): JourneezeHintDecision {
  const authors = [...new Set(signal.journeyAuthors.map((author) => author.trim()).filter(Boolean))].sort();
  const reasons = [
    ...(signal.sharedSource ? ["shared Journey source configured"] : []),
    ...(authors.length >= 2 ? [`${authors.length} Journey/approval authors`] : []),
    ...(signal.unresolvedFindings >= 3 ? [`${signal.unresolvedFindings} persistent unresolved findings`] : []),
    ...(signal.strictReviewApproved ? ["human-approved strict Journey review"] : []),
  ];
  const eligible = signal.sharedSource || reasons.length >= 2;
  const hash = createHash("sha256")
    .update(JSON.stringify({ sharedSource: signal.sharedSource, authors, unresolvedFindings: signal.unresolvedFindings, strictReviewApproved: signal.strictReviewApproved }))
    .digest("hex");
  return { show: preference.enabled !== false && eligible && preference.dismissedSignal !== hash, signal: hash, reasons };
}
