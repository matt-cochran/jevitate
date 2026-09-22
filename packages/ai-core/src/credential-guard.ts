import { CredentialKey } from "./credentials.js";

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
  keys: readonly CredentialKey[] = ["OPENROUTER_API_KEY", "TYPESAFE_API_KEY"],
): void {
  const haystack = typeof payload === "string" ? payload : JSON.stringify(payload);
  for (const k of keys) {
    const v = store.read(k);
    if (v && v.length > 0 && haystack.includes(v)) throw new CredentialLeakError(k);
  }
}

export class SecretLeakError extends Error {
  readonly code = "E_SECRET_LEAK" as const;
  constructor(readonly index: number) {
    // NOTE: never include the value (or its length) in the message.
    super(
      `a registered secret value appeared in an outbound model payload — refused (floor #6, never-to-model)`,
    );
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
export function assertNoSecretInPayload(payload: unknown, secrets: readonly string[]): void {
  if (secrets.length === 0) return;
  const haystack = typeof payload === "string" ? payload : JSON.stringify(payload);
  for (let i = 0; i < secrets.length; i++) {
    const s = secrets[i];
    if (!s || s.length === 0) continue;
    for (const form of secretForms(s)) {
      if (haystack.includes(form)) throw new SecretLeakError(i);
    }
  }
}

/**
 * The forms a registered secret is matched in: its raw value and — when it
 * differs — its `encodeURIComponent` form (how a secret appears once it has
 * ridden into a URL). Shared by `redactText` and `assertNoSecretInPayload` so
 * the scrub and its proof always agree on what counts as the secret.
 */
export function secretForms(secret: string): readonly string[] {
  const encoded = encodeURIComponent(secret);
  return encoded === secret ? [secret] : [secret, encoded];
}
