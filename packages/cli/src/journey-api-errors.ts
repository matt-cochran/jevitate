import type { JourneyLintFinding } from "@jevitate/journey";

/**
 * Distinct from `@jevitate/journey`'s `ParamValidationError` so CLI/API callers
 * can tell "no such journey" apart from "params didn't match the journey's
 * schema" without string-matching error messages.
 */
export class UnknownJourneyError extends Error {}

/**
 * A Journey declares `metadata.requiresAuth: true` (#118) but the run was given no
 * `storageState` — refused BEFORE any browser launches, with a message that names the
 * actual problem instead of a confusing `replay-target-not-found` deep into the steps.
 */
export class JourneyRequiresAuthError extends Error {}

/**
 * #401: the Journey's assertions cannot prove its outcome (the `lintJourney` errors). `promote`
 * refuses unless the reviewer accepts it with a non-empty `--accept-weak <reason>`.
 */
/** #432: `journey promote --reviewed-hash`: the Journey changed after the reviewer's sheet was produced. */
export class StaleReviewError extends Error {
  readonly code = "E_JOURNEY_REVIEW_STALE";
}

/** #453: a bad combination of proposal flags (`--proposal` with `--reject-proposal`; a rejection with no reason). Exit 64. */
export class JourneyProposalArgsError extends Error {
  readonly code = "E_JOURNEY_PROPOSAL_ARGS";
}

export class WeakJourneyError extends Error {
  constructor(message: string, readonly findings: readonly JourneyLintFinding[] = []) {
    super(message);
  }
}
