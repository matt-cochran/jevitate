/**
 * A named capability's reachable perimeter: an origin allowlist AND a set of
 * in-scope route globs. A state whose url is in scope is expanded; a state
 * outside it is a *boundary edge* — recorded as evidence of the feature's
 * reachable perimeter, never expanded further (guardrail #4). Fail-closed
 * throughout: an unparseable url, an unlisted origin, or no matching route
 * glob are all "out of scope."
 */
export interface CapabilityScope {
  name: string;
  originAllowlist: readonly string[];
  routeGlobs: readonly string[];
}

function safeOrigin(raw: string): string | null {
  try {
    return new URL(raw).origin;
  } catch {
    return null;
  }
}

/** Escapes every regex metacharacter except `*` (the glob's own wildcard). */
function escapeLiteral(seg: string): string {
  return seg.replace(/[.+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * `**` matches any number of path segments; `*` matches any run of characters within one segment.
 * Every other character is literal (a `.` or `?` in a route is never a regex operator).
 */
export function matchGlob(pattern: string, pathname: string): boolean {
  const segs = pattern.split("/").map((seg) => (seg === "**" ? ".*" : escapeLiteral(seg).replace(/\*/g, "[^/]*")));
  const body = segs.join("/");
  const suffix = pattern.endsWith("/**") ? "" : "$";
  return new RegExp(`^${body}${suffix}`).test(pathname);
}

export function isInScope(url: string, scope: CapabilityScope): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  const origin = safeOrigin(url);
  if (!scope.originAllowlist.some((o) => safeOrigin(o) === origin)) return false;
  return scope.routeGlobs.some((g) => matchGlob(g, parsed.pathname));
}
