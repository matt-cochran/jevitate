import type { Page, Request } from "playwright";

/**
 * PageMonitor — the ONE place a page's activity is observed, so every mission shares one definition
 * of "the page has SETTLED" (owner ruling 4):
 *
 *   settled ⇔ no in-flight requests AND no DOM mutations for a quiet window (default 500ms).
 *
 * Network activity is observed Node-side from Playwright's request events (event-driven: a waiter
 * wakes the moment a request starts or ends). DOM activity is observed in the page by a
 * MutationObserver installed as an init script (so it survives navigations) that stamps the time of
 * the latest mutation. Both clocks are wall-clock milliseconds on the same machine. Nothing here is
 * OS-specific: Playwright events and standard DOM APIs only.
 *
 * Long-lived streams (EventSource / WebSocket) are not "in flight" work — they never end by design —
 * so they never block settling.
 */

/** Default quiet window (ms): no requests in flight and no DOM mutations for this long ⇒ settled. */
export const SETTLE_QUIET_MS = 500;

/** Resource types that are open-ended streams, never counted as pending work. */
const STREAM_TYPES = new Set(["eventsource", "websocket"]);

export interface InflightRequest {
  readonly url: string;
  readonly method: string;
  readonly resourceType: string;
  readonly startedAt: number;
}

export interface CompletedRequest extends InflightRequest {
  readonly status: number | null;
  readonly durationMs: number;
  readonly failed: boolean;
}

export interface SettleResult {
  readonly settled: boolean;
  /** How long the wait took (ms). */
  readonly waitedMs: number;
  /** Requests still in flight when the wait ended (empty when settled). */
  readonly pending: InflightRequest[];
}

/**
 * In-page instrumentation (serialized; no closures). Idempotent: installed once per document.
 * `__jevitateMonitor.lastMutation` is the wall-clock time of the latest DOM mutation;
 * `docId` identifies the document (a new one after every navigation); `lcp` is the latest
 * Largest Contentful Paint (where the browser exposes it).
 */
const INSTRUMENT = `(() => {
  if (window.__jevitateMonitor) return;
  const state = { lastMutation: Date.now(), docId: Math.random().toString(36).slice(2), lcp: null };
  Object.defineProperty(window, "__jevitateMonitor", { value: state, enumerable: false });
  const start = () => {
    try {
      // A batch that only rewrites inline styles is animation, not new content: it does not count.
      new MutationObserver((records) => {
        if (records.some((r) => !(r.type === "attributes" && r.attributeName === "style"))) state.lastMutation = Date.now();
      })
        .observe(document, { subtree: true, childList: true, attributes: true, characterData: true });
    } catch (e) { /* no document yet */ }
  };
  start();
  try {
    new PerformanceObserver((list) => {
      const entries = list.getEntries();
      const last = entries[entries.length - 1];
      if (last) state.lcp = last.startTime;
    }).observe({ type: "largest-contentful-paint", buffered: true });
  } catch (e) { /* LCP not exposed by this browser */ }
})();`;

type Wake = () => void;

export class PageMonitor {
  readonly #page: Page;
  readonly #inflight = new Map<Request, InflightRequest>();
  readonly #completed: CompletedRequest[] = [];
  readonly #wakers = new Set<Wake>();
  readonly #statuses = new WeakMap<Request, number>();
  readonly #now: () => number;
  #lastNetworkActivity: number;
  #documentNavStartedAt: number | null = null;
  #instrumented: Promise<void> | undefined;

  constructor(page: Page, now: () => number = Date.now) {
    this.#page = page;
    this.#now = now;
    this.#lastNetworkActivity = now();
    page.on("request", (r) => {
      const startedAt = this.#now();
      if (r.isNavigationRequest() && r.frame() === page.mainFrame()) this.#documentNavStartedAt = startedAt;
      this.#inflight.set(r, { url: r.url(), method: r.method(), resourceType: r.resourceType(), startedAt });
      this.#touch();
    });
    // A new document replaced the old one: requests the OLD document started before the navigation
    // began can no longer finish, and Chromium does not always report them — drop them so they
    // cannot hold "settled" hostage. Requests the new document started are kept.
    page.on("domcontentloaded", () => {
      const navAt = this.#documentNavStartedAt;
      if (navAt === null) return;
      for (const [r, info] of this.#inflight) {
        if (info.startedAt < navAt) this.#inflight.delete(r);
      }
      this.#touch();
    });
    const end = (r: Request, failed: boolean): void => {
      const started = this.#inflight.get(r);
      this.#inflight.delete(r);
      if (started !== undefined) {
        const status = failed ? null : (this.#statuses.get(r) ?? null);
        this.#completed.push({ ...started, status, failed, durationMs: Math.max(0, this.#now() - started.startedAt) });
      }
      this.#touch();
    };
    page.on("requestfinished", (r) => end(r, false));
    page.on("requestfailed", (r) => end(r, true));
    page.on("response", (res) => {
      this.#statuses.set(res.request(), res.status());
    });
    // A navigation is activity too (a request abandoned by an unloading document is reported by
    // Chromium as `requestfailed`, which ends it above).
    page.on("framenavigated", (frame) => {
      if (frame === page.mainFrame()) this.#touch();
    });
  }

  #touch(): void {
    this.#lastNetworkActivity = this.#now();
    for (const wake of [...this.#wakers]) wake();
  }

  /** Installs the in-page instrumentation for this and every future document (idempotent). */
  instrument(): Promise<void> {
    this.#instrumented ??= (async () => {
      await this.#page.addInitScript(INSTRUMENT);
      await this.#page.evaluate(INSTRUMENT).catch(() => undefined);
    })();
    return this.#instrumented;
  }

  /** Requests that are pending work (streams excluded). */
  pending(): InflightRequest[] {
    return [...this.#inflight.values()].filter((r) => !STREAM_TYPES.has(r.resourceType));
  }

  /** Requests completed since `sinceMs` (wall clock). */
  completedSince(sinceMs: number): CompletedRequest[] {
    return this.#completed.filter((r) => r.startedAt >= sinceMs);
  }

  /** Waits up to `ms`, returning early on any network activity. */
  #sleepOrActivity(ms: number): Promise<void> {
    return new Promise((resolve) => {
      let done = false;
      const finish = (): void => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        this.#wakers.delete(finish);
        resolve();
      };
      const timer = setTimeout(finish, Math.max(0, ms));
      this.#wakers.add(finish);
    });
  }

  /**
   * The latest DOM mutation time, or null when the page could not answer within `boundMs` (a busy
   * main thread) — which counts as NOT quiet.
   */
  async #lastMutation(boundMs: number): Promise<number | null> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const bound = new Promise<null>((resolve) => {
      timer = setTimeout(() => resolve(null), Math.max(1, boundMs));
    });
    try {
      return await Promise.race([
        this.#page
          .evaluate(() => {
            const m = (window as unknown as { __jevitateMonitor?: { lastMutation: number } }).__jevitateMonitor;
            return m === undefined ? Date.now() : m.lastMutation;
          })
          .catch(() => null),
        bound,
      ]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }

  /**
   * Resolves when the page has been quiet (no pending requests, no DOM mutations) for `quietMs`, or
   * when `ceilingMs` elapses (`settled: false`). Event-driven on the network side: it wakes on
   * request activity rather than polling; the DOM side is checked when a quiet window could have
   * elapsed.
   */
  async waitSettled(opts: { quietMs?: number; ceilingMs: number }): Promise<SettleResult> {
    await this.instrument();
    const quietMs = opts.quietMs ?? SETTLE_QUIET_MS;
    const start = this.#now();
    const remaining = (): number => opts.ceilingMs - (this.#now() - start);
    for (;;) {
      if (remaining() <= 0) return { settled: false, waitedMs: this.#now() - start, pending: this.pending() };
      if (this.pending().length > 0) {
        await this.#sleepOrActivity(remaining());
        continue;
      }
      if (this.#page.isClosed()) return { settled: false, waitedMs: this.#now() - start, pending: this.pending() };
      const lastDom = await this.#lastMutation(Math.min(remaining(), 2_000));
      if (lastDom === null) {
        // The page did not answer (a busy main thread): not quiet. Give it a moment, within the ceiling.
        await this.#sleepOrActivity(Math.min(quietMs, remaining()));
        continue;
      }
      const t = this.#now();
      const quietFor = Math.min(t - this.#lastNetworkActivity, t - lastDom);
      if (quietFor >= quietMs && this.pending().length === 0) {
        return { settled: true, waitedMs: t - start, pending: [] };
      }
      await this.#sleepOrActivity(Math.min(quietMs - Math.max(0, quietFor), remaining()));
    }
  }
}

const MONITORS = new WeakMap<Page, PageMonitor>();

/** The page's monitor (created and attached on first use; one per page). */
export function monitorFor(page: Page): PageMonitor {
  let m = MONITORS.get(page);
  if (m === undefined) {
    m = new PageMonitor(page);
    MONITORS.set(page, m);
  }
  return m;
}
