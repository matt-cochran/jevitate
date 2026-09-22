export type CommandState =
  | "queued" | "validating" | "awaiting_approval" | "ready"
  | "leased" | "running" | "succeeded" | "failed"
  | "denied" | "expired" | "retry" | "quarantined" | "reconciling";

export const TRANSITIONS: Record<CommandState, CommandState[]> = {
  queued: ["validating", "denied"],
  validating: ["awaiting_approval", "ready", "denied"],
  awaiting_approval: ["ready", "denied", "expired"],
  ready: ["leased"],
  leased: ["running", "ready", "retry", "expired"],
  running: ["succeeded", "failed", "retry", "quarantined", "reconciling"],
  retry: ["ready", "failed"],
  reconciling: ["succeeded", "failed", "quarantined"],
  succeeded: [],
  failed: [],
  denied: [],
  expired: [],
  quarantined: [],
};

export class IllegalTransitionError extends Error {
  constructor(from: CommandState, to: CommandState) {
    super(`Illegal command transition: ${from} -> ${to}`);
    this.name = "IllegalTransitionError";
  }
}

export function canTransition(from: CommandState, to: CommandState): boolean {
  return TRANSITIONS[from].includes(to);
}

export function transition(from: CommandState, to: CommandState): CommandState {
  if (!canTransition(from, to)) throw new IllegalTransitionError(from, to);
  return to;
}
