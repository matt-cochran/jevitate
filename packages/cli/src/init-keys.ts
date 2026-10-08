import {
  collectKeys,
  featureKeys,
  type CredentialStore,
  type SecureKeyIO,
  type Feature,
  type CredentialKey,
  type JevProvider,
} from "@jevitate/ai-core";
import type { KeySourceReport, KeyVerificationReport } from "./key-report.js";

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
  /** #268: where each key comes from — names and sources only (additive). */
  sources?: KeySourceReport[];
  /** #291: the live auth check per key (additive; absent with --no-verify). */
  verification?: KeyVerificationReport[];
  /** #268: an env var that overrides a key just stored. */
  warnings?: string[];
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
  /** #268 (`--replace-keys`): prompt for every key, even one already stored, and store the new value. */
  replace?: boolean;
  /** #291: checks each entered value before it is persisted (throws to refuse it). */
  check?: (key: CredentialKey, value: string) => Promise<void>;
  /** #429: the Jev provider override (`JEVITATE_JEV_PROVIDER`) — which key judgment needs. */
  jevProvider?: JevProvider;
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
  // #429: a key entered for an earlier feature counts as configured for a later one — the OpenRouter
  // key just entered for generation also satisfies judgment (Jev through OpenRouter), so it is not
  // asked for a TypeSafe key too.
  const entered = new Set<CredentialKey>();
  const view: CredentialStore = { detect: (k) => entered.has(k) || store.detect(k), read: (k) => store.read(k) };
  for (const feature of FEATURES) {
    const required = featureKeys(feature, view, opts.jevProvider);
    if (interactive) {
      // `--replace-keys`: a key already re-entered for an earlier feature is not asked for twice.
      const alreadyEntered = opts.replace === true && required.every((k) => entered.has(k));
      const collected = alreadyEntered
        ? []
        : await collectKeys(feature, view, io, {
            ...(opts.replace === true ? { replace: true } : {}),
            ...(opts.check === undefined ? {} : { check: opts.check }),
            ...(opts.jevProvider === undefined ? {} : { jevProvider: opts.jevProvider }),
          });
      for (const k of collected) entered.add(k);
      report[feature] = { required: featureKeys(feature, view, opts.jevProvider), collected };
    } else {
      // Never prompt: report what's still missing instead of hanging on a closed stdin. `missing`
      // is omitted (not an empty array) when nothing is missing, so a fully-configured non-TTY
      // run reads identically to the interactive path's `{ required, collected: [] }`.
      const missing = required.filter((k) => !view.detect(k));
      report[feature] = { required, collected: [], ...(missing.length > 0 ? { missing } : {}) };
    }
  }
  return report;
}
