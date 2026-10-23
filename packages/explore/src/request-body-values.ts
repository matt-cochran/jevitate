/**
 * #649: what a write sent, whoever typed it. #647 holds an ending on a value the run TYPED until a
 * page loaded from the server shows it again; a value the run never typed (a prefilled import, a
 * generated row) was still sent, and a 2xx for it proves acceptance, not storage. These are the
 * string values of a write's request body — JSON leaves or form-encoded values — so they await
 * read-back the same way.
 *
 * Kept in memory only and compared against page text; never persisted, never told to the model
 * unless a page already shows them. A value under a key that names a credential is never kept.
 */

/** Values shorter than this identify nothing on a page (ids, flags, single letters). */
const MIN_VALUE_CHARS = 3;
/** Most values one body contributes. */
const MAX_VALUES = 50;
/** The longest body read (a larger upload is not a record the page lists back). */
const MAX_BODY_CHARS = 64_000;
/** Words in a key that name a credential: its value is never kept. */
const SENSITIVE_WORDS = new Set(["pass", "password", "passwd", "pwd", "secret", "token", "auth", "authorization", "apikey", "key", "otp", "pin", "cvv", "cvc", "card", "ssn", "session", "cookie", "signature", "credential", "credentials"]);

/** Whether `key`'s words (camelCase, snake_case, kebab-case) include one that names a credential. */
function sensitive(key: string): boolean {
  return key
    .split(/[^A-Za-z0-9]+|(?<=[a-z0-9])(?=[A-Z])/)
    .some((w) => SENSITIVE_WORDS.has(w.toLowerCase()));
}

function keep(out: string[], key: string | null, value: string): void {
  if (out.length >= MAX_VALUES) return;
  if (key !== null && sensitive(key)) return;
  const v = value.replace(/\s+/g, " ").trim();
  if (v.length >= MIN_VALUE_CHARS) out.push(v);
}

function walk(out: string[], key: string | null, node: unknown): void {
  if (out.length >= MAX_VALUES) return;
  if (typeof node === "string") keep(out, key, node);
  else if (Array.isArray(node)) for (const item of node) walk(out, key, item);
  else if (node !== null && typeof node === "object") {
    for (const [k, v] of Object.entries(node)) {
      if (sensitive(k)) continue;
      walk(out, k, v);
    }
  }
}

/** The string values a write's request body sent (empty when it sent none this can read). */
export function bodyValues(body: string | null, contentType: string | undefined): string[] {
  if (body === null || body === "" || body.length > MAX_BODY_CHARS) return [];
  const type = (contentType ?? "").toLowerCase();
  const out: string[] = [];
  if (type.includes("application/x-www-form-urlencoded")) {
    for (const [k, v] of new URLSearchParams(body)) keep(out, k, v);
    return out;
  }
  if (type === "" || type.includes("json")) {
    try {
      walk(out, null, JSON.parse(body));
    } catch {
      return [];
    }
  }
  return out;
}
