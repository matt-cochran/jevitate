import type { SecretRef } from "./secret-ref.js";
import type { Secret } from "./secret.js";

/**
 * Thin delegation to an EXTERNAL password/secret manager. The platform
 * implements NO vault of its own — every method here fetches on demand
 * from whatever manager `ref.manager` names; nothing is cached or
 * persisted by an implementation of this port (Hard Floor #6: "we store no
 * secrets at rest").
 */
export interface SecretManagerPort {
  /**
   * Fail-fast preflight check (§9a invariant #4): resolves cleanly, or
   * throws `SecretUnresolvableError` with an actionable message. Must be
   * called BEFORE any step runs — never mid-run.
   */
  assertResolvable(ref: SecretRef): Promise<void>;

  /** Fetches the secret's current value on demand. Never caches it. */
  fetch(ref: SecretRef): Promise<Secret>;
}
