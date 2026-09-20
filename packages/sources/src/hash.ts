import { createHash } from "node:crypto";

/**
 * Deterministic serialization for content-hashing (§14.2): object keys
 * sorted ascending by JS string comparison, arrays preserved in order (step
 * order is semantic), `undefined`/absent optionals omitted (never emitted as
 * `null`), no insignificant whitespace, numbers via `Number.prototype.toString`.
 * This is NOT bare `JSON.stringify` — key order there is insertion order,
 * which would make the hash depend on how a file happened to be authored
 * rather than its actual content.
 */
export function canonicalJson(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(",")}}`;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("non-finite number is not canonicalizable");
    return value.toString();
  }
  // string | boolean — JSON.stringify is deterministic for these scalars
  return JSON.stringify(value);
}

/**
 * Content hash over the ENTIRE closed-schema Journey file (metadata +
 * recording + declaredOrigins) — every behavior-affecting byte, so "what you
 * reviewed is what runs" (§7). Task 4 tightens this to parse through
 * `SharedJourneyFileSchema` first so hashing is defined only over
 * schema-known content (unknown keys stripped before hashing).
 */
export function canonicalJourneyHash(file: unknown): string {
  const hex = createHash("sha256").update(canonicalJson(file), "utf8").digest("hex");
  return `sha256:${hex}`;
}
