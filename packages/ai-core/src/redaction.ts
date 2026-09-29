// redaction.ts — the shared, value-based redaction primitives that sit next to
// the `assertNoSecretInPayload` choke point (credential-guard.ts). These were
// promoted here from `@jevitate/explore` so every autonomous producer — the
// exploration engine AND `@jevitate/ux` — redacts through ONE implementation
// (spec: "no divergent redaction path"). `@jevitate/explore` re-exports these.
import { assertNoSecretInPayload, secretForms } from "./credential-guard.js";

/** What a scrubbed secret is replaced with — a marker, never the value/length. */
export const REDACTION_MASK = "«redacted»";

/**
 * Replaces every occurrence of every non-blank secret with the mask — both the
 * raw value and its `encodeURIComponent` form (a secret that rode into a URL is
 * percent-encoded there, and the raw-value match alone would miss it).
 */
export function redactText(text: string, secrets: readonly string[]): string {
  let out = text;
  for (const s of secrets) {
    if (!s || s.trim().length === 0) continue;
    for (const form of secretForms(s)) out = out.split(form).join(REDACTION_MASK);
  }
  return out;
}

/**
 * Query/fragment parameter NAMES whose VALUE is treated as a credential,
 * matched case-insensitively. Deliberately a short, explicit list.
 */
export const SENSITIVE_URL_PARAMS: ReadonlySet<string> = new Set([
  "token",
  "access_token",
  "refresh_token",
  "id_token",
  "code",
  "key",
  "api_key",
  "apikey",
  "secret",
  "client_secret",
  "signature",
  "sig",
  "password",
  "pwd",
  "otp",
  "session",
  "auth",
]);

/**
 * A `name=value` pair introduced by `?`, `&`, `;` or `#` — i.e. a query or
 * fragment parameter (`#access_token=…` is the OAuth implicit-flow shape). The
 * value stops at the next separator, whitespace, or quote/angle bracket, so the
 * rule also works on a URL embedded in a larger string.
 */
const URL_PARAM = /([?&;#])([^=&;#?\s"'<>]+)=([^&;#\s"'<>]*)/g;

function decodedName(raw: string): string {
  try {
    return decodeURIComponent(raw).toLowerCase();
  } catch {
    return raw.toLowerCase();
  }
}

/**
 * Blanks the VALUE of every query/fragment parameter whose name is in
 * `SENSITIVE_URL_PARAMS`, keeping the name (so the model still sees the URL's
 * shape) and leaving every other byte untouched. The ONE URL rule every
 * model-bound and Recording-bound URL goes through.
 */
export function redactUrl(url: string): string {
  return url.replace(URL_PARAM, (whole: string, sep: string, name: string, value: string) =>
    value !== "" && SENSITIVE_URL_PARAMS.has(decodedName(name)) ? `${sep}${name}=${REDACTION_MASK}` : whole,
  );
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
