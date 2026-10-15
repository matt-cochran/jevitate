/**
 * Shared structural guards (#520): the tiny predicates every package used to copy locally.
 */

/** True for a non-null, non-array object — the shape a decoded JSON object has. */
export function isRecord(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

/** Alias of {@link isRecord}, for callers that read better as "plain object". */
export function isPlainObject(v: unknown): v is Record<string, unknown> {
  return isRecord(v);
}

/** True when `err` is a Node error carrying `code` (e.g. "ENOENT"). */
export function isNodeError(err: unknown, code: string): boolean {
  return typeof err === "object" && err !== null && "code" in err && (err as { code?: unknown }).code === code;
}
