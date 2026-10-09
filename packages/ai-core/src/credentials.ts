/**
 * Every credential jevitate holds. `GITHUB_TOKEN` is used ONLY by the issue filer's REST fallback
 * (never by a model gateway); it is guarded by the same never-to-model check as the model keys.
 * `JOURNEEZE_UPLOAD_KEY` (#464) is a Journeeze product upload key (`jzu_…`), used ONLY as the
 * `Authorization` header of the Journeeze upload API; it is never read from the plaintext local
 * config (see {@link allowsPlaintextFallback}) — only from the environment (CI) or, through
 * `jevitate connect journeeze`, from a saved reference to an external secret source.
 */
export type CredentialKey = "OPENROUTER_API_KEY" | "TYPESAFE_API_KEY" | "GITHUB_TOKEN" | "JOURNEEZE_UPLOAD_KEY";

/** All credential keys, for the guards that must check every one. */
export const ALL_CREDENTIAL_KEYS: readonly CredentialKey[] = ["OPENROUTER_API_KEY", "TYPESAFE_API_KEY", "GITHUB_TOKEN", "JOURNEEZE_UPLOAD_KEY"];

/**
 * #464: keys that must never be held in plain text at rest. The local config
 * (`~/.jevitate/credentials.json`) is a plaintext file, so for these keys it is IGNORED by
 * `envCredentialStore` (a value found there is never used) and a writer must refuse to persist them.
 */
export const NO_PLAINTEXT_CREDENTIAL_KEYS: readonly CredentialKey[] = ["JOURNEEZE_UPLOAD_KEY"];

/** Whether `key` may be read from (or written to) the plaintext local config. */
export function allowsPlaintextFallback(key: CredentialKey): boolean {
  return !NO_PLAINTEXT_CREDENTIAL_KEYS.includes(key);
}

/** #464: an attempt to hold a no-plaintext key in the plaintext local config. Never carries the value. */
export class PlaintextCredentialRefusedError extends Error {
  readonly code = "E_PLAINTEXT_CREDENTIAL" as const;
  constructor(readonly key: CredentialKey) {
    super(`${key} is never stored in plain text — set it in the environment or save a reference to your secret manager`);
    this.name = "PlaintextCredentialRefusedError";
  }
}

/** Throws `PlaintextCredentialRefusedError` for a key that must never be persisted in plain text. */
export function assertPlaintextAllowed(key: CredentialKey): void {
  if (!allowsPlaintextFallback(key)) throw new PlaintextCredentialRefusedError(key);
}
export type Feature = "generation" | "judgment";

/**
 * feature → the keys it can use. No feature maps to "no key". `generation` needs ALL of its keys;
 * `judgment` (#429) needs ANY ONE: Jev is served both by TypeSafe (`TYPESAFE_API_KEY`) and through
 * OpenRouter (`OPENROUTER_API_KEY`) — `resolveJevRoute` picks the one a call uses, and `featureKeys`
 * names the key(s) a feature will use right now.
 */
export const FEATURE_KEYS: Readonly<Record<Feature, readonly CredentialKey[]>> = {
  generation: ["OPENROUTER_API_KEY"],
  judgment: ["TYPESAFE_API_KEY", "OPENROUTER_API_KEY"],
} as const;

export class MissingCredentialError extends Error {
  readonly code = "E_MISSING_CREDENTIAL" as const;
  /**
   * `anyOf` (#429): ANY ONE of `missing` satisfies the feature (judgment with no key and no
   * provider override) — the message says "or", never "and".
   */
  constructor(readonly feature: Feature, readonly missing: CredentialKey[], readonly anyOf = false) {
    super(
      anyOf
        ? `feature '${feature}' requires one of ${missing.join(" or ")} — none found in env or local config`
        : `feature '${feature}' requires ${missing.join(", ")} — none found in env or local config`,
    );
    this.name = "MissingCredentialError";
  }
}

/**
 * #429: where a Jev judgment call goes. `typesafe` = TypeSafe's own API with `TYPESAFE_API_KEY`;
 * `openrouter` = OpenRouter's System One route with `OPENROUTER_API_KEY` (the same wire format).
 */
export type JevProvider = "typesafe" | "openrouter";
export const JEV_PROVIDERS: readonly JevProvider[] = ["typesafe", "openrouter"];
/** The key each Jev provider authenticates with. */
export const JEV_PROVIDER_KEYS: Readonly<Record<JevProvider, CredentialKey>> = {
  typesafe: "TYPESAFE_API_KEY",
  openrouter: "OPENROUTER_API_KEY",
};
/** Env override of the Jev provider (`--jev-provider` wins over it). */
export const JEV_PROVIDER_ENV = "JEVITATE_JEV_PROVIDER";

/** A `--jev-provider` / `JEVITATE_JEV_PROVIDER` value that names no provider (fail-closed: never ignored). */
export class JevProviderError extends Error {
  readonly code = "E_JEV_PROVIDER" as const;
  constructor(readonly value: string, readonly from: string) {
    super(`${from} '${value}' is not a Jev provider — expected ${JEV_PROVIDERS.join(" or ")}`);
    this.name = "JevProviderError";
  }
}

function parseProvider(value: string | undefined, from: string): JevProvider | undefined {
  const v = value?.trim().toLowerCase();
  if (v === undefined || v === "") return undefined;
  const hit = JEV_PROVIDERS.find((p) => p === v);
  if (hit === undefined) throw new JevProviderError(value ?? "", from);
  return hit;
}

/**
 * The explicit Jev provider override, if any: the flag (`--jev-provider`, MCP `jevProvider`) wins
 * over `JEVITATE_JEV_PROVIDER`. An unknown value throws `JevProviderError` (never silently dropped).
 */
export function jevProviderOverride(env: Record<string, string | undefined>, explicit?: string): JevProvider | undefined {
  return parseProvider(explicit, "--jev-provider") ?? parseProvider(env[JEV_PROVIDER_ENV], JEV_PROVIDER_ENV);
}

/** The provider + key a Jev judgment call uses, and why (`override` = flag/env; `precedence` = the key that is set). */
export interface JevRoute {
  readonly provider: JevProvider;
  readonly key: CredentialKey;
  readonly reason: "override" | "precedence";
}

/**
 * #429: resolves the Jev route. An override pins the provider (its key must be set — fail-closed,
 * never a quiet switch to the other provider). Otherwise the TypeSafe key wins when both are set,
 * then the OpenRouter key. Neither: `MissingCredentialError` naming BOTH keys (`anyOf`).
 */
export function resolveJevRoute(store: CredentialStore, override?: JevProvider): JevRoute {
  if (override !== undefined) {
    const key = JEV_PROVIDER_KEYS[override];
    if (!store.detect(key)) throw new MissingCredentialError("judgment", [key]);
    return { provider: override, key, reason: "override" };
  }
  for (const provider of JEV_PROVIDERS) {
    const key = JEV_PROVIDER_KEYS[provider];
    if (store.detect(key)) return { provider, key, reason: "precedence" };
  }
  throw new MissingCredentialError("judgment", JEV_PROVIDERS.map((p) => JEV_PROVIDER_KEYS[p]), true);
}

/**
 * The key(s) `feature` uses right now: generation → its keys; judgment → the resolved route's key,
 * or, when none resolves, the key(s) that would satisfy it (the override's key, else both).
 */
export function featureKeys(feature: Feature, store: CredentialStore, jevProvider?: JevProvider): CredentialKey[] {
  if (feature !== "judgment") return [...FEATURE_KEYS[feature]];
  try {
    return [resolveJevRoute(store, jevProvider).key];
  } catch (e) {
    if (e instanceof MissingCredentialError) return [...e.missing];
    throw e;
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
  // #464: a no-plaintext key never falls back to the (plaintext) local config.
  const resolve = (k: CredentialKey) => fromEnv(k) ?? (allowsPlaintextFallback(k) ? nonBlank(localConfig[k]) : undefined);
  return { detect: (k) => resolve(k) !== undefined, read: (k) => resolve(k) };
}

/** Precondition: throws MissingCredentialError (fail-closed) unless the keys
 *  `feature` needs are present (judgment: the key of its resolved Jev route —
 *  either key, or the overriding provider's). Returns the key names it will use
 *  (NOT the values). */
export function requireKeys(feature: Feature, store: CredentialStore, jevProvider?: JevProvider): CredentialKey[] {
  if (feature === "judgment") return [resolveJevRoute(store, jevProvider).key];
  const required = FEATURE_KEYS[feature];
  const missing = required.filter((k) => !store.detect(k));
  if (missing.length > 0) throw new MissingCredentialError(feature, missing);
  return [...required];
}

/** Whether `feature` has the keys it needs (judgment: either Jev key, or the overriding provider's). Names only. */
export function featureReady(feature: Feature, store: CredentialStore, jevProvider?: JevProvider): boolean {
  try {
    requireKeys(feature, store, jevProvider);
    return true;
  } catch (e) {
    if (e instanceof MissingCredentialError) return false;
    throw e;
  }
}
