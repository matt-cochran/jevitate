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

/** #325: a pattern expands to at most this many alternatives (a runaway `{a,b}{c,d}…` is refused). */
export const MAX_GLOB_ALTERNATIVES = 64;

/**
 * #325: `{a,b}` alternation, expanded into plain patterns (`/api/{Reschedule,Cancel}Appointment` →
 * `/api/RescheduleAppointment`, `/api/CancelAppointment`); nested braces expand too. A brace group
 * with no top-level comma (`/users/{id}`) is literal, as before. Throws when the expansion would
 * exceed {@link MAX_GLOB_ALTERNATIVES}.
 */
export function expandBraces(pattern: string): string[] {
  let open = -1;
  let depth = 0;
  let comma = false;
  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern[i];
    if (ch === "{") {
      if (depth === 0) {
        open = i;
        comma = false;
      }
      depth += 1;
    } else if (ch === "}" && depth > 0) {
      depth -= 1;
      if (depth === 0 && comma) {
        const options: string[] = [];
        let d = 0;
        let start = open + 1;
        for (let j = open + 1; j < i; j++) {
          const c = pattern[j];
          if (c === "{") d += 1;
          else if (c === "}") d -= 1;
          else if (c === "," && d === 0) {
            options.push(pattern.slice(start, j));
            start = j + 1;
          }
        }
        options.push(pattern.slice(start, i));
        const head = pattern.slice(0, open);
        const tails = expandBraces(pattern.slice(i + 1));
        const out: string[] = [];
        for (const o of options) {
          for (const mid of expandBraces(o)) {
            for (const t of tails) {
              out.push(`${head}${mid}${t}`);
              if (out.length > MAX_GLOB_ALTERNATIVES) {
                throw new Error(`glob ${JSON.stringify(pattern)} expands to more than ${MAX_GLOB_ALTERNATIVES} alternatives`);
              }
            }
          }
        }
        return out;
      }
    } else if (ch === "," && depth === 1) {
      comma = true;
    }
  }
  return [pattern];
}

/**
 * `**` matches any number of path segments; `*` matches any run of characters within one segment;
 * `{a,b}` matches either alternative (#325). Every other character is literal (a `.` or `?` in a
 * route is never a regex operator).
 */
export function matchGlob(pattern: string, pathname: string): boolean {
  return expandBraces(pattern).some((p) => matchOneGlob(p, pathname));
}

function matchOneGlob(pattern: string, pathname: string): boolean {
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
