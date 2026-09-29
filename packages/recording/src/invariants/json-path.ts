import type { ObservedValue } from "./expression.js";

// === JSON path (tiny subset) ===

/** `[*]` (#147): every element of an array. */
export const JSON_PATH_EACH: { readonly each: true } = Object.freeze({ each: true as const });
export type JsonPathSegment = string | number | typeof JSON_PATH_EACH;

/** `$`, `.key`, `[n]`, `["key"]`, `[*]` — nothing else (no filters, no recursive descent, no script). */
export function parseJsonPath(src: string): JsonPathSegment[] {
  if (!src.startsWith("$")) throw new Error(`a JSON path starts with "$", got ${JSON.stringify(src)}`);
  const out: JsonPathSegment[] = [];
  let i = 1;
  while (i < src.length) {
    const rest = src.slice(i);
    const key = /^\.([A-Za-z_$][A-Za-z0-9_$-]*)/.exec(rest);
    if (key !== null) {
      out.push(key[1] as string);
      i += key[0].length;
      continue;
    }
    const idx = /^\[(\d+)\]/.exec(rest);
    if (idx !== null) {
      out.push(Number(idx[1]));
      i += idx[0].length;
      continue;
    }
    if (rest.startsWith("[*]")) {
      out.push(JSON_PATH_EACH);
      i += 3;
      continue;
    }
    const quoted = /^\["([^"\\]*)"\]/.exec(rest);
    if (quoted !== null) {
      out.push(quoted[1] as string);
      i += quoted[0].length;
      continue;
    }
    throw new Error(`unsupported JSON path syntax at ${i} in ${JSON.stringify(src)}`);
  }
  return out;
}

/** Does a JSON path fan out (`[*]`)? Its value is then a list (`readJsonPathList`). */
export function jsonPathHasEach(path: readonly JsonPathSegment[]): boolean {
  return path.some((seg) => seg === JSON_PATH_EACH);
}

/**
 * Reads a fanned-out JSON path (`$.items[*].id`) into the list of scalars it reaches — objects and
 * missing members are skipped. `undefined` when the path's fixed prefix (before the first `[*]`)
 * is missing.
 */
export function readJsonPathList(value: unknown, path: readonly JsonPathSegment[]): ObservedValue[] | undefined {
  let cur: unknown[] = [value];
  let fanned = false;
  for (const seg of path) {
    const next: unknown[] = [];
    for (const v of cur) {
      if (v === null || typeof v !== "object") continue;
      if (seg === JSON_PATH_EACH) {
        if (Array.isArray(v)) next.push(...(v as unknown[]));
      } else if (typeof seg === "number") {
        if (Array.isArray(v) && seg < v.length) next.push(v[seg]);
      } else if (typeof seg === "string" && !Array.isArray(v) && Object.prototype.hasOwnProperty.call(v, seg)) {
        next.push((v as Record<string, unknown>)[seg]);
      }
    }
    if (seg === JSON_PATH_EACH) {
      if (!fanned && !cur.some((v) => Array.isArray(v))) return undefined;
      fanned = true;
    } else if (!fanned && next.length === 0) return undefined;
    cur = next;
  }
  return cur.filter((v): v is ObservedValue => v === null || typeof v === "number" || typeof v === "string" || typeof v === "boolean");
}

/** Reads a JSON path; `undefined` when a segment is missing. Only scalars come back (objects → undefined). */
export function readJsonPath(value: unknown, path: readonly JsonPathSegment[]): ObservedValue | undefined {
  // A fanned-out path read as one value is its size ("the list grew").
  if (jsonPathHasEach(path)) return readJsonPathList(value, path)?.length;
  let cur: unknown = value;
  for (const seg of path) {
    if (cur === null || typeof cur !== "object" || typeof seg === "object") return undefined;
    if (typeof seg === "number") {
      if (!Array.isArray(cur)) return undefined;
      cur = cur[seg];
    } else {
      if (Array.isArray(cur) || !Object.prototype.hasOwnProperty.call(cur, seg)) return undefined;
      cur = (cur as Record<string, unknown>)[seg];
    }
  }
  if (cur === null || typeof cur === "number" || typeof cur === "string" || typeof cur === "boolean") return cur;
  // A collection's size is the one non-scalar read that is useful ("the list grew").
  if (Array.isArray(cur)) return cur.length;
  return undefined;
}
