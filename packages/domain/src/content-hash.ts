import { createHash } from "node:crypto";

/**
 * Portable JSON-object key order: lexicographic by unsigned UTF-16 code unit.
 *
 * This is the ordering used by JavaScript's `<` comparison. Unlike `localeCompare`, it does not
 * depend on the host's locale or ICU version. Consumers in other languages must compare each
 * key's UTF-16 encoding as unsigned 16-bit integers, then put the shorter equal prefix first.
 */
export function compareUtf16CodeUnits(a: string, b: string): number {
  const length = Math.min(a.length, b.length);
  for (let index = 0; index < length; index += 1) {
    const difference = a.charCodeAt(index) - b.charCodeAt(index);
    if (difference !== 0) return difference < 0 ? -1 : 1;
  }
  return a.length === b.length ? 0 : a.length < b.length ? -1 : 1;
}

/** Canonical JSON used by contentHash. Arrays retain order; object keys use compareUtf16CodeUnits. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) => compareUtf16CodeUnits(a, b));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(",")}}`;
}

/** Pre-0.24 canonicalization, retained only to recognize already-recorded approvals. */
export function legacyCanonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(legacyCanonicalJson).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${legacyCanonicalJson(v)}`).join(",")}}`;
}

/** SHA-256 of canonical JSON: equal values hash equal whatever their object-key insertion order. */
export function contentHash(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

/** Legacy v1 approval hash. Never write a new approval with this value. */
export function legacyContentHash(value: unknown): string {
  return createHash("sha256").update(legacyCanonicalJson(value)).digest("hex");
}

/** SHA-256 of UTF-8 text as lowercase hex. */
export function sha256(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}
