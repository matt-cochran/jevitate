/**
 * Pure retention-decision logic for a single completed run's Recording.
 *
 * This module performs NO I/O and has NO side effects — it just maps
 * (outcome, source) to a decision. Something else (not built in this task)
 * is responsible for acting on the decision via a `RecordingStore`
 * (`put`/`prune`), and for any bookkeeping the "keep" reasons imply (e.g.
 * attaching a failure fingerprint, or enforcing a human-demo TTL via
 * `gcOlderThan` with a computed cutoff) — none of that lives here.
 */

export type RetentionAction =
  | { kind: "prune" }
  | { kind: "keep"; reason: "failure" | "human" };

export interface RetentionOptions {
  source: "human" | "automated";
}

/**
 * Priority order:
 * 1. A human demonstration is always kept, regardless of outcome.
 * 2. A failed automated run is kept (for later inspection).
 * 3. A successful automated run is pruned.
 */
export function applyRetention(
  outcome: "ok" | "failed",
  opts: RetentionOptions,
): RetentionAction {
  if (opts.source === "human") {
    return { kind: "keep", reason: "human" };
  }
  if (outcome === "failed") {
    return { kind: "keep", reason: "failure" };
  }
  return { kind: "prune" };
}
