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
export * from "./authoring/author-journey.js";
export * from "./authoring/auto-decide.js";
export * from "./authoring/value-capturing-generation-port.js";
export * from "./missions/induction.js";
