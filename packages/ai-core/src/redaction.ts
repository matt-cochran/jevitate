// redaction.ts — the shared, value-based redaction primitives that sit next to
// the `assertNoSecretInPayload` choke point (credential-guard.ts). These were
// promoted here from `@jevitate/explore` so every autonomous producer — the
// exploration engine AND `@jevitate/ux` — redacts through ONE implementation
// (spec: "no divergent redaction path"). `@jevitate/explore` re-exports these.
import { assertNoSecretInPayload } from "./credential-guard.js";

/** What a scrubbed secret is replaced with — a marker, never the value/length. */
export const REDACTION_MASK = "«redacted»";

/** Replaces every occurrence of every non-blank secret with the mask. */
export function redactText(text: string, secrets: readonly string[]): string {
  let out = text;
  for (const s of secrets) {
    if (s && s.trim().length > 0) out = out.split(s).join(REDACTION_MASK);
  }
  return out;
}

/**
 * Scrubs a free-text string bound for a model, and PROVES the scrub via the
 * shared `assertNoSecretInPayload` choke point — fail-closed: it never returns
 * a string that still contains a registered secret; a survivor throws.
 */
export function redactContext(text: string, secrets: readonly string[]): string {
  const out = redactText(text, secrets);
  assertNoSecretInPayload(out, secrets);
  return out;
}
