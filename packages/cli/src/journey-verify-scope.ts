/**
 * The report shapes `journey verify --mutate` hands back and the small pure helpers that build or
 * read them (a pair's result from its checkpoint, the failed sites of a replay, the write-scope
 * arithmetic behind `--plan`). Split out of `journey-verify.ts` so a caller that only reads or renders
 * a report — the CLI's `verify` command, a test asserting one line — does not pull in the proof's
 * browser, checkpoint and replay machinery. `journey-verify.ts` re-exports every name here it used to
 * own, so this module has no importers to change.
 */
import {
  mutationWriteMatches,
  type AssertionProof,
  type AssertionVerdict,
  type JourneyMutation,
  type JourneyTargetedProofPlan,
  type MutationFailedSite,
  type MutationReplay,
  type MutationRunResult,
  type TargetedProof,
} from "@jevitate/journey";
import { type BlockedWrite } from "@jevitate/explore";
import type { OutcomeCheckFailure } from "./journey-network-checks.js";
import type { JourneyExecutionIdentity } from "./journey-proof-context.js";
import { REQUEST_LINE, type TargetedControlDiagnostics } from "./journey-verify-observer.js";
import type { LegacyMutationProofVerdict, MutationProofVerdict } from "./journey-verify-report.js";
import { RETRY_REASON_NOT_KEPT, reusedProofFields, type CheckpointPair } from "./journey-verify-checkpoint.js";

export interface JourneyVerifyMutation {
  readonly kind: JourneyMutation["kind"];
  readonly step: number;
  readonly id: string;
  /** #565: the parameter a `swap-param`/`truncate-param` altered (its name, never a value). */
  readonly param?: string;
  /** #579: where a `swap-param`'s wrong value came from (`reviewed`, `option`, `generated`), never the value. */
  readonly source?: JourneyMutation["source"];
  readonly outcome: MutationRunResult["outcome"];
  readonly failedSites: readonly MutationFailedSite[];
  /** block-write: what was aborted (`METHOD path`). */
  readonly blockedWrites?: readonly string[];
  /** Why the replay failed, was not applied, or errored. */
  readonly reason?: string;
  /**
   * #554 — the same mutation replayed with the mutated step's own postcondition relaxed, present
   * only when the first replay failed at that postcondition and a later site is paired with it.
   */
  readonly relaxed?: {
    readonly outcome: MutationRunResult["outcome"];
    readonly failedSites: readonly MutationFailedSite[];
    readonly blockedWrites?: readonly string[];
    readonly reason?: string;
    /** Sites this replay failed at sooner than the base replay passed them, so its failure counts for nothing. */
    readonly waitsCut?: readonly string[];
    readonly atBaseTime?: MutationRunResult["atBaseTime"];
  };
  /** #609: targeted proofs run for assertion sites this mutation left as a cascade. */
  readonly targeted?: readonly TargetedProof[];
  /** Sites this replay failed at sooner than the base replay passed them, so its failure counts for nothing. */
  readonly waitsCut?: readonly string[];
  /** How the fresh unmutated replay ended, when a site this mutation read sensitive had little to spare over the base replay. */
  readonly control?: MutationRunResult["outcome"];
  /** What that replay did against the base, when it did not pass. */
  readonly controlDiagnostics?: TargetedControlDiagnostics;
  /** A reading that would have needed a control kept none, because the proof's verdict was already decided. */
  readonly controlSkipped?: true;
  /** The same replay held only as long as the base took, run when the control failed at the same site (`MutationRunResult.atBaseTime`). */
  readonly atBaseTime?: MutationRunResult["atBaseTime"];
  /** How this mutation's one re-run ended, when a sibling mutation of its step passed a site it failed. */
  readonly rerun?: MutationRunResult["outcome"];
  /**
   * #778: a replay of this mutation (first, relaxed or targeted) errored and was run once more. One
   * entry per retry, with the error it followed. The replay's own result above is the retry's.
   */
  readonly retries?: readonly { readonly reason: string }[];
  /**
   * #787: this result came from a checkpoint and no replay of it ran in this process. The checkpoint
   * keeps what the verdict reads and nothing the app wrote, so `reason`, `blockedWrites` and
   * `controlDiagnostics` are absent here, and a `retries` entry or a targeted `refused` says its wording is not kept.
   */
  readonly reused?: true;
}

export interface JourneyVerifyAssertion {
  readonly site: string;
  /** The assertion, in the `--success` spec syntax. */
  readonly check: string;
  readonly verdict: AssertionVerdict;
  readonly provedBy?: string;
  /** #609: the earlier postconditions a targeted proof weakened to reach a sensitive verdict. */
  readonly relaxedSites?: readonly string[];
  /** #609: why a targeted proof was refused, when the verdict stays a cascade. */
  readonly targetedRefusal?: string;
  /** #616: the proving targeted proof came from a declared `metadata.targetedProofs` plan. */
  readonly declaredProof?: true;
  readonly obligations?: readonly (NonNullable<AssertionProof["obligations"]>[number] & { readonly declaredProof?: true })[];
}

export interface JourneyVerifyReport {
  readonly journeyId: string;
  /** `journeyContentHash` of the stored Journey: the proof is bound to exactly this content. */
  readonly journeyHash: string;
  readonly executionIdentity: JourneyExecutionIdentity;
  readonly base: { readonly outcome: string; readonly reason?: string };
  /** 0.30.0 §6.1: `sensitive` (0.29.0's `proven`), `insensitive` or `inconclusive`. */
  readonly verdict: MutationProofVerdict;
  /** The 0.29.0 word for `verdict` (`proven` for `sensitive`, otherwise equal), carried through 0.31.0 and removed in 0.32.0. */
  readonly verdictLegacy: LegacyMutationProofVerdict;
  readonly reason?: string;
  /** GAPS 21 (design 5.1, rules-v1 `countsForGate`): whether this proof's target trust lets it count for a strict gate. */
  readonly countsForGate: boolean;
  readonly mutations: readonly JourneyVerifyMutation[];
  readonly assertions: readonly JourneyVerifyAssertion[];
  readonly summary: Readonly<Record<"sensitive" | "insensitive" | "cascade" | "notApplied" | "error" | "unpaired" | "targeted", number>>;
  /** #616: a reviewable `metadata.targetedProofs` entry for each automatic proof stopped at its bound. */
  readonly suggestedTargetedProofs?: readonly JourneyTargetedProofPlan[];
  /** #787: how many of `mutations` were reused from a checkpoint rather than run by this process. 0 on a run that did not resume. */
  readonly reusedPairs: number;
  /**
   * #818: where this report (all of it but this field and `nativeReportError`) was persisted before it
   * was returned, and the SHA-256 of that file's exact bytes. The canonical receipt names the same file.
   */
  readonly nativeReport?: { readonly path: string; readonly sha256: string };
  /** #818: why the report could not be persisted; then no file is claimed, here or in the receipt. */
  readonly nativeReportError?: string;
}

export interface JourneyVerifyPlanReport {
  readonly journeyId: string;
  /** `journeyContentHash` of the stored Journey: the preview is bound to exactly this content. */
  readonly journeyHash: string;
  readonly executionIdentity: JourneyExecutionIdentity;
  readonly mutations: readonly Pick<JourneyMutation, "kind" | "step" | "id" | "param" | "source">[];
  readonly pairs: readonly { readonly site: string; readonly check: string; readonly mutation: string; readonly declared?: true }[];
  readonly assertions: readonly { readonly site: string; readonly check: string; readonly mutations: readonly string[] }[];
  readonly summary: Readonly<Record<"mutations" | "pairs" | "assertions" | "unpaired" | "minimumReplays" | "writeReplays", number>>;
  /** #817: end-state shapes a targeted proof cannot isolate, named before any browser opens. Absent when there are none. */
  readonly isolationNotes?: readonly { readonly site: string; readonly note: string }[];
}

/**
 * What a proof that reaches a verdict runs when nothing needs more: the base, the independence replay,
 * one per mutation, and the closing replay, which only a verdict that can still change gets. Relaxed and
 * targeted replays, controls and re-runs add to it. A proof that fails or is tainted partway stops sooner.
 */
export function minimumReplaysOf(plan: { readonly mutations: readonly unknown[]; readonly pairs: readonly unknown[] }): number {
  if (plan.mutations.length === 0) return 1;
  return plan.mutations.length + (plan.pairs.length === 0 ? 2 : 3);
}

/**
 * How many of those replays can send a real write: all but a mutation that removes the Journey's only
 * write step. Replays that stop at an earlier failure send less, so this is what they can send, not what they will.
 */
export function writeReplaysOf(plan: { readonly mutations: readonly Pick<JourneyMutation, "kind" | "step">[]; readonly pairs: readonly unknown[] }, writeSteps: readonly { readonly step: number }[]): number {
  if (writeSteps.length === 0) return 0;
  const removesEveryWrite = (m: Pick<JourneyMutation, "kind" | "step">): boolean => (m.kind === "skip" || m.kind === "block-write") && writeSteps.every((w) => w.step === m.step);
  return minimumReplaysOf(plan) - plan.mutations.filter(removesEveryWrite).length;
}

/**
 * Only a positively matching recorded or declared write establishes applicability. A step with no write
 * evidence at all gets a block-write only from a declared `mutationPairs` entry: any write its window blocked counts.
 */
export function blockedOwnWrite(recorded: readonly string[], declared: NonNullable<MutationReplay["blockMatchers"]>, blocked: readonly BlockedWrite[]): boolean {
  const observed = recorded.flatMap((line) => {
    const m = REQUEST_LINE.exec(line.trim());
    return m === null ? [] : [{ method: m[1]!, pathGlob: m[2]!, literal: true as const }];
  });
  const matchers = [...observed, ...declared];
  if (matchers.length === 0) return blocked.length > 0;
  return matchers.some((matcher) => blocked.some((request) => mutationWriteMatches(matcher, request)));
}

export function failedSitesOf(result: { outcome: string; reason?: string; at?: number; failurePhase?: "action" | "postcondition" }, failures: readonly OutcomeCheckFailure[]): MutationFailedSite[] {
  if (result.outcome !== "quarantined") return [];
  const structured = failures.map((f): MutationFailedSite =>
    f.where === "step-request" ? { where: "step-request", step: f.step, checkIndex: f.checkIndex, ...(f.evaluated === true ? { evaluated: true } : {}) } : f.where === "end-state" ? { where: "end-state", index: f.index } : { where: "unevaluable" },
  );
  return result.at === undefined ? structured : [...structured, { where: "step", step: result.at + 1, postcondition: result.failurePhase === "postcondition" }];
}

/** A pair's result from its checkpoint, in the report's shape. */
export function reusedMutation(pair: CheckpointPair): JourneyVerifyMutation {
  return {
    kind: pair.kind,
    step: pair.step,
    id: pair.id,
    ...(pair.param === undefined ? {} : { param: pair.param }),
    ...(pair.source === undefined ? {} : { source: pair.source }),
    ...reusedProofFields(pair),
    ...(pair.retries === 0 ? {} : { retries: Array.from({ length: pair.retries }, () => ({ reason: RETRY_REASON_NOT_KEPT })) }),
    reused: true,
  };
}

/** One human line per assertion — verdict, site, check, and the mutation that proved it. */
export function verifyAssertionLine(a: JourneyVerifyAssertion): string {
  // #609: a sensitive verdict reached by a targeted proof names the earlier postconditions it relaxed.
  // #616: a declared plan's relaxations are named as reviewed, not as an automatic search.
  const relaxed =
    a.relaxedSites === undefined || a.relaxedSites.length === 0 ? "" : a.declaredProof === true ? `, declared plan relaxed ${a.relaxedSites.join(", ")}` : `, relaxed ${a.relaxedSites.join(", ")}`;
  const proved = a.provedBy === undefined ? "" : `  (proved by ${a.provedBy}${relaxed})`;
  const refused = a.targetedRefusal === undefined ? "" : `  (targeted proof refused: ${a.targetedRefusal})`;
  const obligations = a.obligations === undefined ? "" : `  [${a.obligations.map((o) => {
    const witness = o.provedBy === undefined ? "" : ` by ${o.provedBy}`;
    const relaxed = o.relaxedSites === undefined || o.relaxedSites.length === 0 ? "" : `, ${o.declaredProof === true ? "declared plan " : ""}relaxed ${o.relaxedSites.join(", ")}`;
    const refusal = o.targetedRefusal === undefined ? "" : `, targeted proof refused: ${o.targetedRefusal}`;
    return `${o.kind}: ${o.verdict}${witness}${relaxed}${refusal}`;
  }).join("; ")}]`;
  return `${a.verdict.padEnd(11)}  ${a.site.padEnd(18)}  ${a.check}${proved}${refused}${obligations}`;
}
