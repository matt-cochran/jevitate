/**
 * #649: what a write sent, whoever typed it. #647 holds an ending on a value the run TYPED until a
 * page loaded from the server shows it again; a value the run never typed (a prefilled import, a
 * generated row) was still sent, and a 2xx for it proves acceptance, not storage. These are the
 * string values of a write's request body — JSON leaves or form-encoded values — so they await
 * read-back the same way.
 *
 * Kept in memory only and compared against page text; never persisted, never told to the model
 * unless a page already shows them. A value under a key that names a credential is never kept.
 *
 * #743 reuses the same credential-key filter to match a declared body SHAPE: the capture parses a
 * write's body in memory, keeps only each field's name and JSON type (never a value), and this
 * module compares those names/types against a check's declared fields.
 */
import type { BodyFieldShape } from "@jevitate/recording";
import type { DeclaredField } from "./page-monitor.js";

export type { BodyFieldShape } from "@jevitate/recording";

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

/** Whether a declared body-field predicate holds for a captured field's JSON type. */
function predicateSatisfied(predicate: BodyFieldShape["predicate"], type: DeclaredField["type"] | undefined): boolean {
  if (predicate === "exists") return type !== undefined;
  if (predicate === "absent") return type === undefined;
  return type === predicate;
}

/**
 * #743: each declared body field a request did NOT satisfy, described for a failure detail
 * (`provider (missing)`, `items (expected array, got string)`). The capture carries only a field's
 * name and JSON type — never a value — and a credential-named shape field is ignored by the same
 * key filter `bodyValues` applies (a secret is never named or compared here).
 */
export function bodyShapeMismatches(shape: readonly BodyFieldShape[], fields: readonly DeclaredField[]): string[] {
  const types = new Map<string, DeclaredField["type"]>();
  for (const f of fields) types.set(f.name, f.type);
  const out: string[] = [];
  for (const declared of shape) {
    if (sensitive(declared.name)) continue;
    const type = types.get(declared.name);
    if (predicateSatisfied(declared.predicate, type)) continue;
    if (declared.predicate === "absent") out.push(`${declared.name} (expected absent, got ${type})`);
    else if (type === undefined) out.push(`${declared.name} (missing)`);
    else out.push(`${declared.name} (expected ${declared.predicate}, got ${type})`);
  }
  return out;
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
