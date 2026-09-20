import type { Control } from "../snapshot.js";

const SECRET_NAME = /password|passwd|secret|token|ssn|social security|credit ?card|cvv/i;
const NUMERIC_NAME = /quantity|qty|amount|count/i;

/** True when a field's accessible name looks secret/credential-bearing. */
export function isSecretLike(control: Control): boolean {
  return SECRET_NAME.test(control.name);
}

/**
 * VALID edge-case values — deliberately distinct from ticket #4's
 * adversarial/invalid values. These are values a real, well-behaved user might
 * plausibly submit at the edge of normal (a cart quantity of zero, the minimum
 * viable single-character username), never a deliberately malformed one.
 *
 * A secret-like field returns NO candidates (guardrail #3): it is never
 * stimulated, never filled with a synthetic value.
 *
 * The real shipped `Control` (../snapshot.ts) carries no select-option list,
 * so a `combobox` falls back to the same generic single candidate as any other
 * field — a known, named simplification pending `Control` gaining option
 * metadata, documented rather than faked.
 */
export function boundaryValueCandidates(control: Control): string[] {
  if (isSecretLike(control)) return [];
  if (control.role === "textbox" && NUMERIC_NAME.test(control.name)) return ["0", "1", "99"];
  return ["x"];
}
