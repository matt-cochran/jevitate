import { createHash } from "node:crypto";
import {
  featureKeys,
  KEY_PROVIDERS,
  KEY_VERIFY_URLS,
  MissingCredentialError,
  looksLikeOtherKey,
  verifyKey,
  type CredentialKey,
  type CredentialStore,
  type Feature,
  type JevProvider,
  type KeyVerdict,
  type VerifyFetch,
} from "@jevitate/ai-core";

/**
 * #291 (runs): a run that needs live AI keys (`explore --real`, `check`, `journey run/annotate/demo
 * --real`, `demo`, `ux`, …) verifies them ONCE at startup with the same live, non-billable auth call
 * `ai status` / `ai setup` use, and fails fast with a typed setup refusal (`E_AI_SETUP_REQUIRED`,
 * exit 64) when a provider rejects a key — instead of spending the run and ending `inconclusive`
 * with "model decision unavailable".
 *
 *  - Cheap: one GET per key, cached per process (by key name + a hash of the value — the value itself
 *    is never kept here) — a multi-run, a retry or a self-heal re-build never re-checks it.
 *  - Only an `invalid` verdict (401/403) refuses. An `unreachable` provider (offline, 429, 5xx) does
 *    not block: the run's own calls retry and fail typed, as before; that verdict is not cached.
 *  - `JEVITATE_NO_KEY_VERIFY=1` skips the check (offline CI). `--fake-ai` and injected gateways never
 *    reach this code (no network).
 *  - Names, providers and statuses only: no message here carries a key value.
 */

/** The env opt-out (offline CI): `1` / `true` / `yes` skips the startup key check. */
export const NO_KEY_VERIFY_ENV = "JEVITATE_NO_KEY_VERIFY";

/** A key the provider rejected — a `MissingCredentialError`, so every run surface refuses it as `E_AI_SETUP_REQUIRED`. */
export class InvalidCredentialError extends MissingCredentialError {
  constructor(
    feature: Feature,
    readonly invalid: Array<{ readonly key: CredentialKey; readonly httpStatus: number; readonly looksLike: CredentialKey | null }>,
  ) {
    super(
      feature,
      invalid.map((i) => i.key),
    );
    this.name = "InvalidCredentialError";
    const what = invalid
      .map(
        (i) =>
          `${i.key} (${KEY_PROVIDERS[i.key]}) was rejected by the provider (HTTP ${i.httpStatus})${
            i.looksLike === null ? "" : ` — it looks like ${/^[aeiou]/i.test(KEY_PROVIDERS[i.looksLike]) ? "an" : "a"} ${KEY_PROVIDERS[i.looksLike]} key (${i.looksLike})`
          }`,
      )
      .join("; ");
    this.message =
      `feature '${feature}': ${what} — replace it: \`jevitate ai setup ${feature} --replace\` ` +
      `(or set ${NO_KEY_VERIFY_ENV}=1 to skip this startup check offline)`;
  }
}

const cache = new Map<string, Promise<KeyVerdict>>();

function cacheKey(key: CredentialKey, value: string): string {
  return `${key}:${createHash("sha256").update(value).digest("hex")}`;
}

/** Test seam: forget the per-process verdicts. */
export function resetKeyPreflightCache(): void {
  cache.clear();
}

export function keyPreflightDisabled(env: Record<string, string | undefined>): boolean {
  return /^(?:1|true|yes)$/i.test((env[NO_KEY_VERIFY_ENV] ?? "").trim());
}

async function verdictFor(key: CredentialKey, value: string, fetchFn: VerifyFetch): Promise<KeyVerdict> {
  const id = cacheKey(key, value);
  const hit = cache.get(id);
  if (hit !== undefined) return hit;
  const pending = verifyKey(key, value, fetchFn);
  cache.set(id, pending);
  const verdict = await pending;
  // An unreachable provider proves nothing: a later build may check again.
  if (verdict.status === "unreachable") cache.delete(id);
  return verdict;
}

/**
 * Verifies every key `features` need (present keys only: a missing one was already refused by
 * `requireKeys`). Throws `InvalidCredentialError` for the first feature with a rejected key.
 */
export async function preflightRunKeys(
  features: readonly Feature[],
  store: CredentialStore,
  opts: { readonly env: Record<string, string | undefined>; readonly fetchFn: VerifyFetch; readonly jevProvider?: JevProvider },
): Promise<void> {
  if (keyPreflightDisabled(opts.env)) return;
  for (const feature of features) {
    const invalid: Array<{ key: CredentialKey; httpStatus: number; looksLike: CredentialKey | null }> = [];
    // #429: judgment verifies only the key of the Jev route it will use.
    for (const key of featureKeys(feature, store, opts.jevProvider)) {
      if (KEY_VERIFY_URLS[key] === undefined) continue;
      const value = store.read(key);
      if (value === undefined || value.trim() === "") continue;
      const verdict = await verdictFor(key, value.trim(), opts.fetchFn);
      if (verdict.status === "invalid") invalid.push({ key, httpStatus: verdict.httpStatus, looksLike: looksLikeOtherKey(key, value.trim()) });
    }
    if (invalid.length > 0) throw new InvalidCredentialError(feature, invalid);
  }
}
