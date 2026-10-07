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
  for (let i = 0; i < secrets.length; i++) {
    const s = secrets[i];
    if (!s || s.length === 0) continue;
    for (const form of secretForms(s)) {
      if (haystack.includes(form)) throw new SecretLeakError(i, where);
    }
  }
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
