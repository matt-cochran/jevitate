/**
 * Invariant #10 (spec §9a): load only runs against an explicit
 * authorized-target allowlist. Fail-closed — an empty or missing allowlist
 * is a refusal, never an implicit "anything goes".
 */
export class UnauthorizedLoadTargetError extends Error {}

/** Parses `raw` and returns its normalized origin (scheme + lowercased host
 *  + port, no trailing slash/path), or `null` if `raw` is not a parseable
 *  URL. `null` is a fail-closed sentinel: it never equals another `null`
 *  origin comparison-wise in `assertAuthorizedTarget` below (both sides are
 *  required to be non-null AND equal), so an unparseable value can never
 *  accidentally satisfy the allowlist check. */
function safeOrigin(raw: string): string | null {
  try {
    return new URL(raw).origin;
  } catch {
    return null;
  }
}

/**
 * Compares by PARSED origin, not exact string equality, so cosmetic
 * differences (a trailing slash, hostname case) between a configured
 * allowlist entry and the actual target still match — while a genuinely
 * different origin (different scheme/host/port) still fails closed. Either
 * side failing to parse as a URL also fails closed (never treated as a
 * match).
 */
export function assertAuthorizedTarget(targetOrigin: string, authorizedOrigins: readonly string[]): void {
  const target = safeOrigin(targetOrigin);
  const authorized = target !== null && authorizedOrigins.some((o) => safeOrigin(o) === target);
  if (!authorized) {
    throw new UnauthorizedLoadTargetError(
      `refusing to load-test '${targetOrigin}' — not in the authorized-origins allowlist ` +
        `[${authorizedOrigins.join(", ")}]`,
    );
  }
}
