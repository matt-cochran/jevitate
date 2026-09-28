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
  /**
   * #230: only set on the non-interactive path — the required keys still absent after this
   * command ran (nothing was prompted for, nothing persisted). Undefined/empty on the
   * interactive path: `collectMissingKeys` either leaves every required key configured or
   * throws (fail-closed), so there is nothing left to report as missing.
   */
  missing?: CredentialKey[];
}
export type KeyCollectionReport = Record<Feature, FeatureKeyReport>;

const FEATURES: Feature[] = ["generation", "judgment"];

export interface CollectAllMissingKeysOptions {
  /**
   * #230: false when stdin is not a TTY (no key env vars, piped/redirected input — how coding
   * agents and CI run `jevitate init`). `SecureKeyIO.promptSecret` reads a 'line' event that a
   * closed/non-interactive stdin never emits, so prompting there would hang until the process is
   * killed, or (observed) read EOF and exit 0 with nothing collected and no summary. Default true
   * (a real terminal): unchanged prompting behavior.
   */
  interactive?: boolean;
}

/**
 * Thin orchestration over the existing, already-guardrailed `collectMissingKeys`
 * — collects every feature's missing keys in turn (never in parallel:
 * `SecureKeyIO.promptSecret` is a single shared stdin, so concurrent prompts
 * would interleave). Adds NO new key-handling logic: it never reads, echoes,
 * logs, or returns a key value — only the key NAMES (required/collected/missing).
 */
export async function collectAllMissingKeys(
  store: CredentialStore,
  io: SecureKeyIO,
  opts: CollectAllMissingKeysOptions = {},
): Promise<KeyCollectionReport> {
  const report = {} as KeyCollectionReport;
  const interactive = opts.interactive ?? true;
  for (const feature of FEATURES) {
    const required = [...FEATURE_KEYS[feature]];
    if (interactive) {
      const collected = await collectMissingKeys(feature, store, io);
      report[feature] = { required, collected };
    } else {
      // Never prompt: report what's still missing instead of hanging on a closed stdin. `missing`
      // is omitted (not an empty array) when nothing is missing, so a fully-configured non-TTY
      // run reads identically to the interactive path's `{ required, collected: [] }`.
      const missing = required.filter((k) => !store.detect(k));
      report[feature] = { required, collected: [], ...(missing.length > 0 ? { missing } : {}) };
    }
  }
  return report;
}
