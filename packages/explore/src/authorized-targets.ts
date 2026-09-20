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
