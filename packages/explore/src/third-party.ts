import { thirdPartyOrigin } from "./authorized-targets.js";

/**
 * Which requests are THIRD-PARTY to a run (#194) — decided by code from the request itself, never by
 * the model. A third-party write is not the mission's: the read-only guard lets it through and the
 * side-effect log marks it `thirdParty` (Stripe.js's fraud beacon `POST https://m.stripe.com/6`).
 *
 * An off-site origin alone does NOT make a request third-party: many apps' own backends live on an
 * unrelated site (Supabase `<ref>.supabase.co`, Firestore `firestore.googleapis.com`, AWS API Gateway
 * `*.execute-api.*.amazonaws.com`, Heroku/Render/Fly hosts, Hasura…). So a request is first-party when
 *  - its origin is an `--allow` origin, or shares an allowed origin's host or site (`thirdPartyOrigin`);
 *  - it carries API credentials (`API_CREDENTIAL_HEADERS`) — an API the page authenticates to is
 *    treated as the app's backend, whatever its host; or
 *  - the page already sent a credentialed request to its origin during this run — so that backend's
 *    unauthenticated writes (a sign-up, a password reset) are first-party too.
 *
 * LIMIT (documented in docs/safety.md): a credential-free write to an origin never seen with
 * credentials still passes as third-party. Add that origin to `--allow` to have its writes blocked.
 */

/**
 * Request headers that carry credentials for an API (lower-case names; a RegExp matches a family).
 * Deliberately broad: a header wrongly counted here only makes a write first-party (blocked on a
 * read-only goal) — the safe side.
 */
export const API_CREDENTIAL_HEADERS: readonly RegExp[] = [
  /^authorization$/, // Bearer / Basic / AWS SigV4 …
  /^proxy-authorization$/,
  /^apikey$/, // Supabase
  /^api-key$/,
  /^x-api-key$/, // AWS API Gateway, many SaaS APIs
  /^x-apikey$/,
  /^x-auth-token$/,
  /^x-access-token$/,
  /^x-(?:csrf|xsrf)-token$/, // a CSRF token is the app's own session
  /^x-amz-security-token$/,
  /^x-firebase-/, // x-firebase-appcheck, x-firebase-gmpid …
  /^x-goog-/, // x-goog-api-key, x-goog-user-project … (the whole family, conservatively)
  /^x-hasura-/, // x-hasura-admin-secret, x-hasura-role …
  /^x-supabase-/,
  /^x-parse-(?:application-id|rest-api-key|session-token)$/,
];

/** Does a request carry API credentials? (header names compared case-insensitively) */
export function hasApiCredentials(headers: Readonly<Record<string, string>>): boolean {
  return Object.keys(headers).some((name) => {
    const n = name.toLowerCase();
    return API_CREDENTIAL_HEADERS.some((re) => re.test(n));
  });
}

function originOf(url: string): string | null {
  try {
    const u = new URL(url);
    return u.protocol === "http:" || u.protocol === "https:" ? u.origin : null;
  } catch {
    return null;
  }
}

/** A run's first-party origins: the allowlist's sites plus every origin the page authenticated to. */
export class FirstPartyOrigins {
  readonly #allowlist: readonly string[];
  /** Origins the page sent a credentialed request to during this run. */
  readonly #credentialed = new Set<string>();

  constructor(allowlist: readonly string[]) {
    this.#allowlist = allowlist;
  }

  /** Every request the page sends is observed here: returns whether it carries API credentials. */
  observe(url: string, headers: Readonly<Record<string, string>>): boolean {
    if (!hasApiCredentials(headers)) return false;
    const origin = originOf(url);
    if (origin !== null) this.#credentialed.add(origin);
    return true;
  }

  /**
   * The request's origin when it is third-party, else null. `headers`, when given, are the request's
   * own: credentials in them make it first-party (and are remembered for its origin).
   */
  thirdParty(url: string, headers?: Readonly<Record<string, string>>): string | null {
    if (headers !== undefined && this.observe(url, headers)) return null;
    const origin = thirdPartyOrigin(url, this.#allowlist);
    if (origin === null || this.#credentialed.has(origin)) return null;
    return origin;
  }
}
