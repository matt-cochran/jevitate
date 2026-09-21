import type { Control } from "../index.js";

/**
 * Field-semantics input-value selection for the adversarial mission (spec §3.1:
 * "never blind fuzz"). A misuse step deliberately overrides Jev's free-form
 * fill with a boundary/empty/long/unicode/invalid value chosen by the field's
 * role/name — never a generative guess, never real PII, never a real recipient.
 */

export type InputStrategy = "empty" | "boundary" | "long" | "unicode" | "invalid" | "normal";

const ORDER: readonly InputStrategy[] = ["empty", "boundary", "long", "unicode", "invalid", "normal"];

/**
 * Bounded: returns the next untried strategy in a FIXED order, and `null` once
 * every strategy in `ORDER` has been tried for this control — so a misuse loop
 * can never cycle forever on one field (guardrail #2: bounded + fail-closed).
 */
export function chooseInputStrategy(
  _control: Control,
  tried: readonly InputStrategy[],
): InputStrategy | null {
  return ORDER.find((s) => !tried.includes(s)) ?? null;
}

function isEmailLike(name: string): boolean {
  return /e-?mail/i.test(name);
}
function isNumericLike(name: string): boolean {
  return /quantity|qty|amount|count|price|age/i.test(name);
}

/** Field-semantics value selection — NEVER blind fuzz (spec §3.1). */
export function valueFor(strategy: InputStrategy, control: Control): string {
  const name = control.name ?? "";
  switch (strategy) {
    case "empty":
      return "";
    case "boundary":
      return isNumericLike(name) ? "0" : "x";
    case "long":
      return "x".repeat(2000);
    case "unicode":
      return "مرحبا 😀 тест";
    case "invalid":
      return isEmailLike(name) ? "not-an-email" : isNumericLike(name) ? "-1" : "\u0000invalid\u0000";
    case "normal":
      return isEmailLike(name) ? "test@example.test" : "test-value";
  }
}
