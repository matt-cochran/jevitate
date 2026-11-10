import { contentHash } from "@jevitate/domain";
import { planJourneyMutations, journeyParamSchema, ProofWaiverSchema, type ProofWaiver, type Journey, type JourneyReview } from "@jevitate/journey";
import type { JourneyVerifyRecord } from "./journey-review.js";
import { currentJourneyProof, currentJourneyProofHash, journeyProofStaleCause, proofTargetKnown, proofTargetNow, type ProofTargetNow } from "./journey-proof-context.js";
import { LEGACY_PROOF_WORD_REMOVED_IN, LEGACY_SENSITIVE_WORD, readProofVerdict } from "./journey-verify-report.js";

/**
 * Owner decision "Proof role" (2026-11-09): job gates, proof advisory. The strict gate is the job's done
 * check (`job.attainment`); a mutation proof is checks-strength evidence, `advisory` by default, and
 * `require-sensitive` is a documented opt-in for targets that can be reset.
 */
export type MutationProofPolicyMode = "advisory" | "require-attempt" | "require-sensitive";
/** What `project.json` may say: the modes, plus 0.29.0's name for `require-sensitive` until 0.32.0. */
export type MutationProofPolicySetting = MutationProofPolicyMode | typeof LEGACY_REQUIRE_SENSITIVE;
export { ProofWaiverSchema, type ProofWaiver };

export const DEFAULT_MUTATION_PROOF_POLICY: MutationProofPolicyMode = "advisory";
export const MUTATION_PROOF_POLICY_MODES: readonly MutationProofPolicyMode[] = ["advisory", "require-attempt", "require-sensitive"];
/** 0.29.0's name for `require-sensitive`, read as an alias that warns once per process. Derived from the legacy verdict word. */
export const LEGACY_REQUIRE_SENSITIVE = `require-${LEGACY_SENSITIVE_WORD}` as const;

export function isMutationProofPolicySetting(value: unknown): value is MutationProofPolicySetting {
  return value === LEGACY_REQUIRE_SENSITIVE || (MUTATION_PROOF_POLICY_MODES as readonly unknown[]).includes(value);
}

let aliasWarned = false;

/** The deprecation line the alias prints, once per process. */
export const REQUIRE_SENSITIVE_ALIAS_WARNING =
  `warning: mutationProofPolicy "${LEGACY_REQUIRE_SENSITIVE}" is deprecated; it now reads as "require-sensitive" and stops being accepted in ${LEGACY_PROOF_WORD_REMOVED_IN}. Set "require-sensitive" in .jevitate/project.json\n`;

/** A policy setting as a mode: the alias becomes `require-sensitive`, with one deprecation line per process on stderr. */
export function normalizeMutationProofPolicy(setting: MutationProofPolicySetting | undefined, warn: (line: string) => void = (line) => void process.stderr.write(line)): MutationProofPolicyMode {
  if (setting === undefined) return DEFAULT_MUTATION_PROOF_POLICY;
  if (setting !== LEGACY_REQUIRE_SENSITIVE) return setting;
  if (!aliasWarned) {
    aliasWarned = true;
    warn(REQUIRE_SENSITIVE_ALIAS_WARNING);
  }
  return "require-sensitive";
}

/** Tests only: forget that the alias warning was printed. */
export function resetMutationProofPolicyWarningForTests(): void {
  aliasWarned = false;
}

/** #816: a stale proof's reason names what differs; only a changed Journey is blamed on the Journey. */
function staleReason(cause: ReturnType<typeof journeyProofStaleCause>): string {
  if (cause === "engine-unknown") return "mutation proof does not match this engine, and its receipt does not say which engine recorded it (before 0.30.0): the Journey is unchanged";
  if (cause === "engine") return "mutation proof was recorded by another jevitate engine: the Journey is unchanged, but this engine computes its proof identity differently";
  if (cause === "read-policy") return "mutation proof is out of date: the target's safety.readRequests changed since it ran";
  if (cause === "no-planner-identity") return "mutation proof is out of date: it predates proof identity (before 0.14.0)";
  if (cause === "target") return "mutation proof ran on another target origin than the one this Journey is judged for: the Journey is unchanged";
  if (cause === "app-version") return "mutation proof ran on another app version than the one set now (JEVITATE_APP_VERSION): the Journey is unchanged";
  return "mutation proof is out of date";
}

/** Includes the exact attempt, including its timestamp and declared-plan suggestions. */
export function mutationReceiptDigest(record: JourneyVerifyRecord): string {
  return contentHash(record);
}

function nonMutationTestable(journey: Journey, counts: Readonly<Record<string, number>>, readRequests: readonly string[] = []): boolean {
  return (counts.sensitive ?? 0) === 0 && (counts.unpaired ?? 0) > 0 &&
    Object.entries(counts).every(([k, n]) => k === "unpaired" || n === 0) &&
    planJourneyMutations(journey, { readRequests }).mutations.length === 0 && journeyParamSchema(journey).required.length === 0 && (journey.metadata.parameters ?? []).length === 0 &&
    !journey.recording.pages.some((p) => p.steps.some(({ step }) => step.kind === "fill" || step.kind === "select" || step.kind === "upload"));
}

/**
 * Pure policy evaluation. No waiver can turn missing/stale evidence or require-sensitive into a pass, and
 * under require-sensitive a proof counts only when its target trust lets it (`countsForGate`, §5.1): a
 * receipt from before 0.30.0 carries no trust and counts for nothing.
 */
export function evaluateMutationProofPolicy(input: {
  journey: Journey; contentHash: string; record?: JourneyVerifyRecord | null;
  mode?: MutationProofPolicySetting; waiver?: ProofWaiver | null;
  /** The target's `safety.readRequests` as they stand: a proof run under others is stale. */
  readRequests?: readonly string[] | undefined;
  /** M5: the target origin and app version judged on now (default: the Journey's recorded site, `JEVITATE_APP_VERSION`). */
  now?: ProofTargetNow;
}): NonNullable<JourneyReview["proof"]["policy"]> {
  const { journey, contentHash: reviewedHash, record, waiver } = input;
  const mode = normalizeMutationProofPolicy(input.mode);
  const proofHash = currentJourneyProofHash(journey, record?.proofContext, input.readRequests);
  const now = input.now ?? proofTargetNow(journey);
  const freshness = record == null ? "missing" : currentJourneyProof(journey, record, input.readRequests, now) ? "fresh" : "stale";
  const verdict = record == null ? "not-verified" : readProofVerdict(record.verdict);
  const counts = { ...(record?.summary ?? {}) };
  const receiptDigest = record == null ? null : mutationReceiptDigest(record);
  const validWaiver = waiver != null && ProofWaiverSchema.safeParse(waiver).success && freshness === "fresh" && verdict === "inconclusive" &&
    waiver.journeyId === journey.metadata.id && waiver.contentHash === reviewedHash && waiver.proofHash === proofHash && waiver.receiptDigest === receiptDigest;
  const waiverStatus = waiver == null ? "absent" : validWaiver ? "valid" : "stale";
  const sensitive = freshness === "fresh" && verdict === "sensitive";
  // §5.1: on a target that cannot be reset a sensitive proof is reported, never counted by the strict gate.
  const uncounted = mode === "require-sensitive" && sensitive && record?.countsForGate !== true;
  // #816: a receipt that does not say which engine recorded it is never current evidence for require-sensitive.
  const unknownEngine = mode === "require-sensitive" && sensitive && !uncounted && (typeof record?.engine?.version !== "string" || typeof record.engine.commit !== "string");
  // M5: a receipt that does not name the target and app version it ran on (before 0.30.0) never counts for require-sensitive.
  const unknownTarget = mode === "require-sensitive" && sensitive && !uncounted && !unknownEngine && record != null && !proofTargetKnown(record, now);
  const satisfied = sensitive && !uncounted && !unknownEngine && !unknownTarget;
  const waived = mode !== "require-sensitive" && validWaiver;
  const passed = mode === "advisory" || satisfied || waived;
  const waiverRequired = mode === "require-attempt" && freshness === "fresh" && verdict === "inconclusive" && !validWaiver;
  const classification = record == null ? "unknown" : nonMutationTestable(journey, counts, input.readRequests) ? "non-mutation-testable" : "mutation-testable";
  const reason = satisfied ? "fresh sensitive mutation evidence" : unknownEngine ? "the mutation proof is sensitive, but its receipt does not say which engine recorded it (written before 0.30.0), so it does not count for require-sensitive: re-run it" : unknownTarget ? "the mutation proof is sensitive, but its receipt does not name the target origin and app version it ran on (written before 0.30.0, or without the app version set now), so it does not count for require-sensitive: re-run it" : uncounted ? "the mutation proof is sensitive, but it does not count for require-sensitive: a proof's strength depends on a target you can reset (run it on a target with trust test or harness)" : waived ? `inconclusive attempt waived: ${waiver!.reason}` : freshness === "missing" ? "no mutation proof recorded" : freshness === "stale" ? staleReason(journeyProofStaleCause(journey, record!, input.readRequests, now)) : `${classification === "non-mutation-testable" ? "non-mutation-testable Journey; " : ""}mutation proof is ${verdict}${record?.reason === undefined ? "" : `: ${record.reason}`}`;
  const next = satisfied || waived ? "none" : waiverRequired ? `jevitate journey waive-proof ${journey.metadata.id} --reason "<reason>"` : `jevitate journey verify ${journey.metadata.id} --mutate`;
  // #704: versioned stable identity covers policy + executable plan + exact receipt + waiver.
  const digest = contentHash({ v: 1, mode, contentHash: reviewedHash, proofHash, receiptDigest, waiver: waiver ?? null });
  return { mode, verdict, freshness, reason, counts, classification, passed, waiverRequired, waiver: { status: waiverStatus, ...(validWaiver ? { reason: waiver!.reason, at: waiver!.at } : {}) }, next, digest };
}
