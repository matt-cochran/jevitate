export * from "./policy-error.js";
export * from "./site-gate.js";
export * from "./journey-runner.js";
export * from "./self-heal.js";
export * from "./change-scope.js";
export * from "./change-scope-explain.js";
export * from "./heal-budget.js";
export * from "./heal-attempt.js";
export * from "./change-extract.js";
export * from "./write-sentinel.js";
// 0.30.0 §5.3: what a surface needs to give a run its vault-autofill bindings (the CLI's targets.json adapter).
export { Secret, SecretOriginMismatchError, SecretUnresolvableError } from "@jevitate/secrets";
export type { SecretManagerPort } from "@jevitate/secrets";
