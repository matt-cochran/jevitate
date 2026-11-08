import type { Assertion, AssertionOperand } from "./schema.js";
import { encodeUrlParamValue } from "./navigate-params.js";

/**
 * #562/#565 — parameter-relative assertion operands. An assertion's expected text or value
 * (`textIncludes.text`, `valueEquals.value`, `attr.value`) is a literal that may carry `${name}`
 * placeholders, or `{ var: name }`. Before a check runs, every reference is resolved to the value
 * bound to `name` in this run (a Journey parameter, an earlier `extract` step's output, a `setup.x`
 * fixture output). Fails closed: an unbound name, a secret one, or a non-string value is an error
 * that names the reference — never the value.
 *
 * #566: `urlIncludes.text` may carry `${name}` placeholders too (the URL a templated `navigate`
 * reaches, e.g. `/threads/${thread}`). Each value is inserted percent-encoded exactly as a navigate
 * URL placeholder is (`encodeUrlParamValue`), so the check compares like with like against the
 * page's (encoded) URL.
 */

/**
 * Terms that read as a credential anywhere in a name, separators ignored. Deliberately broad, and it
 * will match ordinary words (`passengers`, `token_count`, `footprint`): a refusal has a way out, a
 * Journey's declared `secret: false` with a person's approval, and a credential that slips through
 * has none. `auth` leaves out `author`, and `ssword` catches a misspelt or accented `password`.
 */
const SECRET_ANYWHERE_RE =
  /pass|pwd|ssword|p4ss|s3cret|secret|t0ken|token|otp|auth(?!or(?!iz))|bearer|jwt|credential|session|sessid|cookie|csrf|xsrf|mfa|2fa|twofactor|cvv|cvc|hmac|nonce|saml|assertion|signature|iban|dsn|apikey|privatekey|accesskey|sshkey|signingkey|encryptionkey|sharedkey|licensekey|pincode|pinnumber|smscode|verificationcode|recoverycode|backupcode|invitecode|securitycode|securityanswer|cardnumber|ccnumber|creditcard|webhookurl|connectionstring|magiclink|resetlink|kennwort|wachtwoord|contrase|senha|clave|parola|пароль|密码|暗号|パスワード/;

/** Short terms that are everyday letters inside other words (`shipping`, `inside`, `classname`), so they need their own edges. */
const SECRET_BOUNDED_RE = /(?<![\p{L}\p{N}])(?:pins?|pw|sess|sid|ssn|creds?|key|tfa|mdp)(?![\p{L}])|pin(?![\p{L}])|pw(?![\p{L}])/u;

/**
 * Does this binding NAME read as a credential (a parameter, an `extract` output, a fixture output)?
 * A name can't prove a value is safe, so this errs on the side of matching. Defense in depth: a
 * parameter so named is secret, unless it declares `secret: false` and a person approved the Journey
 * (`declaredNonSecretParams`), and (#564) an assertion may never reference a value so named: its text
 * would be model-visible and persisted. Re-exported by `@jevitate/journey`.
 */
export function isSecretName(name: string): boolean {
  const lower = name.toLowerCase();
  if (SECRET_ANYWHERE_RE.test(lower.replace(/[^\p{L}\p{N}]+/gu, ""))) return true;
  return SECRET_BOUNDED_RE.test(name.replace(/(\p{Ll}|\p{N})(\p{Lu})/gu, "$1_$2").replace(/(\p{Lu}+)(\p{Lu}\p{Ll})/gu, "$1_$2").toLowerCase());
}

/**
 * What decides whether a stored Journey loads and whether an assertion may name a value: the older,
 * narrower rule. `isSecretName` is for refusing a value and for redaction. Widening it must not turn
 * a Journey that loaded into one that doesn't: a body-shape field or an assertion on `key` stays valid,
 * and its value is still refused over MCP and redacted.
 */
const LOAD_REFUSED_NAME_RE = /pass(word|code|phrase)?|secret|token|api[_-]?key|otp|pin\b|credential|session|cookie/i;

export function isLoadRefusedName(name: string): boolean {
  return LOAD_REFUSED_NAME_RE.test(name);
}

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
    case "urlIncludes":
      return [a.text];
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
    case "urlIncludes":
      return { ...a, text: expandPlaceholders(a.text, (n) => encodeUrlParamValue(bound(n, lookup))) };
    default:
      return a;
  }
}
