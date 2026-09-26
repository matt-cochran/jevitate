/**
 * Authorized-target-only guard (guardrail #1: authoring/test plane only —
 * never production writes). Autonomous exploration may only ever touch an
 * origin the caller has explicitly declared. Everything about this is
 * fail-closed:
 *
 *  - an empty allowlist authorizes NOTHING (not everything),
 *  - a URL that does not parse is refused (not "probably fine"),
 *  - a `javascript:` / `data:` / `file:` scheme is refused,
 *  - the check is by ORIGIN (scheme + host + port), so a path or query can
 *    never smuggle a call onto an unauthorized host.
 *
 * This runs before anything else in a run: no snapshot, no decision, no
 * action happens until the target origin is proven authorized.
 */

export class UnauthorizedExploreTargetError extends Error {
  readonly code = "E_UNAUTHORIZED_EXPLORE_TARGET" as const;
  constructor(
    readonly url: string,
    readonly allowlist: readonly string[],
  ) {
    super(
      `exploration target ${JSON.stringify(url)} is not an authorized origin ` +
        `(allowed: ${allowlist.length === 0 ? "<none>" : allowlist.join(", ")}) — refused`,
    );
    this.name = "UnauthorizedExploreTargetError";
  }
}

/** The safe origin of a URL, or `null` when it has none we will act on. */
function originOf(raw: string): string | null {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return null;
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") return null;
  return u.origin;
}

/**
 * Normalizes an allowlist entry to an origin. An entry may be a bare origin
 * (`http://127.0.0.1:3000`) or a full URL (its origin is taken). An entry
 * that is not a parseable http(s) URL is dropped — it can never authorize
 * anything, which keeps the guard fail-closed rather than letting a typo
 * widen it.
 */
export function normalizeAllowlist(allowlist: readonly string[]): string[] {
  const out: string[] = [];
  for (const entry of allowlist) {
    const origin = originOf(entry);
    if (origin !== null && !out.includes(origin)) out.push(origin);
  }
  return out;
}

/**
 * Throws `UnauthorizedExploreTargetError` unless `url`'s origin is in
 * `allowlist`. Returns the proven origin on success (never a boolean — a
 * caller must not be able to ignore the refusal).
 */
export function assertAuthorizedExploreTarget(
  url: string,
  allowlist: readonly string[],
): string {
  const origin = originOf(url);
  const allowed = normalizeAllowlist(allowlist);
  if (origin === null || !allowed.includes(origin)) {
    throw new UnauthorizedExploreTargetError(url, allowlist);
  }
  return origin;
}

/** Non-throwing companion, for callers that want to branch rather than catch. */
export function isAuthorizedExploreTarget(url: string, allowlist: readonly string[]): boolean {
  const origin = originOf(url);
  return origin !== null && normalizeAllowlist(allowlist).includes(origin);
}

/**
 * The "site" a host belongs to, for the third-party test (#194) — deliberately LOOSE: an IP address
 * or a single-label host (`localhost`) is its own site; any other host is its last two labels. With
 * no public-suffix list, `a.example.co.uk` and `b.other.co.uk` share the site `co.uk`: a coarser site
 * only makes MORE hosts first-party, i.e. more writes stay blocked — the safe direction.
 */
function siteOf(host: string): string {
  const h = host.toLowerCase().replace(/\.$/, "");
  if (h.startsWith("[") || /^\d{1,3}(?:\.\d{1,3}){3}$/.test(h)) return h;
  const labels = h.split(".");
  return labels.length <= 2 ? h : labels.slice(-2).join(".");
}

/**
 * The origin of a request URL when it is THIRD-PARTY to the run (#194) — decided by code from the
 * URL, never by the model — or `null` when it is the app's own (first-party).
 *
 * Third-party means: an http(s) origin that is not on the allowlist AND whose host shares neither the
 * host nor the site (`siteOf`) of any allowed origin. So an app's own API on a sibling subdomain
 * (`api.example.com` next to an allowed `app.example.com`) or on another port of an allowed host stays
 * first-party. Fail-closed: a URL that does not parse, a non-http(s) scheme (`data:`, `blob:`) or an
 * empty allowlist is never third-party (the caller keeps treating it as the app's).
 * Evidence: Stripe.js's fraud-signal beacon `POST https://m.stripe.com/6` is third-party.
 */
export function thirdPartyOrigin(url: string, allowlist: readonly string[]): string | null {
  const origin = originOf(url);
  if (origin === null) return null;
  const allowed = normalizeAllowlist(allowlist);
  if (allowed.length === 0 || allowed.includes(origin)) return null;
  const host = new URL(origin).hostname;
  for (const a of allowed) {
    const ah = new URL(a).hostname;
    if (ah === host || siteOf(ah) === siteOf(host)) return null;
  }
  return origin;
}

/**
 * How a request is named in side effects and refusals (#194): its path when its origin is an allowed
 * one; otherwise origin + path, so an off-origin request never shows as a bare path (`/6` was Stripe's
 * `https://m.stripe.com/6`). Never the query or hash (they can carry a token). An empty allowlist
 * names every request in full.
 */
export function requestEndpoint(url: string, allowlist: readonly string[]): string {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return url.split(/[?#]/)[0] ?? url;
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") return u.pathname;
  return normalizeAllowlist(allowlist).includes(u.origin) ? u.pathname : `${u.origin}${u.pathname}`;
}
