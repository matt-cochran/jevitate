import type { HandbackBoundary } from "./journey.js";

/**
 * #583 — the pure classifier from a prepare-only run's facts to the typed `handback` result of
 * `docs/contracts/handback-outcome.md` §4. Independent code decides the state from the run's own
 * results and network evidence; no model claim ever sets or changes it. The classifier never acts:
 * it reads facts, never a page.
 */

/** The run facts the classifier decides from (the run's outcome, its failure, its write counts). */
export interface HandbackFacts {
  /** The run's outcome — `"ok"` on a clean pass, `"inconclusive"` when the host degraded, else a failure. */
  readonly outcome: string;
  /** The flat 0-based step a failure was pinned to, when known. */
  readonly failedAt?: number;
  /** `postcondition` when a step's own postcondition/assertion failed; `other` for every other failure. */
  readonly failedKind?: "postcondition" | "other";
  /** The top-level steps the replay ran. */
  readonly steps: number;
  /** How many of those steps' checks passed. */
  readonly checksPassed: number;
  /** First-party write requests the page sent during the run. */
  readonly writes: number;
  /** First-party writes aborted (only ever non-zero with `blockWrites`). */
  readonly writesBlocked: number;
  /** Whether write observation was possible at all (a page that could not be routed is `unavailable`). */
  readonly writeObservation: "available" | "unavailable";
}

/** The `handback.evidence` object (§4). */
export interface HandbackEvidence {
  readonly steps: number;
  readonly checksPassed: number;
  readonly writes: number;
  readonly writesBlocked: number;
  readonly failedAt?: number;
}

/** The typed `handback` result `journey run`/MCP attach when a Journey declares a boundary. */
export interface HandbackOutcome {
  readonly state: "prepared" | "verification-failed" | "incomplete" | "inconclusive" | "submitted";
  readonly boundary: "prepare-only";
  readonly stopBefore: string;
  /** Shown only with `prepared`; every other state shows what failed instead. */
  readonly nextStep?: string;
  readonly evidence: HandbackEvidence;
}

/**
 * §4: decide the handback state from the run's facts. `submitted` wins over every other state
 * (a write was sent, or with `blockWrites` attempted). A run whose outcome is inconclusive, or
 * whose write observation was unavailable, is `inconclusive`; a failed postcondition is
 * `verification-failed`; any other premature end is `incomplete`; a clean `ok` run with zero
 * writes is `prepared`.
 */
export function classifyHandback(facts: HandbackFacts, boundary: HandbackBoundary): HandbackOutcome {
  const evidence: HandbackEvidence = {
    steps: facts.steps,
    checksPassed: facts.checksPassed,
    writes: facts.writes,
    writesBlocked: facts.writesBlocked,
    ...(facts.failedAt === undefined ? {} : { failedAt: facts.failedAt }),
  };
  const state = handbackState(facts);
  return {
    state,
    boundary: "prepare-only",
    stopBefore: boundary.stopBefore.label,
    ...(state === "prepared" ? { nextStep: boundary.nextStep } : {}),
    evidence,
  };
}

function handbackState(facts: HandbackFacts): HandbackOutcome["state"] {
  // §4: submitted wins over every other state — one or more writes were sent (or attempted).
  if (facts.writes > 0 || facts.writesBlocked > 0) return "submitted";
  if (facts.outcome === "inconclusive" || facts.writeObservation === "unavailable") return "inconclusive";
  if (facts.failedKind === "postcondition") return "verification-failed";
  if (facts.failedAt !== undefined || facts.outcome !== "ok") return "incomplete";
  return "prepared";
}
