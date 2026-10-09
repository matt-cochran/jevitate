// redaction.ts — the shared, value-based redaction primitives that sit next to
// the `assertNoSecretInPayload` choke point (credential-guard.ts). These were
// promoted here from `@jevitate/explore` so every autonomous producer — the
// exploration engine AND `@jevitate/ux` — redacts through ONE implementation
// (spec: "no divergent redaction path"). `@jevitate/explore` re-exports these.
import { assertNoSecretInPayload, isWeakSecret, secretForms, secretPattern } from "./credential-guard.js";

/** What a scrubbed secret is replaced with — a marker, never the value/length. */
export const REDACTION_MASK = "«redacted»";

/**
 * Replaces every occurrence of every non-blank secret with the mask — both the
 * raw value and its `encodeURIComponent` form (a secret that rode into a URL is
 * percent-encoded there, and the raw-value match alone would miss it). A secret shorter than
 * `MIN_SUBSTRING_SECRET_LENGTH` is replaced only where it stands as a whole token (#454), so a
 * username `me` never turns "Timeout" into "Ti«redacted»out".
 */
export function redactText(text: string, secrets: readonly string[]): string {
  let out = text;
  for (const s of secrets) {
    if (!s || s.trim().length === 0) continue;
    if (isWeakSecret(s)) out = out.replace(secretPattern(s), REDACTION_MASK);
    else for (const form of secretForms(s)) out = out.split(form).join(REDACTION_MASK);
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

/**
 * #298 — elements a target marks as secret (a one-time reveal panel, a freshly minted key): a target
 * opts in with the `data-jevitate-mask` attribute; the rest are common one-time-secret markers. What
 * such an element shows is masked by every capture (the screenshot/video pixel mask, the action
 * deltas of #303) without being registered with `--secret`.
 */
export const REVEALED_SECRET_SELECTORS: readonly string[] = [
  "[data-jevitate-mask]",
  "[data-secret]",
  '[autocomplete="one-time-code"]',
  '[data-testid*="secret" i]',
  '[data-testid*="api-key" i]',
  '[data-testid*="apikey" i]',
  '[data-testid*="token" i]',
  '[aria-label*="secret" i]',
  '[aria-label*="api key" i]',
  '[aria-label*="token" i]',
];

/** Credential shapes masked (and learned) wherever they appear (#298). Source strings; flags `g`. */
export const REVEALED_SECRET_SHAPES: readonly string[] = [
  // JWT / JWS (header.payload.signature).
  String.raw`\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}`,
  // Prefixed provider keys: Stripe, OpenAI/OpenRouter/Anthropic, GitHub, GitLab, Slack, AWS, Google.
  String.raw`\b(?:sk|pk|rk)_(?:live|test)_[A-Za-z0-9]{10,}`,
  String.raw`\bsk-[A-Za-z0-9_-]{20,}`,
  String.raw`\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,}|glpat-[A-Za-z0-9_-]{20,})`,
  String.raw`\bxox[abprs]-[A-Za-z0-9-]{10,}`,
  String.raw`\b(?:AKIA|ASIA)[0-9A-Z]{16}\b`,
  String.raw`\bAIza[0-9A-Za-z_-]{35}`,
  // <id>.<secret> hex pairs (a key id + secret), and long hex secrets.
  String.raw`\b[0-9a-fA-F]{8,}\.[0-9a-fA-F]{16,}\b`,
  String.raw`\b[0-9a-fA-F]{32,}\b`,
  // A long mixed-case alphanumeric token (base64url-ish): upper, lower and digit, 32+ chars.
  String.raw`(?<![A-Za-z0-9_-])(?=[A-Za-z0-9_-]*[A-Z])(?=[A-Za-z0-9_-]*[a-z])(?=[A-Za-z0-9_-]*[0-9])[A-Za-z0-9_-]{32,}(?![A-Za-z0-9_-])`,
];

/** The credential-shaped substrings of `text` (#298) — what the browser mask learns, in node form. */
export function revealedSecretsIn(text: string): string[] {
  const out = new Set<string>();
  for (const src of REVEALED_SECRET_SHAPES) for (const m of text.matchAll(new RegExp(src, "g"))) out.add(m[0]);
  // A shape found inside a longer one (the secret half of an id.secret pair) is the same secret.
  return [...out].filter((v) => ![...out].some((o) => o !== v && o.includes(v)));
}

/** `text` with every credential-shaped substring (#298, {@link REVEALED_SECRET_SHAPES}) masked. */
export function redactCredentialShapes(text: string): string {
  const found = revealedSecretsIn(text);
  return found.length === 0 ? text : redactText(text, found);
}
