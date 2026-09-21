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

/**
 * More than one declared `SecretRef` matched the current page's origin.
 * Distinct from `SecretOriginMismatchError`: the origin(s) DID match — the
 * problem is that more than one candidate did, so there is no unambiguous
 * choice of which one to fill. Slice 1b scope deliberately does not
 * disambiguate multiple same-origin secrets by `field` (see
 * `@jevitate/runtime`'s `JourneyRunner.fillViaVaultAutofill` doc comment) — this
 * still fails closed, it just names the actual failure mode instead of
 * misreporting it as an origin mismatch.
 */
export class SecretAmbiguousBindingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SecretAmbiguousBindingError";
  }
}
