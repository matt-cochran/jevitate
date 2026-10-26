import { contentHash } from "@jevitate/domain";
import { journeyProofHash, journeyWriteSteps, journeyParamSchema, ProofWaiverSchema, type ProofWaiver, type Journey, type JourneyReview } from "@jevitate/journey";
import type { JourneyVerifyRecord } from "./journey-review.js";

export type MutationProofPolicyMode = "advisory" | "require-attempt" | "require-proven";
export { ProofWaiverSchema, type ProofWaiver };

/** Includes the exact attempt, including its timestamp and declared-plan suggestions. */
export function mutationReceiptDigest(record: JourneyVerifyRecord): string {
  return contentHash(record);
}

function nonMutationTestable(journey: Journey, counts: Readonly<Record<string, number>>): boolean {
  return (counts.sensitive ?? 0) === 0 && (counts.unpaired ?? 0) > 0 &&
    Object.entries(counts).every(([k, n]) => k === "unpaired" || n === 0) &&
    journeyWriteSteps(journey).length === 0 && journeyParamSchema(journey).required.length === 0 && (journey.metadata.parameters ?? []).length === 0 &&
    !journey.recording.pages.some((p) => p.steps.some(({ step }) => step.kind === "fill" || step.kind === "select" || step.kind === "upload"));
}

/** Pure policy evaluation. No waiver can turn missing/stale evidence or require-proven into a pass. */
export function evaluateMutationProofPolicy(input: {
  journey: Journey; contentHash: string; record?: JourneyVerifyRecord | null;
  mode?: MutationProofPolicyMode; waiver?: ProofWaiver | null;
}): NonNullable<JourneyReview["proof"]["policy"]> {
  const { journey, contentHash: reviewedHash, record, waiver } = input;
  const mode = input.mode ?? "advisory";
  const proofHash = journeyProofHash(journey);
  const freshness = record == null ? "missing" : (record.journeyId !== journey.metadata.id || (record.proofHash === undefined ? record.contentHash !== reviewedHash : record.proofHash !== proofHash)) ? "stale" : "fresh";
  const verdict = record?.verdict ?? "not-verified";
  const counts = { ...(record?.summary ?? {}) };
  const receiptDigest = record == null ? null : mutationReceiptDigest(record);
  const validWaiver = waiver != null && ProofWaiverSchema.safeParse(waiver).success && freshness === "fresh" && verdict === "inconclusive" &&
    waiver.journeyId === journey.metadata.id && waiver.contentHash === reviewedHash && waiver.proofHash === proofHash && waiver.receiptDigest === receiptDigest;
  const waiverStatus = waiver == null ? "absent" : validWaiver ? "valid" : "stale";
  const proven = freshness === "fresh" && verdict === "proven";
  const waived = mode !== "require-proven" && validWaiver;
  const passed = mode === "advisory" || proven || waived;
  const waiverRequired = mode === "require-attempt" && freshness === "fresh" && verdict === "inconclusive" && !validWaiver;
  const classification = record == null ? "unknown" : nonMutationTestable(journey, counts) ? "non-mutation-testable" : "mutation-testable";
  const reason = proven ? "fresh proven mutation evidence" : waived ? `inconclusive attempt waived: ${waiver!.reason}` : freshness === "missing" ? "no mutation proof recorded" : freshness === "stale" ? "mutation proof is out of date" : `${classification === "non-mutation-testable" ? "non-mutation-testable Journey; " : ""}mutation proof is ${verdict}${record?.reason === undefined ? "" : `: ${record.reason}`}`;
  const next = proven || waived ? "none" : waiverRequired ? `jevitate journey waive-proof ${journey.metadata.id} --reason "<reason>"` : `jevitate journey verify ${journey.metadata.id} --mutate`;
  // #704: versioned stable identity covers policy + executable plan + exact receipt + waiver.
  const digest = contentHash({ v: 1, mode, contentHash: reviewedHash, proofHash, receiptDigest, waiver: waiver ?? null });
  return { mode, verdict, freshness, reason, counts, classification, passed, waiverRequired, waiver: { status: waiverStatus, ...(validWaiver ? { reason: waiver!.reason, at: waiver!.at } : {}) }, next, digest };
}
