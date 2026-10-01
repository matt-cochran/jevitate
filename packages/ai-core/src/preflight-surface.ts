import { FEATURE_KEYS, MissingCredentialError, envAliasesFor, type CredentialKey, type Feature, type CredentialStore, requireKeys } from "./credentials.js";

/** `TYPESAFE_API_KEY` -> `TYPESAFE_API_KEY (or TYPESAFE_JEV_API_KEY)`; unchanged for a key with
 *  no accepted alias (issue #83). */
function withAliasHint(key: CredentialKey): string {
  const aliases = envAliasesFor(key);
  return aliases.length === 0 ? key : `${key} (or ${aliases.join(", ")})`;
}

/** MCP surface: a typed precondition result the HOST reads to collect keys.
 *  The agent/model never types or sees the key — it only sees "setup required"
 *  and WHICH keys are missing (names, never values). */
export interface SetupRequiredResult {
  ok: false;
  precondition: "setup_required";
  feature: Feature;
  missing: CredentialKey[];
  hint: string;
}
export function toSetupRequiredResult(err: MissingCredentialError): SetupRequiredResult {
  return {
    ok: false, precondition: "setup_required", feature: err.feature, missing: err.missing,
    hint: `Set ${err.missing.map(withAliasHint).join(", ")} via the host's secure credential entry, then retry.`,
  };
}

/** Wrap a key-requiring MCP handler so a missing key becomes a typed
 *  setup_required result instead of a thrown error / permissive default. */
export function withPreflight<T>(
  feature: Feature, store: CredentialStore, handler: () => Promise<T>,
): () => Promise<T | SetupRequiredResult> {
  return async () => {
    try { requireKeys(feature, store); }
    catch (e) { if (e instanceof MissingCredentialError) return toSetupRequiredResult(e); throw e; }
    return handler();
  };
}

/** CLI surface: collect a key OUT-OF-BAND via a caller-supplied secure prompt
 *  (masked stdin) and persist to a gitignored local config. NEVER echoes the
 *  value and NEVER returns it to a model. The persistence + prompt fns are
 *  injected so this is testable without real stdin or disk. */
export interface SecureKeyIO {
  promptSecret(message: string): Promise<string>;   // masked; never echoed
  persist(key: CredentialKey, value: string): Promise<void>;  // writes gitignored config, chmod 600
}
export async function collectMissingKeys(
  feature: Feature, store: CredentialStore, io: SecureKeyIO,
): Promise<CredentialKey[]> {
  return collectKeys(feature, store, io);
}

export interface CollectKeysOptions {
  /**
   * #268: prompt for EVERY required key of the feature, even one already configured, and persist
   * the new value over the stored one (rotating / replacing a key). Default: missing keys only.
   */
  readonly replace?: boolean;
  /**
   * #291: called with each entered value BEFORE it is persisted; throwing refuses it (nothing is
   * stored). The value never leaves this call stack.
   */
  readonly check?: (key: CredentialKey, value: string) => Promise<void>;
}

/** The prompt shown for `key` (names only: never a value). */
export function keyPrompt(key: CredentialKey, replace = false): string {
  return `${replace ? "Enter a new value for" : "Enter"} ${withAliasHint(key)} — input masked; stored locally in ~/.jevitate/credentials.json (0600), never sent to a model:`;
}

/** Collects (and persists) the feature's missing keys — or, with `replace`, all of them. Returns the key names collected. */
export async function collectKeys(
  feature: Feature, store: CredentialStore, io: SecureKeyIO, opts: CollectKeysOptions = {},
): Promise<CredentialKey[]> {
  const keys = opts.replace === true ? [...FEATURE_KEYS[feature]] : requireKeysSafe(feature, store);
  for (const k of keys) {
    const v = await io.promptSecret(keyPrompt(k, opts.replace === true && store.detect(k)));
    if (!v || v.trim().length === 0) throw new Error(`${k} not provided — aborting (fail-closed)`);
    await opts.check?.(k, v.trim());
    await io.persist(k, v.trim());
  }
  return keys;
}
function requireKeysSafe(feature: Feature, store: CredentialStore): CredentialKey[] {
  try { requireKeys(feature, store); return []; }
  catch (e) { if (e instanceof MissingCredentialError) return e.missing; throw e; }
}
