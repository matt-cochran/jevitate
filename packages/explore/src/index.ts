/** @jevitate/explore — bounded perceive→decide→act→record exploration engine. */
export const EXPLORE = "explore" as const;

export * from "./bounds.js";
export * from "./authorized-targets.js";
export * from "./redact.js";
export * from "./snapshot.js";
export * from "./perceive.js";
export * from "./actions.js";
export * from "./transcript.js";
export * from "./decide.js";
export * from "./fill.js";
export * from "./act.js";
export * from "./fixture.js";
export * from "./record.js";
export * from "./explore.js";
export * from "./missions/goal-based.js";
export * from "./authoring/author-journey.js";
export * from "./authoring/auto-decide.js";
export * from "./authoring/value-capturing-generation-port.js";
export * from "./missions/induction.js";
export * from "./adversarial/input-strategy.js";
export * from "./adversarial/defect-oracle.js";
export * from "./adversarial/misuse.js";
export * from "./missions/adversarial.js";

// Ticket #2 — feature-testing mission (capability-scoped path discovery).
export * from "./feature/capability-scope.js";
export * from "./feature/boundary-values.js";
export * from "./missions/feature.js";
export * from "./mission-failure.js";
