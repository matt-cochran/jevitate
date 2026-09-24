import type { Assertion, TargetDescriptor } from "@jevitate/recording";
import { matchGlob } from "./feature/capability-scope.js";
import type { CapturedRequest } from "./page-monitor.js";
import { classifyRequest } from "./timing.js";

/**
 * The goal mission's INDEPENDENT success oracle (#65): one or more checks, ALL of which must hold.
 * A save that shows "Saved" but persists nothing passes every check that only looks at the page;
 * these kinds catch it:
 *
 *  - `page`        — a recording `Assertion` on the final page (`urlIncludes`, `visible`,
 *                    `textIncludes`, `count`, `valueEquals` — a form control's VALUE — and the
 *                    visual-state kinds (#148): `style`, `inViewport`, `box`, `overlap`, `attr`,
 *                    `flashed`);
 *  - `reloadThen`  — reload the page, THEN check the assertion: proves the state persisted, not
 *                    just that the UI shows it;
 *  - `requestMade` — the run issued a request `METHOD <path-glob>` (catches a silent no-op save);
 *  - `responseStatus` — the run's matching requests all got the expected status (`2xx`, `4xx`,
 *                    or an exact code), and there was at least one.
 *
 * Network checks are evaluated over the requests the run captured (never the oracle's own reload).
 * Paths use the route-glob syntax (`*` within a segment, `**` across segments), matched against
 * the request's path (query ignored). A method of `*` matches any method.
 */

/** An expected HTTP status: a class (`2xx`) or an exact code (`201`). */
export type StatusSpec = { readonly class: 1 | 2 | 3 | 4 | 5 } | { readonly code: number };

export type SuccessCheck =
  | { readonly kind: "page"; readonly assertion: Assertion }
  | { readonly kind: "reloadThen"; readonly assertion: Assertion }
  | { readonly kind: "requestMade"; readonly method: string; readonly pathGlob: string }
  | { readonly kind: "responseStatus"; readonly method: string; readonly pathGlob: string; readonly status: StatusSpec };

/** The verdict of one check, with what it saw. */
export interface SuccessCheckResult {
  /** The check, in the `--success` spec syntax. */
  readonly check: string;
  readonly passed: boolean;
  /** What the oracle saw (e.g. "no PUT request matched /api/profile (3 requests captured)"). */
  readonly detail: string;
}

function descriptorSpec(d: TargetDescriptor): string {
  if (d.testId !== undefined) return `testId=${d.testId}`;
  const keys = ["role", "name", "label", "text", "css"] as const;
  return keys
    .filter((k) => d[k] !== undefined)
    .map((k) => `${k}=${d[k] ?? ""}`)
    .join(";");
}

/** An assertion in the `--success` spec syntax. */
export function describeAssertionSpec(a: Assertion): string {
  switch (a.kind) {
    case "urlIncludes":
      return `urlIncludes:${a.text}`;
    case "visible":
      return `visible:${descriptorSpec(a.target)}`;
    case "textIncludes":
      return `textIncludes:${descriptorSpec(a.target)}|${a.text}`;
    case "count": {
      const bounds = [a.min === undefined ? null : `min=${a.min}`, a.max === undefined ? null : `max=${a.max}`].filter(
        (b): b is string => b !== null,
      );
      return `count:${descriptorSpec(a.target)}${bounds.length === 0 ? "" : `|${bounds.join(",")}`}`;
    }
    case "valueEquals":
      return `valueEquals:${descriptorSpec(a.target)}|${a.value}`;
    case "style":
      return `style:${descriptorSpec(a.target)}|${a.channel === undefined ? a.property : `${a.channel}(${a.property})`}${a.op}${a.value}`;
    case "inViewport":
      return `inViewport:${descriptorSpec(a.target)}${a.min === undefined ? "" : `|min=${a.min}`}`;
    case "box": {
      const keys = ["minWidth", "maxWidth", "minHeight", "maxHeight"] as const;
      const bounds = keys.filter((k) => a[k] !== undefined).map((k) => `${k}=${a[k]}`);
      return `box:${descriptorSpec(a.target)}${bounds.length === 0 ? "" : `|${bounds.join(",")}`}`;
    }
    case "overlap":
      return `${a.overlapping ? "overlaps" : "noOverlap"}:${descriptorSpec(a.target)}|${descriptorSpec(a.other)}`;
    case "attr":
      return `attr:${descriptorSpec(a.target)}|${a.absent === true ? `!${a.name}` : a.value === undefined ? a.name : `${a.name}=${a.value}`}`;
    case "flashed": {
      const what = a.className !== undefined ? `class=${a.className}` : a.attr !== undefined ? `attr=${a.attr}` : "animation";
      return `flashed:${descriptorSpec(a.target)}|${what}${a.withinMs === undefined ? "" : `|withinMs=${a.withinMs}`}`;
    }
  }
}

export function describeStatus(s: StatusSpec): string {
  return "class" in s ? `${s.class}xx` : String(s.code);
}

/** A check in the `--success` spec syntax. */
export function describeCheck(c: SuccessCheck): string {
  switch (c.kind) {
    case "page":
      return describeAssertionSpec(c.assertion);
    case "reloadThen":
      return `reloadThen:${describeAssertionSpec(c.assertion)}`;
    case "requestMade":
      return `requestMade:${c.method} ${c.pathGlob}`;
    case "responseStatus":
      return `responseStatus:${c.method} ${c.pathGlob}=${describeStatus(c.status)}`;
  }
}

function statusMatches(status: number, spec: StatusSpec): boolean {
  return "class" in spec ? Math.floor(status / 100) === spec.class : status === spec.code;
}

function matching(requests: readonly CapturedRequest[], method: string, pathGlob: string): CapturedRequest[] {
  const m = method.toUpperCase();
  return requests.filter((r) => (m === "*" || r.method === m) && matchGlob(pathGlob, r.path));
}

/**
 * Requests worth counting/searching for a network check (#130c): the app's own traffic (API,
 * document, or an otherwise-unclassified XHR/fetch) — never a static asset (script/style/font/image)
 * or a dev server's module request (Vite's `/src/…`, `/@vite/…`, `/node_modules/…`). A run against a
 * live dev server captures thousands of these; they would drown out both the "N requests captured"
 * count and the near-miss search below.
 */
function relevant(requests: readonly CapturedRequest[]): CapturedRequest[] {
  return requests.filter(
    (r) => classifyRequest({ url: r.url, resourceType: r.resourceType ?? "", contentType: r.contentType ?? null }) !== "asset",
  );
}

/** One path split into its non-empty segments. */
function segments(path: string): string[] {
  return path.split("/").filter((s) => s.length > 0);
}

/**
 * Is `path` close enough to the literal shape of `pathGlob` to be the same endpoint, typo'd? Same
 * segment count, and at most one segment differs (a wildcard segment always matches).
 */
function similarPath(path: string, pathGlob: string): boolean {
  if (path === pathGlob) return true;
  const a = segments(path);
  const b = segments(pathGlob);
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    const bi = b[i] ?? "";
    if (bi.includes("*")) continue;
    if (a[i] !== bi) diff += 1;
  }
  return diff <= 1;
}

/**
 * A near-miss hint for a failed `requestMade`/`responseStatus` check (#130b): the most likely
 * authoring mistake is a method or path typo, so this looks for requests that match the path with a
 * DIFFERENT method, or match the method with a similar (one-segment-off) path — and reports the most
 * frequent one seen, e.g. `saw POST /api/v1/tool/profile → 200 (1×)`. Null when nothing is close.
 */
function nearMissHint(requests: readonly CapturedRequest[], method: string, pathGlob: string): string | null {
  const m = method.toUpperCase();
  const pool = relevant(requests);
  const samePathOtherMethod = m === "*" ? [] : pool.filter((r) => matchGlob(pathGlob, r.path) && r.method !== m);
  const sameMethodSimilarPath = m === "*" ? [] : pool.filter((r) => r.method === m && similarPath(r.path, pathGlob) && !matchGlob(pathGlob, r.path));
  const candidates = samePathOtherMethod.length > 0 ? samePathOtherMethod : sameMethodSimilarPath;
  if (candidates.length === 0) return null;
  const groups = new Map<string, { method: string; path: string; status: number | null; count: number }>();
  for (const r of candidates) {
    const key = `${r.method} ${r.path} ${r.status ?? "none"}`;
    const g = groups.get(key);
    if (g === undefined) groups.set(key, { method: r.method, path: r.path, status: r.status, count: 1 });
    else g.count += 1;
  }
  const top = [...groups.values()].sort((a, b) => b.count - a.count)[0];
  if (top === undefined) return null;
  const statusText = top.status === null ? "no response" : String(top.status);
  return `saw ${top.method} ${top.path} → ${statusText} (${top.count}×)`;
}

/**
 * Evaluates a network check over the captured requests (pure). `truncated` says the capture
 * dropped its oldest requests: a check that fails then says so, since the request may have been
 * among them.
 */
export function evaluateNetworkCheck(
  check: Extract<SuccessCheck, { kind: "requestMade" | "responseStatus" }>,
  requests: readonly CapturedRequest[],
  truncated = false,
): SuccessCheckResult {
  const spec = describeCheck(check);
  const hits = matching(requests, check.method, check.pathGlob);
  const note = truncated ? " (the capture dropped its oldest requests)" : "";
  if (hits.length === 0) {
    const captured = relevant(requests).length;
    const hint = nearMissHint(requests, check.method, check.pathGlob);
    return {
      check: spec,
      passed: false,
      detail: `no ${check.method.toUpperCase()} request matched ${check.pathGlob} (${captured} requests captured)${note}${
        hint === null ? "" : `; ${hint}`
      }`,
    };
  }
  if (check.kind === "requestMade") {
    return { check: spec, passed: true, detail: `${hits.length} matching request(s)` };
  }
  const seen = hits.map((r) => (r.status === null ? "no response" : String(r.status)));
  const bad = hits.filter((r) => r.status === null || !statusMatches(r.status, check.status));
  return bad.length === 0
    ? { check: spec, passed: true, detail: `${hits.length} matching request(s), status ${[...new Set(seen)].join(", ")}` }
    : {
        check: spec,
        passed: false,
        detail: `expected ${describeStatus(check.status)}, got ${seen.join(", ")} for ${hits.length} matching request(s)${note}`,
      };
}
