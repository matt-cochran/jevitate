/** @doit/ai-core — model gateways (generation + judgment) and credential preflight. */
export const AI_CORE = "ai-core" as const;

export * from "./credentials.js";
export * from "./credential-guard.js";
export * from "./generation.js";
export * from "./model-policy.js";
