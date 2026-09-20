import type { Step, Assertion } from "@jevitate/recording";

/**
 * Mirrors `@jevitate/sources`'s `classifyRisk`'s per-step-kind judgment
 * (`READ_ONLY_KINDS`), duplicated here rather than imported: `@jevitate/sources`
 * depends on `@jevitate/journey`/`@jevitate/recording`, and `@jevitate/runtime`
 * must stay upstream of `@jevitate/sources` in the dependency graph (runtime
 * executes what sources resolves), so importing from `@jevitate/sources`
 * here would invert that edge. Flagged as a deliberate, small duplication
 * (see this plan's Risks section) — a future refactor could lift both onto
 * one shared `@jevitate/recording` export.
 */
const READ_ONLY_STEP_KINDS = new Set<Step["kind"]>(["navigate", "waitFor", "extract", "assert"]);

/** §9a invariant #8's unconditional floor: true for every step kind that
 * is NOT in `READ_ONLY_STEP_KINDS` — never bypassed by any `SelfHealMode`. */
export function isWriteStep(step: Step): boolean {
  return !READ_ONLY_STEP_KINDS.has(step.kind);
}

/** The failing step's own postcondition, if it carries one — this is what a
 * scoped re-learn must reach. `waitFor` (a `state`, not an `Assertion`) and
 * `forEach` (a control-flow container) have none and can never be
 * self-healed via this mechanism. */
export function postconditionOf(step: Step): Assertion | undefined {
  switch (step.kind) {
    case "navigate":
    case "click":
    case "fill":
    case "select":
    case "press":
    case "extract":
      return step.expect;
    case "assert":
      return step.check;
    default:
      return undefined;
  }
}
