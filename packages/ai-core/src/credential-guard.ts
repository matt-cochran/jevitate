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
