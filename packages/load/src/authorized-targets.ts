/**
 * Invariant #10 (spec §9a): load only runs against an explicit
 * authorized-target allowlist. Fail-closed — an empty or missing allowlist
 * is a refusal, never an implicit "anything goes".
 */
export class UnauthorizedLoadTargetError extends Error {}

export function assertAuthorizedTarget(targetOrigin: string, authorizedOrigins: readonly string[]): void {
  if (!authorizedOrigins.includes(targetOrigin)) {
    throw new UnauthorizedLoadTargetError(
      `refusing to load-test '${targetOrigin}' — not in the authorized-origins allowlist ` +
        `[${authorizedOrigins.join(", ")}]`,
    );
  }
}
