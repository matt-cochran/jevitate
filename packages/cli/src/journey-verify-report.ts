import { legacyProofVerdict, MUTATION_PROOF_VERDICTS, type LegacyMutationProofVerdict, type MutationProofVerdict } from "@jevitate/domain";

/**
 * d-vocab-migration (0.30.0 §6.1): the words a mutation proof's verdict is reported in. The adjudicator's
 * `sensitive` is the verdict everywhere a person or a script reads one; `verdictLegacy` carries the
 * 0.29.0 word beside it in `journey verify --json` through 0.31.0 and is removed in 0.32.0.
 */
export { MUTATION_PROOF_VERDICTS, legacyProofVerdict, type LegacyMutationProofVerdict, type MutationProofVerdict };

/** The 0.29.0 word for `sensitive`, as a receipt written before 0.30.0 carries it. Derived, never spelled out. */
export const LEGACY_SENSITIVE_WORD = legacyProofVerdict("sensitive") as Exclude<LegacyMutationProofVerdict, MutationProofVerdict>;

/** The removal release for `verdictLegacy` and the `require-proven` policy alias. */
export const LEGACY_PROOF_WORD_REMOVED_IN = "0.32.0";

/** `{ verdict, verdictLegacy }` for a report: the new word, and the 0.29.0 word a reader may still key on. */
export function proofVerdictFields(verdict: MutationProofVerdict): { readonly verdict: MutationProofVerdict; readonly verdictLegacy: LegacyMutationProofVerdict } {
  return { verdict, verdictLegacy: legacyProofVerdict(verdict) };
}

/**
 * A stored verdict (a `.verify/<id>.json` receipt or a progress checkpoint) in today's word: a 0.29.0
 * receipt's legacy word reads as `sensitive`; every other word is returned as written.
 */
export function readProofVerdict(verdict: MutationProofVerdict | LegacyMutationProofVerdict): MutationProofVerdict;
export function readProofVerdict(verdict: string): string;
export function readProofVerdict(verdict: string): string {
  return verdict === LEGACY_SENSITIVE_WORD ? "sensitive" : verdict;
}

/** The exit code for a proof's verdict (docs/ci.md): 0 sensitive · 1 insensitive · 2 inconclusive. */
export function verifyExitCode(verdict: MutationProofVerdict): number {
  return verdict === "sensitive" ? 0 : verdict === "insensitive" ? 1 : 2;
}

