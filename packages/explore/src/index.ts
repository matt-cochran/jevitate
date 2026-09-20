/** @jevitate/explore — bounded perceive→decide→act→record exploration engine. */
export const EXPLORE = "explore" as const;

export * from "./bounds.js";
export * from "./authorized-targets.js";
export * from "./redact.js";
export * from "./snapshot.js";
export * from "./decide.js";
export * from "./fill.js";
export * from "./act.js";
export * from "./record.js";
export * from "./explore.js";
export * from "./missions/goal-based.js";

// Ticket #2 — feature-testing mission (capability-scoped path discovery).
export * from "./feature/capability-scope.js";
export * from "./feature/boundary-values.js";
export * from "./missions/feature.js";
