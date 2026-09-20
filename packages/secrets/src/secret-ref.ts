/**
 * A reference to a secret held by an EXTERNAL password manager — never a
 * value. The platform owns no vault; this is the whole shape a Journey (or
 * anything else) may hold at rest for a secret (§9a invariant #2: "a
 * Journey/Recording may hold only a manager reference, never a value").
 *
 * Structurally identical to `@doit/journey`'s `SecretRef`
 * (packages/journey/src/journey.ts) — deliberately duplicated, not
 * imported, so `@doit/secrets` stays a dependency-free leaf package.
 * TypeScript's structural typing makes the two interchangeable at call
 * sites with zero casting.
 */
export interface SecretRef {
  manager: string;
  key: string;
  origin: string;
  field: string;
}
