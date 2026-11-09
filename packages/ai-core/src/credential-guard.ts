import { ALL_CREDENTIAL_KEYS, type CredentialKey } from "./credentials.js";

export class CredentialLeakError extends Error {
  readonly code = "E_CREDENTIAL_LEAK" as const;
  constructor(readonly key: CredentialKey) {
    // NOTE: never include the value in the message.
    super(`credential ${key} value found in an outbound payload — refused (floor #6, never-to-model)`);
    this.name = "CredentialLeakError";
  }
}

/** Throws CredentialLeakError if any known key VALUE appears anywhere in the
 *  serialized payload (prompt, tool args, log line, telemetry, provider body).
 *  This is the single choke point every generation/judgment path routes its
 *  outbound payload through BEFORE sending. It is intentionally value-based:
 *  the auth header is built separately and never passes through here. */
export function assertNoOutboundCredential(
  payload: unknown,
  store: { read(k: CredentialKey): string | undefined },
  keys: readonly CredentialKey[] = ALL_CREDENTIAL_KEYS,
): void {
  const haystack = typeof payload === "string" ? payload : JSON.stringify(payload);
  for (const k of keys) {
    const v = store.read(k);
    if (v && v.length > 0 && haystack.includes(v)) throw new CredentialLeakError(k);
  }
}

/** The default sink a `SecretLeakError` names: a payload bound for a model. */
export const SECRET_IN_MODEL_PAYLOAD = "an outbound model payload";

export class SecretLeakError extends Error {
  readonly code = "E_SECRET_LEAK" as const;
  /**
   * `where` names what carried the value (#219) — "an outbound model payload" by default; a sink
   * that is not a model payload (the Recording, a result file) names itself, so a refusal never
   * misattributes its source.
   */
  constructor(
    readonly index: number,
    readonly where: string = SECRET_IN_MODEL_PAYLOAD,
  ) {
    // NOTE: never include the value (or its length) in the message.
    super(`a registered secret value appeared in ${where} — refused (floor #6, never-to-model)`);
    this.name = "SecretLeakError";
  }
}

/**
 * The general-purpose sibling of `assertNoOutboundCredential` for arbitrary
 * USER-supplied secret / PII values (a password, an OTP, an API token the
 * *user's* app owns) — the ones that are NOT provider keys in a
 * `CredentialStore`, and that `jev.ts`'s comment means when it says
 * "redact-before-model already applied by caller."
 *
 * This is the single, shared choke point every autonomous producer (the
 * exploration engine's judgment + generation calls) routes its model-facing
 * payload through BEFORE sending, so guardrail "no secrets to a model" is
 * enforced in ONE place rather than reinvented per package. Value-based on
 * purpose: it proves the redactor upstream actually removed the value, and
 * fails closed if it did not. Blank/empty entries are ignored (a "" would
 * match everything and is never a real secret). A secret is matched raw AND
 * in its `encodeURIComponent` form (`secretForms`).
 */
export function assertNoSecretInPayload(
  payload: unknown,
  secrets: readonly string[],
  where: string = SECRET_IN_MODEL_PAYLOAD,
): void {
  if (secrets.length === 0) return;
  const haystack = typeof payload === "string" ? payload : JSON.stringify(payload);
  // A short secret is matched on token boundaries, which JSON escaping can hide (`"\nme"` reads
  // `\nme`, the `n` glued to it). So a structured payload's string keys and values are also checked
  // one by one, as decoded text — the same text the scrub upstream saw.
  let leaves: string[] | undefined;
  const stringLeaves = (): string[] => {
    if (leaves !== undefined) return leaves;
    const found: string[] = [];
    if (typeof payload !== "string" && haystack !== undefined) {
      JSON.parse(haystack, function (this: unknown, key: string, value: unknown) {
        found.push(key);
        if (typeof value === "string") found.push(value);
        return value;
      });
    }
    return (leaves = found);
  };
  for (let i = 0; i < secrets.length; i++) {
    const s = secrets[i];
    if (!s || s.length === 0) continue;
    if (haystack !== undefined && containsSecret(haystack, s)) throw new SecretLeakError(i, where);
    if (s.length < MIN_SUBSTRING_SECRET_LENGTH && stringLeaves().some((t) => containsSecret(t, s))) {
      throw new SecretLeakError(i, where);
    }
  }
}

/**
 * #454 — the length at which a secret is matched as a plain substring, everywhere. A secret this
 * long is very unlikely to occur by chance inside an ordinary word, so every occurrence is the
 * secret. A SHORTER secret is matched by {@link secretPattern}'s narrower rule, so a username such
 * as `me` does not mangle "Timeout" or trip the payload guard on every word holding those letters.
 * Shared by `redactText` and `assertNoSecretInPayload` (via `secretPattern`) so the scrub and its
 * proof agree.
 */
export const MIN_SUBSTRING_SECRET_LENGTH = 6;

/** F5: from this length a short secret is also found inside a longer token (see {@link secretPattern}). */
const MIN_EMBEDDED_SECRET_LENGTH = 3;

/** True when `secret` is shorter than {@link MIN_SUBSTRING_SECRET_LENGTH} — matched by the short-secret rule. */
export function isWeakSecret(secret: string): boolean {
  return secret.length < MIN_SUBSTRING_SECRET_LENGTH;
}

const REGEX_SYNTAX = /[\\^$.*+?()[\]{}|/]/g;
const LETTER = /\p{L}/u;
const DIGIT = /\p{N}/u;

/** A guard keeping `ch` (a form's edge character) from continuing a run of its own kind on `side`. */
function sameKindGuard(ch: string | undefined, side: "before" | "after"): string {
  const kind = ch === undefined ? null : LETTER.test(ch) ? "\\p{L}" : DIGIT.test(ch) ? "\\p{N}" : null;
  if (kind === null) return "";
  return side === "before" ? `(?<!${kind})` : `(?!${kind})`;
}

/**
 * A global regex matching every form (`secretForms`) of a secret. Longer forms are tried first.
 *
 * - {@link MIN_SUBSTRING_SECRET_LENGTH} characters or more: a plain substring.
 * - 3 to 5 characters holding both a letter and a digit (`Pw12x`): a plain substring too (F5), so
 *   `abcPw12xdef` is masked. Such a mix almost never occurs by chance in prose or a number.
 * - 3 to 5 characters otherwise (all letters, all digits, letters and punctuation): wherever the
 *   occurrence does not continue a run of its own kind — a letter edge not touching another letter,
 *   a digit edge not touching another digit; a punctuation edge has no condition. So `1234` is masked
 *   in `pin1234x` and not in `12345`, and `bag` is not masked in `cabbage`.
 * - 1 or 2 characters: a whole token only, not touching a letter or digit on either side (#454).
 *
 * Each case masks at least what the whole-token rule did, so the rule is never narrower than #454's.
 */
export function secretPattern(secret: string): RegExp {
  const forms = [...secretForms(secret)].sort((a, b) => b.length - a.length);
  const esc = (f: string): string => f.replace(REGEX_SYNTAX, "\\$&");
  const plain = (): RegExp => new RegExp(forms.map(esc).join("|"), "gu");
  if (!isWeakSecret(secret)) return plain();
  const chars = [...secret];
  if (chars.length < MIN_EMBEDDED_SECRET_LENGTH) {
    return new RegExp(`(?<![\\p{L}\\p{N}])(?:${forms.map(esc).join("|")})(?![\\p{L}\\p{N}])`, "gu");
  }
  if (chars.some((c) => LETTER.test(c)) && chars.some((c) => DIGIT.test(c))) return plain();
  return new RegExp(
    forms
      .map((f) => {
        const cs = [...f];
        return `${sameKindGuard(cs[0], "before")}${esc(f)}${sameKindGuard(cs[cs.length - 1], "after")}`;
      })
      .join("|"),
    "gu",
  );
}

/** Whether `text` contains `secret` in any of its forms, by the {@link secretPattern} rule. */
export function containsSecret(text: string, secret: string): boolean {
  if (!isWeakSecret(secret)) return secretForms(secret).some((f) => text.includes(f));
  return secretPattern(secret).test(text);
}

/**
 * The forms a registered secret is matched in: its raw value and — when they
 * differ — its `encodeURIComponent` form, its strict RFC 3986 form (`!'()*`
 * encoded too: how a Journey's navigate `${param}` substitutes it, #399), its
 * form-urlencoded form (`+` for space) and the lowercase-hex spelling of each —
 * how a secret appears once it has ridden into a URL. Shared by `redactText` and
 * `assertNoSecretInPayload` so the scrub and its proof always agree on what
 * counts as the secret.
 */
export function secretForms(secret: string): readonly string[] {
  let encoded: string;
  try {
    encoded = encodeURIComponent(secret);
  } catch {
    return [secret]; // a lone surrogate has no URL-encoded form; its raw form is still matched
  }
  const strict = encoded.replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
  // application/x-www-form-urlencoded (`+` for space), as a form or URLSearchParams re-serializes it.
  const form = new URLSearchParams([["", secret]]).toString().slice(1);
  const lower = (v: string): string => v.replace(/%[0-9A-F]{2}/g, (m) => m.toLowerCase());
  return [...new Set([secret, encoded, strict, form, lower(encoded), lower(strict), lower(form)])];
}
