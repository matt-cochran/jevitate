/** §9a invariant #3: origin (or expected-field) mismatch before a secret
 * fill — never fills, always throws. */
export class SecretOriginMismatchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SecretOriginMismatchError";
  }
}

/** §9a invariant #4: the declared manager+entry could not be resolved.
 * Raised at PREFLIGHT (before any step runs), never as a mid-run silent
 * skip. */
export class SecretUnresolvableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SecretUnresolvableError";
  }
}
