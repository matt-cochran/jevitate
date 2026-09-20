/**
 * Typed fail-closed errors for the distributed-sources trust boundary
 * (spec §9 hard floors, §12 FMECA). Every gate in this package throws one of
 * these rather than returning a degraded "ok" — see
 * `scripts/check-no-permissive-fallback.mjs` and `invariants.test.ts`.
 */

/** A `jevitate.json` manifest or `journeys/*.journey.json` file failed to
 * load or validate (missing, malformed, unknown keys, wrong version, or
 * missing required declarations). A source is a trust boundary: unlike the
 * tolerant local `FsJourneyStore.list`, one bad file fails the whole load. */
export class SourceValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SourceValidationError";
  }
}

/** FMECA #5 / §9.8 — an address (`<source>/<id>`) names a source the
 * `FederatedJourneyRegistry` doesn't know about, or an id the source doesn't
 * have. Never falls back to "closest match" or an empty result. */
export class UnknownSourceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UnknownSourceError";
  }
}

/** FMECA #2 (TOCTOU) — the recomputed content hash of a Journey differs from
 * the hash recorded in its `TrustRecord`. The bytes changed since review;
 * trust does not carry forward automatically. */
export class HashMismatchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "HashMismatchError";
  }
}

/** §9.8 — a Journey's `declaredOrigins` includes an origin the source's
 * `jevitate.json` manifest does not declare a `SiteDeclaration` for. */
export class UndeclaredOriginError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UndeclaredOriginError";
  }
}

/** FMECA #6 / §5 — the engine-derived risk classifier says `risky` and no
 * `TrustRecord` (hash-bound, human-approved) exists for this exact content.
 * An author's own `riskClass` claim, if any, is never consulted. */
export class UntrustedRiskyJourneyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UntrustedRiskyJourneyError";
  }
}

/** FMECA #4 / §8 — a declared origin has no acknowledged Terms-of-Use basis
 * (no `SiteDeclaration` covering it and/or no recorded `TouAck`). */
export class UndeclaredTouError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UndeclaredTouError";
  }
}

/** FMECA #3 / §9.7 — a `fill`/`select` step carries a materialized,
 * non-redacted secret value (`{ redacted: false, value }`) rather than a
 * `SecretRef`. Blocks on both publish and import. */
export class EmbeddedSecretError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EmbeddedSecretError";
  }
}
