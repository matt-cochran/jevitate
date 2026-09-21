import {
  collectMissingKeys,
  FEATURE_KEYS,
  type CredentialStore,
  type SecureKeyIO,
  type Feature,
  type CredentialKey,
} from "@jevitate/ai-core";

export interface FeatureKeyReport {
  required: CredentialKey[];
  collected: CredentialKey[];
}
export type KeyCollectionReport = Record<Feature, FeatureKeyReport>;

const FEATURES: Feature[] = ["generation", "judgment"];

/**
 * Thin orchestration over the existing, already-guardrailed `collectMissingKeys`
 * — collects every feature's missing keys in turn (never in parallel:
 * `SecureKeyIO.promptSecret` is a single shared stdin, so concurrent prompts
 * would interleave). Adds NO new key-handling logic: it never reads, echoes,
 * logs, or returns a key value — only the key NAMES (required/collected).
 */
export async function collectAllMissingKeys(
  store: CredentialStore,
  io: SecureKeyIO,
): Promise<KeyCollectionReport> {
  const report = {} as KeyCollectionReport;
  for (const feature of FEATURES) {
    const collected = await collectMissingKeys(feature, store, io);
    report[feature] = { required: [...FEATURE_KEYS[feature]], collected };
  }
  return report;
}
