/**
 * The adjudicator's verdict (docs/design/0.30.0-evidence-and-trust.md §4.1): what `adjudicate` reads
 * out of one `RunEvidence` record under one rule set. Every field is an enum, a site key or a
 * code-templated reason; nothing here is gathered, only judged.
 */
import type { BoundaryEvidence } from "./evidence.js";

/** The rule sets `adjudicate` knows. A stored record can be re-judged under any of them (`rejudge`). */
export const RULES_VERSIONS = ["v1"] as const;
export type RulesVersion = (typeof RULES_VERSIONS)[number];

/** sensitive: broke for the right reason · insensitive: still passed (vacuous) · cascade: broke elsewhere. */
export type MutationVerdict = "sensitive" | "insensitive" | "cascade" | "not-applied" | "error";
export type AssertionVerdict = MutationVerdict | "unpaired";

/** One assertion site's verdict over its paired mutations. */
export interface AssertionResult {
  readonly site: string;
  readonly verdict: AssertionVerdict;
  /** The mutation that showed it sensitive. */
  readonly provedBy?: string;
  /** The earlier postconditions a targeted proof weakened to reach a sensitive verdict. */
  readonly relaxedSites?: readonly string[];
}

/** §3.1: did the job happen, read in a fresh session before and after the run. */
export interface JobVerdict {
  readonly attainment: "achieved" | "not-achieved" | "unverified";
  readonly basis: "done-check" | "already-true" | "reading-unknown" | "no-check" | "harness";
}

/** Present only when the evidence carries a mutation proof. `sensitive` replaces 0.29.0's `proven` (§6.1). */
export interface ChecksVerdict {
  readonly verdict: "sensitive" | "insensitive" | "inconclusive";
  readonly assertions: readonly AssertionResult[];
  readonly reason?: string;
  /** From target trust (§5.2): a proof on a target that cannot be reset is reported, never counted by a strict gate. */
  readonly countsForGate: boolean;
}

/** §6.2: a run that stopped at one of the four proven boundaries proves nothing either way. */
export interface BoundaryVerdict {
  readonly outcome: "inconclusive";
  readonly kind: BoundaryEvidence["kind"];
  readonly step: number;
  readonly signal: BoundaryEvidence["signal"];
  readonly origin?: string;
}

export interface Verdict {
  readonly rules: RulesVersion;
  readonly job: JobVerdict;
  /** Only when `evidence.mutation` is present. */
  readonly checks?: ChecksVerdict;
  /** Only when `evidence.boundary` is present. */
  readonly boundary?: BoundaryVerdict;
  /** Code-templated, for people. */
  readonly reasons: readonly string[];
}

/** A verdict field `rejudge` reports as moved. */
export type MovedField = "job.attainment" | "checks.verdict" | `assertion:${string}`;

export interface Rejudgement {
  readonly before: Verdict;
  readonly after: Verdict;
  readonly moved: readonly { readonly field: MovedField; readonly from: string; readonly to: string }[];
}
