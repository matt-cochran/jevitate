import type { BrowserContext, Page, Request, Route, WebSocketRoute } from "playwright";
import type { BlockedWriteRef, HealWriteGuard } from "@jevitate/runtime";
import { monitorFor } from "@jevitate/explore";

/**
 * #453 (Q2, review): the write guard a guarded click/fill heal probe runs under. Stricter than the
 * find-out `ReadOnlyGuard` on purpose — a probe clicks a control the model or the change evidence
 * PROPOSED, so nothing it sends may reach a server:
 *  - NO exemptions: every request whose method is not GET/HEAD/OPTIONS is aborted while a probe is
 *    armed — whatever its origin (third-party, credential-free included) and whatever its path
 *    (`/token`, `/oauth/…`, `/refresh` included). A navigation with a body is such a request.
 *  - BrowserContext level: `context.route` sees every page of the context, so a popup or new tab the
 *    click opens is guarded too.
 *  - WebSockets: every socket of the context is proxied (`context.routeWebSocket`, installed before
 *    the run so sockets opened earlier are covered); a frame the page sends while a probe is armed is
 *    dropped and counted as a blocked write.
 *  - Service workers: a request a service worker answers or sends itself may never reach
 *    `context.route`. The simplest fail-closed rule: a probe is never run while a service worker is
 *    registered for the page (`unguardable`), and one registered DURING the probe rejects it.
 * Any blocked request rejects the candidate `write-attempted` (the runner adjudicates). Outside an
 * armed probe every request and frame passes through untouched.
 */

const READ_METHODS: ReadonlySet<string> = new Set(["GET", "HEAD", "OPTIONS"]);

/** How long an armed probe's window stays open for the writes its action triggers (network settle). */
const SETTLE_MS = 5_000;

/** Origin + path of a URL (never its query — it can carry a token). */
function endpoint(url: string): string {
  try {
    const u = new URL(url);
    return u.origin === "null" ? u.protocol : `${u.origin}${u.pathname}`;
  } catch {
    return url.split(/[?#]/)[0] ?? url;
  }
}

/** Service workers registered for the page (their scopes), read in the page. */
async function registeredServiceWorkers(page: Page, context: BrowserContext): Promise<string[]> {
  const scopes = new Set<string>(context.serviceWorkers().map((w) => endpoint(w.url())));
  if (!page.isClosed()) {
    // BROWSER CODE
    const inPage = await page.evaluate(async () => {
      const sw = (navigator as Navigator & { serviceWorker?: ServiceWorkerContainer }).serviceWorker;
      if (sw === undefined) return [];
      const regs = await sw.getRegistrations();
      return regs.map((r) => r.scope);
    });
    for (const s of inPage) scopes.add(endpoint(s));
  }
  return [...scopes];
}

export interface HealProbeGuard {
  readonly guard: HealWriteGuard;
  /** Unroutes the HTTP handler (the WebSocket proxy stays transparent until the context closes). */
  dispose(): Promise<void>;
}

/** Installs the guard on the page's BrowserContext (HTTP routes + WebSocket proxy), unarmed. */
export async function installHealProbeGuard(page: Page): Promise<HealProbeGuard> {
  const context = page.context();
  const monitor = monitorFor(page);
  let armed = false;
  let blocked: BlockedWriteRef[] = [];

  const onRequest = async (route: Route, request: Request): Promise<void> => {
    const method = request.method().toUpperCase();
    if (!armed || READ_METHODS.has(method)) {
      await route.fallback().catch(() => undefined);
      return;
    }
    blocked.push({ method, url: endpoint(request.url()) });
    await route.abort("blockedbyclient").catch(() => undefined);
  };
  const onSocket = (ws: WebSocketRoute): void => {
    const server = ws.connectToServer();
    ws.onMessage((message) => {
      if (armed) {
        blocked.push({ method: "WEBSOCKET", url: endpoint(ws.url()) });
        return;
      }
      server.send(message);
    });
    server.onMessage((message) => ws.send(message));
  };
  await context.route("**/*", onRequest);
  await context.routeWebSocket(/.*/, onSocket);

  const guard: HealWriteGuard = {
    unguardable: async () => {
      const workers = await registeredServiceWorkers(page, context);
      return workers.length === 0 ? null : `a service worker is registered for this page (${workers.join(", ")}) — requests it handles may bypass the write guard`;
    },
    armAt: async () => {
      blocked = [];
      await monitor.instrument().catch(() => undefined);
      armed = true;
    },
    disarm: async () => {
      if (!armed) return [];
      try {
        await monitor.waitSettled({ ceilingMs: SETTLE_MS }).catch(() => undefined);
        const workers = await registeredServiceWorkers(page, context).catch(() => ["(unknown)"]);
        for (const w of workers) blocked.push({ method: "SERVICE-WORKER", url: w });
      } finally {
        armed = false;
      }
      const out = blocked;
      blocked = [];
      return out;
    },
  };
  return {
    guard,
    dispose: async () => {
      armed = false;
      await context.unroute("**/*", onRequest).catch(() => undefined);
    },
  };
}
