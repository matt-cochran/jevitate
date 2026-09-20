export type SelfHealMode = "fail-closed" | "hybrid" | "full";
export type Direction = "deterministic" | "jev-directed" | "goal-based";
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
