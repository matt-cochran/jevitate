export type SelfHealMode = "fail-closed" | "hybrid" | "full";
export type Direction = "deterministic" | "jev-directed" | "goal-based";
// Slice 1b (thin external-manager secret delegation) implements the
// "vault-autofill" branch of secretMode's behavior in @jevitate/runtime's
// JourneyRunner. It is already a member of this union as of Slice 1 and
// requires NO new field here — a vault-autofill run's manager/key/origin
// come from the Journey's own `metadata.secretRefs` (see
// packages/journey/src/journey.ts's `SecretRef`), never from RunPolicy.
export type SecretMode = "vault-autofill" | "visible-handback" | "fail-closed";

/**
 * #453: how much a change-aware self-heal may spend. One candidate tried = one attempt; model calls
 * and tokens are what the healer reports; wall-clock is measured on `clock`. `perStep` bounds one
 * broken step, `perRun` the whole run (`maxBrokenSteps`: how many distinct steps may be healed).
 */
export interface HealBudget {
  perStep: { maxAttempts: number; maxModelCalls: number; maxTokens?: number; maxMs: number };
  perRun: { maxAttempts: number; maxModelCalls: number; maxTokens?: number; maxMs: number; maxBrokenSteps: number };
}

export interface RunPolicy {
  /** `budget` absent → the runtime's `DEFAULT_HEAL_BUDGET`. Ignored under `fail-closed`. */
  selfHeal: { mode: SelfHealMode; budget?: HealBudget };
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
