import { envAliasesFor, type CredentialKey } from "./credentials.js";

/**
 * Credential provenance and live verification (#268, #291). Everything here handles key NAMES,
 * sources and verdicts only: a key VALUE is read by the caller, passed to `verifyKey` for exactly
 * one authenticated request (in a header, never a URL or body), and never returned, logged or put
 * in a message.
 */

/** Who issues each credential (for naming a key to a person). */
export const KEY_PROVIDERS: Readonly<Record<CredentialKey, string>> = {
  OPENROUTER_API_KEY: "OpenRouter",
  TYPESAFE_API_KEY: "TypeSafe/Jev",
  GITHUB_TOKEN: "GitHub",
};

/** Where a configured key's value comes from. Env wins over the stored file. */
export type CredentialSource =
  | { readonly kind: "env"; readonly envVar: string }
  | { readonly kind: "file" }
  | { readonly kind: "missing" };

export interface CredentialProvenance {
  readonly key: CredentialKey;
  readonly provider: string;
  readonly source: CredentialSource;
  /** True when an env var is set AND the credentials file also holds the key: the env value wins. */
  readonly shadowsStored: boolean;
}

const nonBlank = (v: string | undefined): boolean => v !== undefined && v.trim().length > 0;

/** The source `envCredentialStore` resolves `key` from — same precedence (env name, its aliases, then the file). */
export function credentialProvenance(
  key: CredentialKey,
  env: Record<string, string | undefined>,
  localConfig: Partial<Record<CredentialKey, string>>,
): CredentialProvenance {
  const envVar = [key, ...envAliasesFor(key)].find((name) => nonBlank(env[name]));
  const stored = nonBlank(localConfig[key]);
  const source: CredentialSource = envVar !== undefined ? { kind: "env", envVar } : stored ? { kind: "file" } : { kind: "missing" };
  return { key, provider: KEY_PROVIDERS[key], source, shadowsStored: envVar !== undefined && stored };
}

/** One live check's verdict. `missing`/`skipped` never made a request. */
export type KeyVerdict =
  | { readonly status: "valid" }
  | { readonly status: "invalid"; readonly httpStatus: number }
  | { readonly status: "unreachable"; readonly reason: string }
  | { readonly status: "missing" }
  | { readonly status: "skipped" };

/** The minimal fetch the verifier needs (injectable: tests never touch the network). */
export type VerifyFetch = (
  url: string,
  init: { readonly method: "GET"; readonly headers: Record<string, string>; readonly signal: AbortSignal },
) => Promise<{ readonly status: number }>;

/**
 * A non-billable, authenticated GET per provider: OpenRouter's key-info endpoint and TypeSafe's
 * model list (what the SDK itself calls). Both answer 401/403 for a wrong key.
 */
export const KEY_VERIFY_URLS: Readonly<Partial<Record<CredentialKey, string>>> = {
  OPENROUTER_API_KEY: "https://openrouter.ai/api/v1/key",
  TYPESAFE_API_KEY: "https://api.typesafe.ai/v1/models",
};

export const KEY_VERIFY_TIMEOUT_MS = 10_000;

/** Never lets a key value reach a message (an error text that echoed request internals). */
function scrub(text: string, value: string): string {
  return value.length > 0 ? text.split(value).join("«key»") : text;
}

/**
 * One live auth check of `value` as `key`. 2xx → valid; 401/403 → invalid; anything else (a
 * network error, a timeout, 429, 5xx, an unexpected status) → unreachable with the reason — never
 * reported as valid. Throws only for a key that has no verification endpoint.
 */
export async function verifyKey(
  key: CredentialKey,
  value: string,
  fetchFn: VerifyFetch,
  timeoutMs: number = KEY_VERIFY_TIMEOUT_MS,
): Promise<KeyVerdict> {
  const url = KEY_VERIFY_URLS[key];
  if (url === undefined) throw new Error(`no live verification for ${key}`);
  if (value.trim().length === 0) return { status: "missing" };
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetchFn(url, { method: "GET", headers: { Authorization: `Bearer ${value.trim()}`, Accept: "application/json" }, signal: ctrl.signal });
    if (res.status >= 200 && res.status < 300) return { status: "valid" };
    if (res.status === 401 || res.status === 403) return { status: "invalid", httpStatus: res.status };
    return { status: "unreachable", reason: res.status === 429 ? "rate limited (HTTP 429)" : `unexpected HTTP ${res.status}` };
  } catch (e) {
    const reason = ctrl.signal.aborted ? `no answer within ${timeoutMs}ms` : (e instanceof Error ? e.message : String(e)).split("\n")[0] ?? "network error";
    return { status: "unreachable", reason: scrub(reason, value).slice(0, 200) };
  } finally {
    clearTimeout(timer);
  }
}

/** Value shapes that identify a provider's key — to flag a key stored in the wrong slot (#291). */
const KEY_SHAPES: ReadonlyArray<readonly [CredentialKey, RegExp]> = [
  ["OPENROUTER_API_KEY", /^sk-or-/],
  ["GITHUB_TOKEN", /^(?:gh[pousr]_|github_pat_)/],
];

/** The OTHER credential `value` looks like (e.g. an OpenRouter `sk-or-…` key in the TypeSafe slot), else null. */
export function looksLikeOtherKey(key: CredentialKey, value: string): CredentialKey | null {
  const v = value.trim();
  for (const [other, re] of KEY_SHAPES) if (other !== key && re.test(v)) return other;
  return null;
}

/** `valid` / `invalid (HTTP 401)` / `unreachable (…)` / `missing` / `not verified` — for a human line. */
export function describeVerdict(v: KeyVerdict): string {
  switch (v.status) {
    case "valid":
      return "valid";
    case "invalid":
      return `INVALID (HTTP ${v.httpStatus})`;
    case "unreachable":
      return `could not verify — ${v.reason}`;
    case "missing":
      return "missing";
    case "skipped":
      return "not verified (--no-verify)";
  }
}
