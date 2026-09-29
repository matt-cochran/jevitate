/**
 * Every credential jevitate holds. `GITHUB_TOKEN` is used ONLY by the issue filer's REST fallback
 * (never by a model gateway); it is guarded by the same never-to-model check as the model keys.
 */
export type CredentialKey = "OPENROUTER_API_KEY" | "TYPESAFE_API_KEY" | "GITHUB_TOKEN";

/** All credential keys, for the guards that must check every one. */
export const ALL_CREDENTIAL_KEYS: readonly CredentialKey[] = ["OPENROUTER_API_KEY", "TYPESAFE_API_KEY", "GITHUB_TOKEN"];
export type Feature = "generation" | "judgment";

/** feature → the keys it strictly requires. No feature maps to "no key". */
export const FEATURE_KEYS: Readonly<Record<Feature, readonly CredentialKey[]>> = {
  generation: ["OPENROUTER_API_KEY"],
  judgment: ["TYPESAFE_API_KEY"],
} as const;

export class MissingCredentialError extends Error {
  readonly code = "E_MISSING_CREDENTIAL" as const;
  constructor(readonly feature: Feature, readonly missing: CredentialKey[]) {
    super(`feature '${feature}' requires ${missing.join(", ")} — none found in env or local config`);
    this.name = "MissingCredentialError";
  }
}

/** Reads keys from env + an optional local (gitignored) config record.
 *  `detect` never returns the value; `read` returns it (used ONLY at the
 *  provider call). Fail-closed: an unset key is `false`/`undefined`, never a
 *  placeholder. */
export interface CredentialStore {
  detect(key: CredentialKey): boolean;
  read(key: CredentialKey): string | undefined;
}

/**
 * Extra env var name(s) accepted for a credential key, alongside its own name (issue #83):
 * TypeSafe's own docs and other apps set `TYPESAFE_JEV_API_KEY`, where jevitate has
 * historically read `TYPESAFE_API_KEY` — accepting both means a shell profile shared across
 * tools just works, with no rename. The alias is checked only when the primary name is unset;
 * `read`/`detect` never say which name the value actually came from (the caller only ever
 * needs the canonical `CredentialKey`).
 */
const ENV_ALIASES: Partial<Record<CredentialKey, readonly string[]>> = {
  TYPESAFE_API_KEY: ["TYPESAFE_JEV_API_KEY"],
};

/** The env var alias(es) also accepted for `key`, for surfacing to a user (`init`/`ai status`
 *  prompts) — empty for a key with no alias. */
export function envAliasesFor(key: CredentialKey): readonly string[] {
  return ENV_ALIASES[key] ?? [];
}

export function envCredentialStore(
  env: Record<string, string | undefined> = process.env,
  localConfig: Partial<Record<CredentialKey, string>> = {},
): CredentialStore {
  // Trimmed so a padded key (trailing newline/space from a copy-paste or a
  // shell-exported env var) never produces a malformed `Bearer` header. A
  // whitespace-only value trims to "" and must still count as ABSENT — the
  // length check runs on the trimmed value, so this preserves the existing
  // "non-blank env else non-blank localConfig" fallback behavior.
  const nonBlank = (v: string | undefined) => {
    const trimmed = v?.trim();
    return trimmed && trimmed.length > 0 ? trimmed : undefined;
  };
  const fromEnv = (k: CredentialKey) => {
    const direct = nonBlank(env[k]);
    if (direct !== undefined) return direct;
    for (const alias of ENV_ALIASES[k] ?? []) {
      const aliased = nonBlank(env[alias]);
      if (aliased !== undefined) return aliased;
    }
    return undefined;
  };
  const resolve = (k: CredentialKey) => fromEnv(k) ?? nonBlank(localConfig[k]);
  return { detect: (k) => resolve(k) !== undefined, read: (k) => resolve(k) };
}

/** Precondition: throws MissingCredentialError (fail-closed) unless every
 *  required key for `feature` is present. Returns the required key names on
 *  success (NOT the values). */
export function requireKeys(feature: Feature, store: CredentialStore): CredentialKey[] {
  const required = FEATURE_KEYS[feature];
  const missing = required.filter((k) => !store.detect(k));
  if (missing.length > 0) throw new MissingCredentialError(feature, missing);
  return [...required];
}
