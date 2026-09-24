import { redactUrl } from "@jevitate/ai-core";
import type { Page, Request } from "playwright";
import { DEFAULT_LONG_POLL_MS, urlMatcher, type SettleConfig } from "./settle-config.js";
import { visibleBusyIndicator } from "./hang.js";

/** The interactive-control selector (kept in step with `snapshot`). */
const INTERACTIVE_SELECTOR =
  "a[href],button,input:not([type=hidden]),select,textarea,[role=button],[role=link],[role=textbox],[role=checkbox],[role=combobox],[contenteditable=true]";

/** BROWSER CODE — true when an enabled interactive control has a rendered box. */
function hasEnabledControl(selector: string): boolean {
  for (const el of Array.from(document.querySelectorAll(selector))) {
    const r = (el as HTMLElement).getBoundingClientRect();
    const s = window.getComputedStyle(el as HTMLElement);
    if (r.width > 0 && r.height > 0 && s.visibility !== "hidden" && s.display !== "none" && !(el as HTMLButtonElement).disabled) {
      return true;
    }
  }
  return false;
}

/**
 * PageMonitor — the ONE place a page's activity is observed, so every mission shares one definition
 * of "the page has SETTLED" (owner ruling 4):
 *
 *   settled ⇔ no in-flight requests AND no STRUCTURAL DOM mutations for a quiet window (500ms).
 *
 * Not in-flight work: long-lived connections — WebSocket, EventSource, any response streamed as
 * `text/event-stream` (SSE over fetch/XHR) — requests the target marks as background
 * (`settle.ignoreRequests`), and auto-detected long-polls (a request pending longer than
 * `settle.longPollMs` while the page is otherwise interactive; see ./settle-config.ts). Not a DOM
 * change: text-only updates of existing nodes and inline-style animation.
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
  /** The REQUEST's `content-type` header, when it sent one (tells an RPC-over-POST read, #110). */
  readonly requestContentType?: string;
}

export interface CompletedRequest extends InflightRequest {
  readonly status: number | null;
  /** The response's `content-type` (null when there was no response). */
  readonly contentType: string | null;
  readonly durationMs: number;
  readonly failed: boolean;
  readonly endedAt: number;
  /**
   * `failed` fired AFTER a response had already been received (#73) — connect-web/gRPC-web clients
   * abort their fetch once the body is read, which Chromium reports as `requestfailed:
   * net::ERR_ABORTED` for an otherwise-successful request. `status` is the response that was
   * actually received; this just flags that the request's own end event was an abort, not a
   * clean finish.
   */
  readonly abortedAfterResponse?: boolean;
}

export interface SettleResult {
  readonly settled: boolean;
  /** How long the wait took (ms). */
  readonly waitedMs: number;
  /** Requests still in flight when the wait ended (empty when settled). */
  readonly pending: InflightRequest[];
  /** Long-lived requests treated as background while waiting (evidence: why they did not count). */
  readonly background?: Array<InflightRequest & { readonly why: "stream" | "ignored" | "long-poll" }>;
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
  const SEL = "a[href],button,input:not([type=hidden]),select,textarea,[role=button],[role=link],[role=textbox],[role=checkbox],[role=combobox],[contenteditable=true]";
  const VIS_ATTRS = new Set(["disabled", "hidden", "aria-hidden", "aria-busy", "aria-disabled", "open", "inert", "checked", "value"]);
  const textOnly = (nodes) => Array.from(nodes).every((n) => n.nodeType === 3 || n.nodeType === 8);
  // Only STRUCTURAL change resets the quiet window: nodes added/removed, or an attribute that can
  // change what is actionable. Text-only changes of existing nodes (a ticking clock, a live counter,
  // a re-rendered label) and inline-style animation do not — the page's structure is settled.
  const structural = (r) => {
    if (r.type === "characterData") return false;
    if (r.type === "childList") return !(textOnly(r.addedNodes) && textOnly(r.removedNodes));
    if (r.type === "attributes") {
      if (r.attributeName === "style") return false;
      if (VIS_ATTRS.has(r.attributeName)) return true;
      const el = r.target;
      return el.nodeType === 1 && (el.matches(SEL) || el.querySelector(SEL) !== null);
    }
    return true;
  };
  const start = () => {
    try {
      new MutationObserver((records) => {
        if (records.some(structural)) state.lastMutation = Date.now();
      }).observe(document, { subtree: true, childList: true, attributes: true, characterData: true });
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

/** One finished request, as a run-long capture keeps it (for network assertions). */
export interface CapturedRequest {
  readonly method: string;
  /** The redacted URL (sensitive query values masked). */
  readonly url: string;
  /** The URL's path (no query, no hash). */
  readonly path: string;
  /** The response status; null when the request failed without a response. */
  readonly status: number | null;
  readonly failed: boolean;
  /** See `CompletedRequest.abortedAfterResponse` (#73): `failed` fired after `status` was received. */
  readonly abortedAfterResponse?: boolean;
  /** Playwright's resource type (`xhr`, `fetch`, `document`, `script`, …) — classifies asset vs API (#130c). */
  readonly resourceType?: string;
  /** The RESPONSE's `content-type`, when known — also used to classify asset vs API (#130c). */
  readonly contentType?: string | null;
  /** When it started (the monitor's clock) — attributes a write to the action that fired it. */
  readonly startedAt?: number;
  /** The REQUEST's `content-type` header, when it sent one (#110). */
  readonly requestContentType?: string;
}

/** Most requests a capture keeps; past it the oldest are dropped and `truncated` is set. */
const MAX_CAPTURED = 20_000;

/**
 * Every request that finishes on a page from `startCapture()` on — unlike the timing window, which
 * forgets requests once a perception has read them. Network assertions (`requestMade`,
 * `responseStatus`) are evaluated over it.
 */
export class RequestCapture {
  readonly #requests: CapturedRequest[] = [];
  #truncated = false;

  /** @internal — fed by the page's monitor. */
  add(r: CapturedRequest): void {
    this.#requests.push(r);
    if (this.#requests.length > MAX_CAPTURED) {
      this.#requests.shift();
      this.#truncated = true;
    }
  }

  /** The requests captured so far, in the order they finished. */
  requests(): CapturedRequest[] {
    return [...this.#requests];
  }

  /** True when more requests finished than the capture keeps (the oldest were dropped). */
  get truncated(): boolean {
    return this.#truncated;
  }
}

function pathOf(url: string): string {
  try {
    return new URL(url).pathname;
  } catch {
    return url.split(/[?#]/)[0] ?? url;
  }
}

/** A request's own `content-type` header (never throws: a stub request may not expose headers). */
function requestContentTypeOf(r: Request): string | undefined {
  try {
    const v = r.headers()["content-type"];
    return typeof v === "string" && v !== "" ? v : undefined;
  } catch {
    return undefined;
  }
}

export class PageMonitor {
  readonly #page: Page;
  readonly #inflight = new Map<Request, InflightRequest>();
  readonly #completed: CompletedRequest[] = [];
  readonly #wakers = new Set<Wake>();
  readonly #statuses = new WeakMap<Request, number>();
  readonly #contentTypes = new WeakMap<Request, string>();
  readonly #now: () => number;
  #lastNetworkActivity: number;
  /** Long-lived requests that are not in-flight work, and why. */
  readonly #background = new Map<Request, "stream" | "ignored" | "long-poll">();
  #ignore: (url: string) => boolean = () => false;
  #longPollMs = DEFAULT_LONG_POLL_MS;
  #documentNavStartedAt: number | null = null;
  #instrumented: Promise<void> | undefined;
  readonly #captures = new Set<RequestCapture>();

  constructor(page: Page, now: () => number = Date.now) {
    this.#page = page;
    this.#now = now;
    this.#lastNetworkActivity = now();
    page.on("request", (r) => {
      const startedAt = this.#now();
      if (r.isNavigationRequest() && r.frame() === page.mainFrame()) this.#documentNavStartedAt = startedAt;
      const requestContentType = requestContentTypeOf(r);
      this.#inflight.set(r, {
        url: r.url(),
        method: r.method(),
        resourceType: r.resourceType(),
        startedAt,
        ...(requestContentType === undefined ? {} : { requestContentType }),
      });
      if (this.#ignore(r.url())) {
        this.#background.set(r, "ignored"); // the target's own background traffic: no activity either
        return;
      }
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
      const ignored = this.#background.get(r) === "ignored";
      this.#background.delete(r);
      if (started !== undefined) {
        // A response already received is NEVER discarded just because the request later "failed"
        // (#73): connect-web/gRPC-web clients abort their fetch once the body is read, which
        // Chromium reports as `requestfailed: net::ERR_ABORTED` for an otherwise-successful request.
        // Keep the status that was actually received; flag the abort as evidence, not as a failure.
        const status = this.#statuses.get(r) ?? null;
        const abortedAfterResponse = failed && status !== null;
        const endedAt = this.#now();
        const contentType = this.#contentTypes.get(r) ?? null;
        this.#completed.push({
          ...started,
          status,
          contentType,
          failed,
          abortedAfterResponse,
          endedAt,
          durationMs: Math.max(0, endedAt - started.startedAt),
        });
        for (const c of this.#captures) {
          c.add({
            method: started.method.toUpperCase(),
            url: redactUrl(started.url),
            path: pathOf(started.url),
            status,
            failed,
            abortedAfterResponse,
            resourceType: started.resourceType,
            contentType,
            startedAt: started.startedAt,
            ...(started.requestContentType === undefined ? {} : { requestContentType: started.requestContentType }),
          });
        }
      }
      if (!ignored) this.#touch();
    };
    page.on("requestfinished", (r) => end(r, false));
    page.on("requestfailed", (r) => end(r, true));
    page.on("response", (res) => {
      this.#statuses.set(res.request(), res.status());
      // SSE over fetch/XHR never "finishes": it is a long-lived connection, not pending work.
      const type = res.headers()["content-type"] ?? "";
      if (type !== "") this.#contentTypes.set(res.request(), type);
      if (type.includes("text/event-stream")) {
        this.#background.set(res.request(), "stream");
        this.#touch(); // wake a settle wait that was counting it as pending
      }
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

  /** Starts keeping every request that finishes from now on (until `stopCapture`). */
  startCapture(): RequestCapture {
    const c = new RequestCapture();
    this.#captures.add(c);
    return c;
  }

  /** Stops feeding `capture` (what it holds is kept). */
  stopCapture(capture: RequestCapture): void {
    this.#captures.delete(capture);
  }

  /** Applies the target's settle configuration (idempotent; the latest call wins). */
  configure(cfg: SettleConfig | undefined): void {
    this.#ignore = urlMatcher(cfg?.ignoreRequests);
    this.#longPollMs = cfg?.longPollMs ?? DEFAULT_LONG_POLL_MS;
    for (const [r] of this.#inflight) if (this.#ignore(r.url())) this.#background.set(r, "ignored");
  }

  /** Requests that are pending WORK: long-lived connections and background requests excluded. */
  pending(): InflightRequest[] {
    return [...this.#inflight.entries()]
      .filter(([r, info]) => !STREAM_TYPES.has(info.resourceType) && !this.#background.has(r))
      .map(([, info]) => info);
  }

  /** In-flight requests currently treated as background, and why. */
  background(): Array<InflightRequest & { why: "stream" | "ignored" | "long-poll" }> {
    const out: Array<InflightRequest & { why: "stream" | "ignored" | "long-poll" }> = [];
    for (const [r, info] of this.#inflight) {
      const why = STREAM_TYPES.has(info.resourceType) ? "stream" : this.#background.get(r);
      if (why !== undefined) out.push({ ...info, why });
    }
    return out;
  }

  /** Is the page otherwise interactive: a control rendered and no busy indicator showing? */
  async #interactive(boundMs: number): Promise<boolean> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const bound = new Promise<false>((resolve) => {
      timer = setTimeout(() => resolve(false), Math.max(1, boundMs));
    });
    const probe = (async (): Promise<boolean> => {
      const controls = await this.#page.evaluate(hasEnabledControl, INTERACTIVE_SELECTOR);
      if (!controls) return false;
      return (await this.#page.evaluate(visibleBusyIndicator)) === null;
    })().catch(() => false);
    try {
      return await Promise.race([probe, bound]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }

  /** Requests that ended since `sinceMs` (wall clock). */
  completedSince(sinceMs: number): CompletedRequest[] {
    return this.#completed.filter((r) => r.endedAt >= sinceMs);
  }

  // ---- the timing window: from one perception to the next (owner ruling 6) ----
  #windowStart: number | null = null;
  #actionAt: number | null = null;
  #lastDocId: string | null = null;

  /** Called by `act()` when it dispatches a page-changing action: the start of a transition. */
  markAction(): void {
    this.#actionAt = this.#now();
  }

  /** The open timing window (since the previous perception, or since the monitor started). */
  window(): { start: number; actionAt: number | null; lastDocId: string | null } {
    const start = this.#windowStart ?? 0;
    return { start, actionAt: this.#actionAt !== null && this.#actionAt >= start ? this.#actionAt : null, lastDocId: this.#lastDocId };
  }

  /** Closes the window at `at` (the perception just read the page) and forgets older requests. */
  closeWindow(at: number, docId: string | null): void {
    this.#windowStart = at;
    this.#actionAt = null;
    if (docId !== null) this.#lastDocId = docId;
    const keepFrom = at;
    for (let i = this.#completed.length - 1; i >= 0; i--) {
      const r = this.#completed[i];
      if (r !== undefined && r.endedAt < keepFrom) this.#completed.splice(i, 1);
    }
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
  #result(settled: boolean, start: number): SettleResult {
    const background = this.background();
    return {
      settled,
      waitedMs: this.#now() - start,
      pending: settled ? [] : this.pending(),
      ...(background.length === 0 ? {} : { background }),
    };
  }

  async waitSettled(opts: { quietMs?: number; ceilingMs: number }): Promise<SettleResult> {
    await this.instrument();
    const quietMs = opts.quietMs ?? SETTLE_QUIET_MS;
    const start = this.#now();
    const remaining = (): number => opts.ceilingMs - (this.#now() - start);
    for (;;) {
      if (remaining() <= 0) return this.#result(false, start);
      const pending = [...this.#inflight.entries()].filter(
        ([r, info]) => !STREAM_TYPES.has(info.resourceType) && !this.#background.has(r),
      );
      if (pending.length > 0) {
        const oldest = Math.min(...pending.map(([, info]) => info.startedAt));
        const untilLongPoll = oldest + this.#longPollMs - this.#now();
        if (untilLongPoll > 0) {
          await this.#sleepOrActivity(Math.min(remaining(), untilLongPoll));
          continue;
        }
        // A request has been pending past the long-poll threshold. On an otherwise interactive page
        // that is a long-lived connection (a long-poll): background. On a page that is NOT
        // interactive it is what a stuck page looks like, so it keeps counting.
        if (await this.#interactive(Math.min(remaining(), 2_000))) {
          const cutoff = this.#now() - this.#longPollMs;
          for (const [r, info] of pending) if (info.startedAt <= cutoff) this.#background.set(r, "long-poll");
          continue;
        }
        await this.#sleepOrActivity(Math.min(remaining(), quietMs));
        continue;
      }
      if (this.#page.isClosed()) return this.#result(false, start);
      const lastDom = await this.#lastMutation(Math.min(remaining(), 2_000));
      if (lastDom === null) {
        // The page did not answer (a busy main thread): not quiet. Give it a moment, within the ceiling.
        await this.#sleepOrActivity(Math.min(quietMs, remaining()));
        continue;
      }
      const t = this.#now();
      const quietFor = Math.min(t - this.#lastNetworkActivity, t - lastDom);
      if (quietFor >= quietMs && this.pending().length === 0) return this.#result(true, start);
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
