import type { Assertion, AssertionOperand } from "./schema.js";

/**
 * #562/#565 — parameter-relative assertion operands. An assertion's expected text or value
 * (`textIncludes.text`, `valueEquals.value`, `attr.value`) is a literal that may carry `${name}`
 * placeholders, or `{ var: name }`. Before a check runs, every reference is resolved to the value
 * bound to `name` in this run (a Journey parameter, an earlier `extract` step's output, a `setup.x`
 * fixture output). Fails closed: an unbound name, a secret one, or a non-string value is an error
 * that names the reference — never the value.
 */

/** A `${name}` placeholder (the grammar the `http` check's URL and assertions use, #543). */
export const PLACEHOLDER_RE = /\$\{([^}]*)\}/g;

/** What a reference is bound to in this run: its value, and whether it is a secret (refused). */
export interface AssertionRefBinding {
  readonly value: unknown;
  readonly secret: boolean;
}

/** Resolves a reference name to its binding; `undefined` when the run binds nothing to it. */
export type AssertionRefLookup = (name: string) => AssertionRefBinding | undefined;

/** An assertion refers to a name this run does not bind. */
export const E_ASSERTION_REF_UNBOUND = "E_ASSERTION_REF_UNBOUND";
/** An assertion refers to a secret: its value would land in model-visible text and artifacts. */
export const E_ASSERTION_REF_SECRET = "E_ASSERTION_REF_SECRET";
/** An assertion refers to a binding whose value is not a string. */
export const E_ASSERTION_REF_TYPE = "E_ASSERTION_REF_TYPE";

export type AssertionRefErrorCode = typeof E_ASSERTION_REF_UNBOUND | typeof E_ASSERTION_REF_SECRET | typeof E_ASSERTION_REF_TYPE;

/** A reference that could not be resolved. The message names the reference only, never a value. */
export class AssertionRefError extends Error {
  constructor(
    readonly code: AssertionRefErrorCode,
    readonly ref: string,
    detail: string,
  ) {
    super(`${code}: \${${ref}} ${detail}`);
    this.name = "AssertionRefError";
  }
}

/** Every `${name}` in `text`, in order (repeats kept). */
export function placeholderNames(text: string): string[] {
  return [...text.matchAll(PLACEHOLDER_RE)].map((m) => m[1] ?? "");
}

/** `text` with every `${name}` replaced by `resolve(name)` (values inserted verbatim). */
export function expandPlaceholders(text: string, resolve: (name: string) => string): string {
  return text.replace(PLACEHOLDER_RE, (_m, name: string) => resolve(name));
}

/** The operands of an assertion that may refer to a binding (absent ones left out). */
function operands(a: Assertion): AssertionOperand[] {
  switch (a.kind) {
    case "textIncludes":
      return [a.text];
    case "valueEquals":
      return [a.value];
    case "attr":
      return a.value === undefined ? [] : [a.value];
    default:
      return [];
  }
}

function operandRefs(op: AssertionOperand): string[] {
  return typeof op === "string" ? placeholderNames(op) : [op.var];
}

/** The names an assertion refers to, each once, in order — for static validation and lint. */
export function assertionRefs(a: Assertion): string[] {
  return [...new Set(operands(a).flatMap(operandRefs))];
}

/** An operand as text for people and specs: a literal as-is, `{ var: x }` as `${x}`. Never a value. */
export function describeOperand(op: AssertionOperand): string {
  return typeof op === "string" ? op : `\${${op.var}}`;
}

/**
 * A literal operand's text. A `{ var }` operand that reached a check unresolved fails closed (an
 * `E_ASSERTION_REF_UNBOUND`) — it is never compared as if it were text.
 */
export function literalOperand(op: AssertionOperand): string {
  if (typeof op === "string") return op;
  throw new AssertionRefError(E_ASSERTION_REF_UNBOUND, op.var, "was not resolved before the check ran");
}

function bound(name: string, lookup: AssertionRefLookup): string {
  const b = lookup(name);
  if (b === undefined) throw new AssertionRefError(E_ASSERTION_REF_UNBOUND, name, "is not bound in this run (declare it as a parameter, or extract it in an earlier step)");
  if (b.secret) throw new AssertionRefError(E_ASSERTION_REF_SECRET, name, "is a secret — an assertion's expected text is model-visible and persisted, so it may not use one");
  if (typeof b.value !== "string") throw new AssertionRefError(E_ASSERTION_REF_TYPE, name, `is bound to a ${b.value === null ? "null" : typeof b.value}, not a string`);
  return b.value;
}

function resolveOperand(op: AssertionOperand, lookup: AssertionRefLookup): string {
  return typeof op === "string" ? expandPlaceholders(op, (n) => bound(n, lookup)) : bound(op.var, lookup);
}

/**
 * The assertion with every operand a literal: `{ var: x }` replaced by x's value and every `${x}`
 * expanded. An assertion without references comes back unchanged (the same object). Throws an
 * `AssertionRefError` for an unbound, secret or non-string binding.
 */
export function resolveAssertionRefs(a: Assertion, lookup: AssertionRefLookup): Assertion {
  if (assertionRefs(a).length === 0) return a;
  switch (a.kind) {
    case "textIncludes":
      return { ...a, text: resolveOperand(a.text, lookup) };
    case "valueEquals":
      return { ...a, value: resolveOperand(a.value, lookup) };
    case "attr":
      return a.value === undefined ? a : { ...a, value: resolveOperand(a.value, lookup) };
    default:
      return a;
  }
}
