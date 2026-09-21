import type { SecretRef } from "./secret-ref.js";
import { SecretOriginMismatchError } from "./errors.js";

/** Normalizes a URL string down to its origin (scheme+host+port), so
 * "https://example.com/login" and "https://example.com" compare equal. */
function originOf(url: string): string {
  return new URL(url).origin;
}

/**
 * §9a invariant #3: before any secret fill, assert the CURRENT page's
 * origin equals `ref.origin` exactly. Throws `SecretOriginMismatchError`
 * (never fills) on any mismatch — including a same-site-but-different-port
 * or -scheme redirect/injection.
 */
export function assertOriginBound(ref: SecretRef, currentUrl: string): void {
  const current = originOf(currentUrl);
  const bound = originOf(ref.origin);
  if (current !== bound) {
    throw new SecretOriginMismatchError(
      `secret "${ref.key}" is bound to origin ${bound}, but the current page is ${current} — refusing to fill`,
    );
  }
}
