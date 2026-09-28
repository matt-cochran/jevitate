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

/**
 * #224: no default route scope can be derived from the start URL (it is unparseable, or not an
 * http(s) page with a path). A usage error — the caller refuses up front (exit 64) with a hint to
 * pass `--route`; never a run whose every page is silently out of scope.
 */
export class ScopeUnderivableError extends Error {
  constructor(reason: string) {
    super(`cannot derive a default route scope from the start URL (${reason}) — pass --route <glob>, e.g. --route "/shop/**"`);
    this.name = "ScopeUnderivableError";
  }
}

/**
 * The ONE place a mission's default route scope comes from (#224): the start URL's route and
 * everything under it (`<path>`, `<path>/`, `<path>/**`; the root is `/` and `/**`). Every strategy
 * — feature, coverage/exploratory, adversarial, and suite items — derives its start-route scope
 * here. Throws `ScopeUnderivableError` when the URL gives no route to scope to.
 */
export function startRouteGlobs(startUrl: string): string[] {
  let parsed: URL;
  try {
    parsed = new URL(startUrl);
  } catch {
    throw new ScopeUnderivableError("it is not a valid URL");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new ScopeUnderivableError(`a ${parsed.protocol} URL has no route`);
  }
  const route = routeOf(startUrl);
  return route === "/" ? ["/", "/**"] : [route, `${route}/`, `${route}/**`];
}

/** The scope's route globs: the start route, everything under it, and the caller's extra globs. */
export function scopeGlobs(startUrl: string, extra: readonly string[] = []): string[] {
  return [...new Set([...startRouteGlobs(startUrl), ...extra.filter((g) => g.trim() !== "")])];
}

/** Where a mission's route scope came from (#224): the caller's `--route` globs, or the start URL's route. */
export type RouteScopeSource = "route" | "start-url";

/** A mission's resolved route scope, stated in its result (#224). */
export interface MissionRouteScope {
  readonly routeGlobs: string[];
  readonly source: RouteScopeSource;
}

/**
 * A feature mission's route scope (#224): exactly the caller's `--route` globs when any are given
 * (unchanged behaviour), otherwise the start URL's route and everything under it — the same default
 * coverage and adversarial use (`startRouteGlobs`). Throws `ScopeUnderivableError` up front.
 */
export function resolveRouteScope(startUrl: string, routes: readonly string[] = []): MissionRouteScope {
  const given = [...new Set(routes.filter((g) => g.trim() !== ""))];
  if (given.length > 0) return { routeGlobs: given, source: "route" };
  return { routeGlobs: startRouteGlobs(startUrl), source: "start-url" };
}

/** A predicate over URLs: is this page inside the mission's target scope? */
export function scopePredicate(allowlist: readonly string[], globs: readonly string[]): (url: string) => boolean {
  const scope: CapabilityScope = { name: "adversarial-target", originAllowlist: allowlist, routeGlobs: globs };
  return (url) => isInScope(url, scope);
}
