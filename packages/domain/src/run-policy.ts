export type SelfHealMode = "fail-closed" | "hybrid" | "full";
export type Direction = "deterministic" | "jev-directed" | "goal-based";
// Slice 1b (thin external-manager secret delegation) implements the
// "vault-autofill" branch of secretMode's behavior in @jevitate/runtime's
// JourneyRunner. It is already a member of this union as of Slice 1 and
// requires NO new field here — a vault-autofill run's manager/key/origin
// come from the Journey's own `metadata.secretRefs` (see
// packages/journey/src/journey.ts's `SecretRef`), never from RunPolicy.
export type SecretMode = "vault-autofill" | "visible-handback" | "fail-closed";

export interface RunPolicy {
  selfHeal: { mode: SelfHealMode };
  direction: { direction: Direction };
  secret: { secretMode: SecretMode };
}

/** The only blessed default. It is SAFE, never permissive. */
export function safeRunPolicy(): RunPolicy {
  return {
    selfHeal: { mode: "fail-closed" },
    direction: { direction: "deterministic" },
    secret: { secretMode: "fail-closed" },
  };
}
