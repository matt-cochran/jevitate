import { clock } from "@jevitate/domain";
import type { BrowserContext, Request, Route } from "playwright";

/**
 * #521 (option A): one navigation the guard stopped because its target origin is not one of the
 * session's authorized origins. `url` is the target with its query and fragment stripped (they can
 * carry tokens); `at` is `clock.now()` when it was stopped; `frame` says whether it was a page's
 * main frame (a departure of the page itself, popups included) or a subframe (an embedded iframe).
 */
export interface BlockedNavigation {
  readonly url: string;
  readonly at: number;
  readonly frame: "main" | "sub";
}

/** `url` without its query and fragment (never throws; an unparseable URL is cut at `?`/`#`). */
function strippedUrl(url: string): string {
  try {
    const u = new URL(url);
    return `${u.origin}${u.pathname}`;
  } catch {
    return url.split(/[?#]/, 1)[0] ?? "";
  }
}

/** The http(s) origins of `entries` (a pattern or non-web entry authorizes nothing: fail-closed). */
function httpOrigins(entries: readonly string[]): Set<string> {
  const out = new Set<string>();
  for (const e of entries) {
    try {
      const u = new URL(e);
      if (u.protocol === "http:" || u.protocol === "https:") out.add(u.origin);
    } catch {
      // not a URL (e.g. a wildcard pattern)
    }
  }
  return out;
}

/**
 * #521 option A — the opt-in navigation guard (`OpenOptions.blockOffAllowlistNavigation`). Armed on
 * the CONTEXT (`context.route`), so popups are covered. An http(s) main-frame or subframe NAVIGATION
 * to an origin outside the authorized ones is answered `204 No Content` by the browser — never
 * aborted: an abort would land the page on `chrome-error://` and emit `ERR_BLOCKED_BY_CLIENT` noise —
 * so the page stays where it was, and the stop is recorded for the caller to `drain()` after each
 * settle. Every other request (subresources, fetch/XHR, allowlisted navigations) goes on with
 * `route.fallback()`, so it composes with `ReadOnlyGuard`'s page route (page routes run first).
 *
 * Limits (docs/design/allowed-origins.md): a server redirect is invisible to `route` (only the first
 * URL of a chain is routed), so the post-settle URL check stays the enforcement; and routing turns off
 * the context's HTTP cache.
 */
export class NavigationGuard {
  readonly #origins: Set<string>;
  #blocked: BlockedNavigation[] = [];
  readonly #handler = (route: Route, request: Request): Promise<void> => this.#route(route, request);

  /** `allowedOrigins` + `baseUrl` are the authorized origins (as for the geolocation grant). */
  constructor(allowedOrigins: readonly string[], baseUrl: string) {
    this.#origins = httpOrigins([...allowedOrigins, baseUrl]);
  }

  async arm(context: BrowserContext): Promise<void> {
    await context.route("**/*", this.#handler);
  }

  /** The navigations stopped since the last drain, oldest first; the record is then emptied. */
  drain(): readonly BlockedNavigation[] {
    const out = this.#blocked;
    this.#blocked = [];
    return out;
  }

  async #route(route: Route, request: Request): Promise<void> {
    const frame = this.#offAllowlistNavigation(request);
    if (frame === null) {
      await route.fallback().catch(() => undefined);
      return;
    }
    this.#blocked.push({ url: strippedUrl(request.url()), at: clock.now(), frame });
    await route.fulfill({ status: 204, body: "" }).catch(() => undefined);
  }

  /** Which frame an off-allowlist http(s) navigation is in, or null when `request` is not one. */
  #offAllowlistNavigation(request: Request): "main" | "sub" | null {
    let u: URL;
    try {
      if (!request.isNavigationRequest()) return null; // a service-worker request is never one
      u = new URL(request.url());
    } catch {
      return null;
    }
    if (u.protocol !== "http:" && u.protocol !== "https:") return null;
    if (this.#origins.has(u.origin)) return null;
    try {
      return request.frame().parentFrame() === null ? "main" : "sub";
    } catch {
      // A popup's first navigation is routed before its page exists: `frame()` throws. It is a main frame.
      return "main";
    }
  }
}
