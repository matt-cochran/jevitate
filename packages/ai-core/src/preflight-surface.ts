import { MissingCredentialError, type CredentialKey, type Feature, type CredentialStore, requireKeys } from "./credentials.js";

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
    hint: `Set ${err.missing.join(", ")} via the host's secure credential entry, then retry.`,
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
  const missing = requireKeysSafe(feature, store);
  for (const k of missing) {
    const v = await io.promptSecret(`Enter ${k} (input hidden; stored locally, never sent to a model):`);
    if (!v || v.trim().length === 0) throw new Error(`${k} not provided — aborting (fail-closed)`);
    await io.persist(k, v.trim());
  }
  return missing;
}
function requireKeysSafe(feature: Feature, store: CredentialStore): CredentialKey[] {
  try { requireKeys(feature, store); return []; }
  catch (e) { if (e instanceof MissingCredentialError) return e.missing; throw e; }
}
