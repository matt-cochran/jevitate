import { isInScope, type CapabilityScope } from "../feature/capability-scope.js";

/**
 * Scope containment for the adversarial mission (#64): the run is scoped to its TARGET — the start
 * URL's route (and everything under it), plus any route globs the caller adds (`--route`, the same
 * globs the feature mission uses). A page outside that scope is a departure: the mission records it
 * and resets to the start URL instead of hunting on an unrelated page.
 *
 * Globs use the feature mission's syntax (`matchGlob`): `*` is any run of characters within one
 * path segment, `**` any number of segments. Matching is on the path only (query and hash ignored),
 * and fails closed: an unparseable URL or an unauthorized origin is out of scope.
 */

/** The start URL's path without a trailing slash (the root stays `/`). */
export function routeOf(url: string): string {
  const path = new URL(url).pathname;
  return path.length > 1 && path.endsWith("/") ? path.slice(0, -1) : path;
}

/** The scope's route globs: the start route, everything under it, and the caller's extra globs. */
export function scopeGlobs(startUrl: string, extra: readonly string[] = []): string[] {
  const route = routeOf(startUrl);
  const own = route === "/" ? ["/", "/**"] : [route, `${route}/`, `${route}/**`];
  return [...new Set([...own, ...extra.filter((g) => g.trim() !== "")])];
}

/** A predicate over URLs: is this page inside the mission's target scope? */
export function scopePredicate(allowlist: readonly string[], globs: readonly string[]): (url: string) => boolean {
  const scope: CapabilityScope = { name: "adversarial-target", originAllowlist: allowlist, routeGlobs: globs };
  return (url) => isInScope(url, scope);
}
