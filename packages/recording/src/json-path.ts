import { JSON_PATH_EACH, parseJsonPath } from "./invariants/json-path.js";

/**
 * #543: the JSON-path reader an `http` end-state check uses — the SAME tiny path grammar as the
 * invariants (`$`, `.key`, `[n]`, `["key"]`, `[*]`; no filters, no recursive descent, no script).
 * `[*]` fans out over an array, so one path can select many values; a check holds when ANY of them
 * satisfies its operator. (A fixture output keeps its own scalar-only reader, which refuses `[*]`.)
 */

/** Why `path` is not a JSON path this grammar reads (a message), or `undefined`. */
export function jsonPathProblem(path: string): string | undefined {
  try {
    parseJsonPath(path);
    return undefined;
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
  }
}

/**
 * Every value `path` selects in `doc`, in document order: `[*]` contributes each element of an
 * array; a missing member (or a segment that does not fit the value: an index into an object) is
 * skipped. A path that selects nothing returns `[]`. Throws when `path` does not parse.
 */
export function selectJsonValues(doc: unknown, path: string): unknown[] {
  let cur: unknown[] = [doc];
  for (const seg of parseJsonPath(path)) {
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
    cur = next;
  }
  return cur.filter((v) => v !== undefined);
}
