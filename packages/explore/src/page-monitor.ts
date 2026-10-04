import { redactUrl } from "@jevitate/ai-core";
import type { Page, Request } from "playwright";
import { DEFAULT_LONG_POLL_MS, urlMatcher, type SettleConfig } from "./settle-config.js";
import { visibleBusyIndicator } from "./hang.js";
import { clock, isExternalSchemeUrl } from "@jevitate/domain";
import { RPC_CONTENT, rpcStatusOfResponse, type RpcStatus } from "./rpc-status.js";
import { clockBounded } from "./clock-bound.js";

/** #378: how long a finished RPC's trailer read may hold its end back; past it the header status stands. */
export const RPC_TRAILER_READ_MS = 2_000;

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

/**
 * Longest delay (ms) of a timer a user action's handler schedules that settling still waits for
 * (#152): a delayed effect of the action itself. Longer timers are the app's business, not the
 * action's immediate effect.
 */
export const DEFERRED_EFFECT_MAX_MS = 5_000;

/**
 * Response content types that are STREAMS (#153): once such a response has STARTED (headers
 * received), the request is a long-lived connection the server keeps writing to — SSE, gRPC-web and
 * Connect server streams, NDJSON / JSON-seq feeds, multipart replace — not pending work. A request
 * that never got a response at all is still pending (and can still be a hang).
 */
export const STREAMING_CONTENT =
  /^\s*(?:text\/event-stream|application\/grpc-web(?:-text)?(?:\+[\w.-]+)?|application\/connect\+[\w.-]+|application\/(?:x-)?ndjson|application\/jsonl|application\/json-seq|application\/stream\+json|multipart\/x-mixed-replace)\b/i;

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
  /** A `--settle-ignore`d request (telemetry, a beacon): the target's background traffic, never its work. */
  readonly ignored?: true;
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
 * #303: what counts as an ANNOUNCEMENT the page made (a toast, a banner, a live region's update) —
 * noted by the monitor's observer as it happens, so an action's delta still sees one that was gone
 * before the page settled.
 */
export const TRANSIENT_SELECTOR =
  "[aria-live]:not([aria-live=off]),[role=status],[role=alert],[role=log],[class*=toast],[class*=snackbar],[class*=notification]";
/** A dialog counts as an announcement only when it is itself ADDED (never for edits inside it). */
const TRANSIENT_DIALOG_SELECTOR = "[role=dialog],[role=alertdialog],dialog";
/** Bound on the announcements the page keeps (oldest dropped first). */
const TRANSIENT_MAX = 50;
/** Bound (chars) on one announcement's text. */
const TRANSIENT_TEXT_MAX = 200;

/** One announcement the page made (raw page text — redact before keeping or sending it). */
export interface TransientNote {
  readonly t: number;
  readonly role: string;
  readonly text: string;
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
  // #303: short-lived announcements (a toast, a banner, a live region's update) are often gone by the
  // time the page settles and an action's delta is read: the SAME observer notes each one (bounded
  // ring, raw text stays in the page until read; the reader redacts it before anything keeps it).
  state.transients = [];
  const ANNOUNCE = "${TRANSIENT_SELECTOR}";
  const ADDED = ANNOUNCE + ",${TRANSIENT_DIALOG_SELECTOR}";
  const announcer = (n) => {
    const el = n === null ? null : n.nodeType === 1 ? n : n.parentElement;
    if (el === null || el === undefined || typeof el.closest !== "function") return null;
    return el.closest(ANNOUNCE);
  };
  const noteTransients = (records) => {
    const seen = new Set();
    for (const r of records) {
      let el = null;
      if (r.type === "characterData") el = announcer(r.target);
      else if (r.type === "childList") {
        el = announcer(r.target);
        if (el === null) for (const n of r.addedNodes) { if (n.nodeType === 1 && n.matches(ADDED)) { el = n; break; } }
      }
      if (el === null || seen.has(el)) continue;
      seen.add(el);
      const text = (el.textContent || "").replace(/\\s+/g, " ").trim().slice(0, ${TRANSIENT_TEXT_MAX});
      if (text === "") continue;
      const role = el.getAttribute("role") || (el.tagName === "DIALOG" ? "dialog" : "live");
      const last = state.transients[state.transients.length - 1];
      if (last && last.text === text && last.role === role) { last.t = Date.now(); continue; }
      state.transients.push({ t: Date.now(), role, text });
      if (state.transients.length > ${TRANSIENT_MAX}) state.transients.splice(0, state.transients.length - ${TRANSIENT_MAX});
    }
  };
  const start = () => {
    try {
      new MutationObserver((records) => {
        if (records.some(structural)) state.lastMutation = Date.now();
        // Only while a run records action deltas (#303, opt-in): off, the observer does no more work.
        if (window.__jevitateDeltasOn === true) {
          try { noteTransients(records); } catch (e) { /* never let the note break settling */ }
        }
      }).observe(document, { subtree: true, childList: true, attributes: true, characterData: true });
    } catch (e) { /* no document yet */ }
  };
  start();
  // Deferred effects of a USER action (#152): a timer a trusted input event's handler schedules
  // (a delayed state update, a debounced refetch) is part of that action's effect. Its due time is
  // kept until it fires or is cleared, so settling waits for it (bounded by the settle ceiling and
  // by ${DEFERRED_EFFECT_MAX_MS}ms per timer). Timers scheduled outside an input event (pollers,
  // clocks) are never tracked, so they cannot hold "settled" hostage.
  state.deferred = new Map();
  try {
    const USER_EVENTS = new Set(["click", "dblclick", "mousedown", "mouseup", "pointerdown", "pointerup", "keydown", "keyup", "keypress", "input", "change", "submit", "touchstart", "touchend"]);
    const origSet = window.setTimeout;
    const origClear = window.clearTimeout;
    window.setTimeout = function (fn, ms, ...args) {
      const ev = window.event;
      const delay = Number(ms) || 0;
      const tracked = ev !== undefined && ev !== null && ev.isTrusted && USER_EVENTS.has(ev.type) && delay > 0 && delay <= ${DEFERRED_EFFECT_MAX_MS};
      let id;
      const wrapped = typeof fn === "function" && tracked
        ? function (...a) { state.deferred.delete(id); return fn.apply(this, a); }
        : fn;
      id = origSet.call(window, wrapped, ms, ...args);
      if (tracked) state.deferred.set(id, Date.now() + delay);
      return id;
    };
    window.clearTimeout = function (id) {
      state.deferred.delete(id);
      return origClear.call(window, id);
    };
  } catch (e) { /* timers not patchable: deferred effects are then only seen by the quiet window */ }
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
  /**
   * #283: the request was SENT but had not finished when the capture was read (a unary RPC the
   * server holds open for minutes, or one its document abandoned without an end event). Only
   * `RequestCapture.sent()` lists these; `status` is null.
   */
  readonly pending?: true;
  /**
   * #378: a gRPC-web / Connect call's own result (`grpc-status`, from a header or the body's trailer
   * frame) — an HTTP 200 can carry a failed RPC. See `effectiveStatus`. Absent when not an RPC (or
   * its status could not be read).
   */
  readonly rpcStatus?: RpcStatus;
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
  /** #283: requests sent since the capture started that have not finished (keyed by the request). */
  readonly #inflight = new Map<object, CapturedRequest>();
  /** #283: requests sent that never reported an end (their document went away first). */
  readonly #unfinished: CapturedRequest[] = [];
  #truncated = false;

  /** @internal — fed by the page's monitor. */
  add(r: CapturedRequest): void {
    this.#requests.push(r);
    if (this.#requests.length > MAX_CAPTURED) {
      this.#requests.shift();
      this.#truncated = true;
    }
  }

  /** @internal — the page's monitor saw `key` sent. */
  began(key: object, r: CapturedRequest): void {
    this.#inflight.set(key, { ...r, status: null, failed: false, pending: true });
  }

  /**
   * @internal — `key` ended. `finished` is its finished record (then `add`ed), or null when the
   * monitor had already forgotten it (its document was replaced): it stays "sent, never finished".
   */
  ended(key: object, finished: CapturedRequest | null): void {
    const sent = this.#inflight.get(key);
    this.#inflight.delete(key);
    if (finished !== null) this.add(finished);
    else if (sent !== undefined && this.#unfinished.length < MAX_CAPTURED) this.#unfinished.push(sent);
  }

  /** The requests captured so far, in the order they finished. */
  requests(): CapturedRequest[] {
    return [...this.#requests];
  }

  /**
   * Every request SENT since the capture started (#283): the finished ones (`requests()`), then the
   * ones still in flight or abandoned without an end event (`pending: true`, `status: null`). A
   * `requestMade` check is judged over these — a request counts once it was sent, whether or not
   * its response has arrived.
   */
  sent(): CapturedRequest[] {
    return [...this.#requests, ...this.#unfinished, ...this.#inflight.values()];
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

/** How long (ms) finished requests are remembered past a perception — `BACKGROUND_WINDOW_MS`'s look-back. */
const RECENT_REQUESTS_MS = 60_000;

export class PageMonitor {
  readonly #page: Page;
  readonly #inflight = new Map<Request, InflightRequest>();
  readonly #completed: CompletedRequest[] = [];
  readonly #wakers = new Set<Wake>();
  readonly #statuses = new WeakMap<Request, number>();
  readonly #contentTypes = new WeakMap<Request, string>();
  /** #378: the RPC-status read of a gRPC-web / Connect response (its end waits for it). */
  readonly #rpcReads = new WeakMap<Request, Promise<RpcStatus | null>>();
  readonly #rpcStatuses = new WeakMap<Request, RpcStatus>();
  readonly #now: () => number;
  #lastNetworkActivity: number;
  /** The last main-frame navigation (activity no request filter can discount). */
  #lastNavigation: number;
  /** Long-lived requests that are not in-flight work, and why. */
  readonly #background = new Map<Request, "stream" | "ignored" | "long-poll">();
  #ignore: (url: string) => boolean = () => false;
  #longPollMs = DEFAULT_LONG_POLL_MS;
  #documentNavStartedAt: number | null = null;
  #instrumented: Promise<void> | undefined;
  readonly #captures = new Set<RequestCapture>();

  constructor(page: Page, now: () => number = clock.now) {
    this.#page = page;
    this.#now = now;
    this.#lastNetworkActivity = now();
    this.#lastNavigation = now();
    page.on("request", (r) => {
      // #375: an sms:/tel:/mailto:/deep-link navigation is handed to the OS, never fetched — not
      // pending work, not a failed request, not a document navigation of the page.
      if (isExternalSchemeUrl(r.url())) return;
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
      for (const c of this.#captures) {
        c.began(r, {
          method: r.method().toUpperCase(),
          url: redactUrl(r.url()),
          path: pathOf(r.url()),
          status: null,
          failed: false,
          resourceType: r.resourceType(),
          startedAt,
          ...(requestContentType === undefined ? {} : { requestContentType }),
        });
      }
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
        if (info.startedAt >= navAt) continue;
        // #289: a request the old document already got its RESPONSE for (a save whose handler then
        // navigated away on the response) ended with that status — kept as completed, never lost.
        if (this.#statuses.has(r)) end(r, false);
        else this.#inflight.delete(r);
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
        const rpcStatus = this.#rpcStatuses.get(r);
        this.#completed.push({
          ...started,
          status,
          contentType,
          failed,
          abortedAfterResponse,
          endedAt,
          durationMs: Math.max(0, endedAt - started.startedAt),
          ...(ignored ? { ignored: true as const } : {}),
        });
        for (const c of this.#captures) {
          c.ended(r, {
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
            ...(rpcStatus === undefined ? {} : { rpcStatus }),
          });
        }
      } else {
        for (const c of this.#captures) c.ended(r, null);
      }
      if (!ignored) this.#touch();
    };
    // #378: a gRPC-web / Connect response's status may be in its body's trailer frame — its end is
    // recorded once that (bounded, one-shot) read is done, so every capture sees the RPC's result.
    const finish = (r: Request, failed: boolean): void => {
      const read = this.#rpcReads.get(r);
      if (read === undefined) {
        end(r, failed);
        return;
      }
      this.#rpcReads.delete(r);
      // Bounded: a body that never resolves (an aborted fetch, a closing context) must not leave a
      // finished request pending — that would read as a request-pending hang.
      void clockBounded(read, RPC_TRAILER_READ_MS, null).then((s) => {
        if (s !== null) this.#rpcStatuses.set(r, s);
        end(r, failed);
      });
    };
    page.on("requestfinished", (r) => finish(r, false));
    page.on("requestfailed", (r) => finish(r, true));
    page.on("response", (res) => {
      this.#statuses.set(res.request(), res.status());
      // SSE over fetch/XHR never "finishes": it is a long-lived connection, not pending work.
      const type = res.headers()["content-type"] ?? "";
      if (type !== "") this.#contentTypes.set(res.request(), type);
      if (RPC_CONTENT.test(type) || res.headers()["grpc-status"] !== undefined) this.#rpcReads.set(res.request(), rpcStatusOfResponse(res));
      if (STREAMING_CONTENT.test(type)) {
        this.#background.set(res.request(), "stream");
        this.#touch(); // wake a settle wait that was counting it as pending
      }
    });
    // A navigation is activity too (a request abandoned by an unloading document is reported by
    // Chromium as `requestfailed`, which ends it above).
    page.on("framenavigated", (frame) => {
      if (frame === page.mainFrame()) {
        this.#lastNavigation = this.#now();
        this.#touch();
      }
    });
  }

  /**
   * The latest network activity, discounting requests `ignore` names (and `--settle-ignore`d ones):
   * the last start of one still in flight, the last end of a finished one, or a navigation.
   */
  #lastActivityExcept(ignore: (r: InflightRequest) => boolean): number {
    let at = this.#lastNavigation;
    for (const [r, info] of this.#inflight) {
      if (this.#background.get(r) !== "ignored" && !ignore(info)) at = Math.max(at, info.startedAt);
    }
    for (const c of this.#completed) if (c.ignored !== true && !ignore(c)) at = Math.max(at, c.endedAt);
    return at;
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

  /**
   * Every request that has not finished yet (#283) — pending work AND requests the settle rule treats
   * as background (a long-poll, a stream, a `--settle-ignore`d one). Settle never waits on the
   * background ones, but a write a run's action fired is still in flight until it ENDS: a unary RPC
   * the server holds open for minutes is demoted to "long-poll" for settling, never forgotten.
   */
  unfinished(): InflightRequest[] {
    return [...this.#inflight.values()];
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
      timer = clock.setTimeout(() => resolve(false), Math.max(1, boundMs));
    });
    const probe = (async (): Promise<boolean> => {
      const controls = await this.#page.evaluate(hasEnabledControl, INTERACTIVE_SELECTOR);
      if (!controls) return false;
      return (await this.#page.evaluate(visibleBusyIndicator)) === null;
    })().catch(() => false);
    try {
      return await Promise.race([probe, bound]);
    } finally {
      if (timer !== undefined) clock.clearTimeout(timer);
    }
  }

  /**
   * #303: the announcements (toasts, banners, live-region updates) the page made at or after
   * `sinceMs` (wall clock), oldest first — RAW page text: the caller redacts it before keeping it.
   * Empty when the page cannot answer within `boundMs`.
   */
  async transientsSince(sinceMs: number, boundMs = 1_000): Promise<TransientNote[]> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const bound = new Promise<TransientNote[]>((resolve) => {
      timer = clock.setTimeout(() => resolve([]), Math.max(1, boundMs));
    });
    try {
      return await Promise.race([
        this.#page
          // `since` is Node time; the page stamps its notes with ITS clock (#304: the two may differ —
          // `page.clock` in tests), so the cut is made by AGE: the same number of ms back in page time.
          .evaluate(
            ({ ageMs }) => {
              const m = (window as unknown as { __jevitateMonitor?: { transients?: Array<{ t: number; role: string; text: string }> } }).__jevitateMonitor;
              const since = Date.now() - ageMs;
              return (m?.transients ?? []).filter((x) => x.t >= since).map((x) => ({ t: x.t, role: x.role, text: x.text }));
            },
            { ageMs: this.#now() - sinceMs },
          )
          .catch(() => [] as TransientNote[]),
        bound,
      ]);
    } finally {
      if (timer !== undefined) clock.clearTimeout(timer);
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
  /** #368: time spent since the action inside a wait the run chose (a reply wait, a job wait). */
  #waitedMs = 0;
  #waitDepth = 0;

  /** Called by `act()` when it dispatches a page-changing action: the start of a transition. */
  markAction(): void {
    this.#actionAt = this.#now();
    this.#waitedMs = 0;
  }

  /**
   * #368: runs an EXPLICIT wait the run chose (a chat reply wait `--reply-wait-ms`, a job wait
   * `--job-wait-ms`, a `wait` decision) and books its duration as waiting, not as the page's render:
   * the transition's `settleMs` excludes it, so a 30s reply wait never reads as a 30s render (and
   * never feeds the host-health render trend). Nested waits count once.
   */
  async explicitWait<T>(wait: () => Promise<T>): Promise<T> {
    const started = this.#now();
    this.#waitDepth += 1;
    try {
      return await wait();
    } finally {
      this.#waitDepth -= 1;
      if (this.#waitDepth === 0) this.#waitedMs += Math.max(0, this.#now() - started);
    }
  }

  /** The open timing window (since the previous perception, or since the monitor started). */
  window(): { start: number; actionAt: number | null; lastDocId: string | null; waitedMs: number } {
    const start = this.#windowStart ?? 0;
    const actionAt = this.#actionAt !== null && this.#actionAt >= start ? this.#actionAt : null;
    return { start, actionAt, lastDocId: this.#lastDocId, waitedMs: actionAt === null ? 0 : this.#waitedMs };
  }

  /**
   * Closes the window at `at` (the perception just read the page) and forgets requests that ended
   * more than `RECENT_REQUESTS_MS` before it. The window's own readers ask `completedSince(start)`;
   * the recent history is what tells the page's background polling from an action's work (#241:
   * `backgroundEndpoints` looks back that far) — forgotten at every perception, a poll that ran
   * between two quick decisions was taken for the action's effect.
   */
  closeWindow(at: number, docId: string | null): void {
    this.#windowStart = at;
    this.#actionAt = null;
    this.#waitedMs = 0;
    if (docId !== null) this.#lastDocId = docId;
    const keepFrom = at - RECENT_REQUESTS_MS;
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
        clock.clearTimeout(timer);
        this.#wakers.delete(finish);
        resolve();
      };
      const timer = clock.setTimeout(finish, Math.max(0, ms));
      this.#wakers.add(finish);
    });
  }

  /**
   * The latest DOM mutation time, or null when the page could not answer within `boundMs` (a busy
   * main thread) — which counts as NOT quiet.
   */
  async #lastMutation(boundMs: number): Promise<{ lastMutation: number; deferredUntil: number; pageNow: number } | null> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const bound = new Promise<null>((resolve) => {
      timer = clock.setTimeout(() => resolve(null), Math.max(1, boundMs));
    });
    try {
      return await Promise.race([
        this.#page
          .evaluate(() => {
            const m = (window as unknown as { __jevitateMonitor?: { lastMutation: number; deferred?: Map<unknown, number> } }).__jevitateMonitor;
            const pageNow = Date.now();
            if (m === undefined) return { lastMutation: pageNow, deferredUntil: 0, pageNow };
            let deferredUntil = 0;
            for (const due of m.deferred?.values() ?? []) deferredUntil = Math.max(deferredUntil, due);
            return { lastMutation: m.lastMutation, deferredUntil, pageNow };
          })
          .catch(() => null),
        bound,
      ]);
    } finally {
      if (timer !== undefined) clock.clearTimeout(timer);
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

  /**
   * Waits until the page has settled: no pending request and no network or DOM activity for
   * `quietMs`, bounded by `ceilingMs`. `ignoreRequest` discounts requests that are not the awaited
   * work — the page's background polling (#241): neither pending nor activity.
   */
  async waitSettled(opts: { quietMs?: number; ceilingMs: number; ignoreRequest?: (r: InflightRequest) => boolean }): Promise<SettleResult> {
    await this.instrument();
    const ignore = opts.ignoreRequest;
    const quietMs = opts.quietMs ?? SETTLE_QUIET_MS;
    const start = this.#now();
    const remaining = (): number => opts.ceilingMs - (this.#now() - start);
    for (;;) {
      if (remaining() <= 0) return this.#result(false, start);
      const pending = [...this.#inflight.entries()].filter(
        ([r, info]) => !STREAM_TYPES.has(info.resourceType) && !this.#background.has(r) && !(ignore?.(info) ?? false),
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
      const dom = await this.#lastMutation(Math.min(remaining(), 2_000));
      if (dom === null) {
        // The page did not answer (a busy main thread): not quiet. Give it a moment, within the ceiling.
        await this.#sleepOrActivity(Math.min(quietMs, remaining()));
        continue;
      }
      const t = this.#now();
      // The page's stamps (mutations, deferred timers) are in the PAGE's clock and are compared with the
      // page's own "now" (#304: page time may be `page.clock`, not Node's), network/action times in Node's.
      // A timer the action's own handler scheduled is still due (#152): its effect has not landed.
      if (dom.deferredUntil > dom.pageNow) {
        await this.#sleepOrActivity(Math.min(dom.deferredUntil - dom.pageNow, remaining()));
        continue;
      }
      // The quiet window is measured from AFTER the action (#152): a page that was already quiet
      // before it must still stay quiet for `quietMs` once the action was dispatched, or an effect
      // landing a few hundred ms later would be snapshotted into the NEXT action.
      const actionAt = this.#actionAt ?? Number.NEGATIVE_INFINITY;
      const network = ignore === undefined ? this.#lastNetworkActivity : this.#lastActivityExcept(ignore);
      const quietFor = Math.min(t - Math.max(network, actionAt), dom.pageNow - dom.lastMutation);
      const stillPending = ignore === undefined ? this.pending().length : this.pending().filter((r) => !ignore(r)).length;
      if (quietFor >= quietMs && stillPending === 0) return this.#result(true, start);
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
