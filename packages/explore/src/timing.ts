import type { Page } from "playwright";
import { redactUrl } from "@jevitate/ai-core";
import { normalizeRoute } from "./adversarial/defect-fingerprint.js";
import type { CompletedRequest, InflightRequest, SettleResult } from "./page-monitor.js";

/**
 * Page timing (owner ruling 6): MEASUREMENTS, not verdicts — nothing here flags a defect.
 *
 * Every perception records how the page got to the state it shows:
 *  - `navigation` — when a NEW document loaded since the last look: Navigation Timing
 *    (`performance.getEntriesByType('navigation')`) TTFB, DOMContentLoaded and load;
 *  - `transition` — a client-side change after an action: action-to-settled time, measured with
 *    the SAME settle rule perception uses (no second definition of "done");
 *  - the page's network in that window: request count, the slowest requests (URL redacted and
 *    normalized to an endpoint pattern, status, duration), from Playwright's request events;
 *  - LCP, where the browser exposes it.
 *
 * Portable: standard browser Performance APIs + Playwright events only (no CDP).
 */

export interface NavigationTiming {
  /** Time to first byte: responseStart − navigation start (ms). */
  readonly ttfbMs: number;
  /** DOMContentLoaded end − navigation start (ms). */
  readonly domContentLoadedMs: number;
  /** load end − navigation start (ms); null while the load event has not finished. */
  readonly loadMs: number | null;
}

/**
 * What a request is, for timing: the app's `api` (XHR/fetch returning data, or a configured API
 * prefix), a `document` (a page load), an `asset` (script/style/font/image/media — including a dev
 * server's modules such as Vite's `/src/…`, `/@vite/…`, `/node_modules/…`), or `other`.
 */
export type RequestKind = "api" | "document" | "asset" | "other";

const ASSET_RESOURCE_TYPES = new Set(["script", "stylesheet", "font", "image", "media", "manifest", "texttrack"]);
const DEV_MODULE_PATH = /^\/(?:src|@vite|@fs|@id|@react-refresh|node_modules)\//;
const ASSET_EXTENSION = /\.(?:m?[jt]sx?|css|scss|map|woff2?|ttf|otf|eot|png|jpe?g|gif|svg|webp|avif|ico|mp4|webm|mp3|wav)$/i;
const DATA_CONTENT_TYPE = /\b(?:json|xml|protobuf|grpc|graphql|csv|x-www-form-urlencoded|octet-stream|text\/plain|event-stream)\b/i;
const ASSET_CONTENT_TYPE = /\b(?:javascript|ecmascript|css|font|image\/|video\/|audio\/|wasm)\b/i;

/** Classifies one request (pure). */
export function classifyRequest(
  r: { readonly url: string; readonly resourceType: string; readonly contentType?: string | null },
  apiPrefixes: readonly string[] = [],
): RequestKind {
  let path = r.url;
  try {
    path = new URL(r.url).pathname;
  } catch {
    // not absolute
  }
  if (apiPrefixes.some((p) => path.startsWith(p))) return "api";
  if (r.resourceType === "document") return "document";
  if (ASSET_RESOURCE_TYPES.has(r.resourceType)) return "asset";
  if (DEV_MODULE_PATH.test(path) || ASSET_EXTENSION.test(path)) return "asset";
  const type = r.contentType ?? "";
  if (r.resourceType === "xhr" || r.resourceType === "fetch" || r.resourceType === "eventsource") {
    if (ASSET_CONTENT_TYPE.test(type)) return "asset";
    // A data response — or no body type at all (a 204, a pending call) — from script is the API.
    return type === "" || DATA_CONTENT_TYPE.test(type) || !/html/i.test(type) ? "api" : "other";
  }
  return "other";
}

export interface RequestTiming {
  /** `METHOD /normalized/path` — the endpoint pattern (query dropped, ids collapsed). */
  readonly endpoint: string;
  /** api / document / asset / other (see `classifyRequest`). */
  readonly kind: RequestKind;
  /** The redacted URL (sensitive query values masked). */
  readonly url: string;
  readonly status: number | null;
  readonly durationMs: number;
}

export interface PageTiming {
  /** Normalized route of the page the timing belongs to. */
  readonly route: string;
  /** `navigation`: a new document loaded; `transition`: an action changed the page in place; `idle`: neither. */
  readonly kind: "navigation" | "transition" | "idle";
  readonly navigation?: NavigationTiming;
  /** Action-to-settled time (ms) for a transition. */
  readonly settleMs?: number;
  /** Whether the page settled within the ceiling. */
  readonly settled: boolean;
  readonly requests: {
    readonly count: number;
    /** Requests still pending when the page was read. */
    readonly pending: number;
    /** The slowest few requests in the window, slowest first. */
    readonly slowest: RequestTiming[];
    /**
     * Every request in the window, for the run's per-endpoint aggregation. Held in memory for the
     * summary only — transcript entries keep `count`/`pending`/`slowest` and drop this list.
     */
    readonly samples: RequestTiming[];
  };
  /** Largest Contentful Paint (ms from navigation start), where exposed. */
  readonly lcpMs?: number;
}

const SLOWEST = 3;

/** `METHOD /normalized/path` — the endpoint pattern a request is aggregated under. */
export function endpointOf(method: string, url: string): string {
  return `${method.toUpperCase()} ${normalizeRoute(redactUrl(url))}`;
}

function toRequestTiming(r: CompletedRequest | InflightRequest, now: number, apiPrefixes: readonly string[]): RequestTiming {
  const done = "durationMs" in r;
  return {
    endpoint: endpointOf(r.method, r.url),
    kind: classifyRequest({ url: r.url, resourceType: r.resourceType, contentType: done ? r.contentType : null }, apiPrefixes),
    url: redactUrl(r.url),
    status: done ? r.status : null,
    durationMs: done ? r.durationMs : Math.max(0, now - r.startedAt),
  };
}

interface PageSideTiming {
  readonly docId: string | null;
  readonly nav: NavigationTiming | null;
  readonly lcp: number | null;
}

/** BROWSER CODE — Navigation Timing + the monitor's document id and LCP. */
function readPageTiming(): PageSideTiming {
  const m = (window as unknown as { __jevitateMonitor?: { docId: string; lcp: number | null } }).__jevitateMonitor;
  const entry = performance.getEntriesByType("navigation")[0] as PerformanceNavigationTiming | undefined;
  const nav =
    entry === undefined
      ? null
      : {
          ttfbMs: Math.max(0, entry.responseStart - entry.startTime),
          domContentLoadedMs: Math.max(0, entry.domContentLoadedEventEnd - entry.startTime),
          loadMs: entry.loadEventEnd > 0 ? Math.max(0, entry.loadEventEnd - entry.startTime) : null,
        };
  return { docId: m?.docId ?? null, nav, lcp: m?.lcp ?? null };
}

/**
 * Builds one perception's timing. `lastDocId` is the document seen at the previous perception (a
 * different one ⇒ a navigation happened); `actionAt` is when the last action was dispatched in
 * this window (⇒ a transition); `settleEndedAt` is when the settle wait ended.
 */
export async function measurePageTiming(
  page: Page,
  window: {
    readonly completed: readonly CompletedRequest[];
    readonly pending: readonly InflightRequest[];
    readonly lastDocId: string | null;
    readonly actionAt: number | null;
    readonly settle: SettleResult;
    readonly settleEndedAt: number;
    readonly apiPrefixes?: readonly string[];
  },
): Promise<{ timing: PageTiming; docId: string | null }> {
  const apiPrefixes = window.apiPrefixes ?? [];
  const side = await page.evaluate(readPageTiming).catch((): PageSideTiming => ({ docId: null, nav: null, lcp: null }));
  const now = window.settleEndedAt;
  const all = [
    ...window.completed.map((r) => toRequestTiming(r, now, apiPrefixes)),
    ...window.pending.map((r) => toRequestTiming(r, now, apiPrefixes)),
  ];
  const slowest = [...all].sort((a, b) => b.durationMs - a.durationMs).slice(0, SLOWEST);
  const newDocument = side.docId !== null && side.docId !== window.lastDocId;
  const kind: PageTiming["kind"] = newDocument ? "navigation" : window.actionAt !== null ? "transition" : "idle";
  const timing: PageTiming = {
    route: normalizeRoute(redactUrl(page.url())),
    kind,
    ...(newDocument && side.nav !== null ? { navigation: side.nav } : {}),
    ...(window.actionAt !== null ? { settleMs: Math.max(0, window.settleEndedAt - window.actionAt) } : {}),
    settled: window.settle.settled,
    requests: {
      count: window.completed.length,
      pending: window.pending.length,
      slowest,
      samples: all,
    },
    ...(side.lcp !== null ? { lcpMs: side.lcp } : {}),
  };
  return { timing, docId: side.docId };
}

/**
 * The timing of a page that cannot be read (its main thread is not answering): only what the
 * Node-side monitor saw — no page API is called, since it would block too.
 */
export function unreadablePageTiming(
  url: string,
  completed: readonly CompletedRequest[],
  pending: readonly InflightRequest[],
  now: number,
): PageTiming {
  const all = [...completed.map((r) => toRequestTiming(r, now, [])), ...pending.map((r) => toRequestTiming(r, now, []))];
  return {
    route: normalizeRoute(redactUrl(url)),
    kind: "idle",
    settled: false,
    requests: {
      count: completed.length,
      pending: pending.length,
      slowest: [...all].sort((a, b) => b.durationMs - a.durationMs).slice(0, SLOWEST),
      samples: all,
    },
  };
}

// ---------- the per-run summary (pure) ----------

export interface TimingStat {
  readonly samples: number;
  readonly p50Ms: number;
  readonly maxMs: number;
}

export interface PageTimingStat extends TimingStat {
  /** `<kind> <route>` — e.g. `navigation /contacts/:id`, `transition /contacts/:id`. */
  readonly key: string;
  readonly route: string;
  readonly kind: "navigation" | "transition";
}

export interface EndpointTimingStat extends TimingStat {
  /** `METHOD /normalized/path`. */
  readonly endpoint: string;
  /** What the endpoint serves (api / document / asset / other). */
  readonly kind: RequestKind;
  /** Distinct statuses seen (null = still pending / failed). */
  readonly statuses: Array<number | null>;
}

/**
 * The per-run timing summary: machine-readable (keyed by normalized route and endpoint pattern, so
 * the same route compares across runs) plus the top-N slowest pages/transitions and endpoints.
 */
export interface TimingSummary {
  readonly pages: Readonly<Record<string, PageTimingStat>>;
  /** EVERY endpoint pattern seen, whatever its kind (the full data). */
  readonly endpoints: Readonly<Record<string, EndpointTimingStat>>;
  readonly slowestPages: PageTimingStat[];
  /** The slowest API endpoints only — never drowned out by assets or a dev server's modules. */
  readonly slowestEndpoints: EndpointTimingStat[];
  /** The slowest assets (scripts, styles, fonts, images, dev-server modules), separately. */
  readonly slowestAssets: EndpointTimingStat[];
}

/** Nearest-rank median of a non-empty list. */
export function p50(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const v = sorted[Math.max(0, Math.ceil(sorted.length / 2) - 1)];
  return v ?? 0;
}

function stat(values: readonly number[]): TimingStat {
  return { samples: values.length, p50Ms: p50(values), maxMs: Math.max(...values) };
}

/** The page-level duration a timing contributes: load (or DCL) for a navigation, settle for a transition. */
function pageDuration(t: PageTiming): { kind: "navigation" | "transition"; ms: number } | null {
  if (t.kind === "navigation" && t.navigation !== undefined) {
    return { kind: "navigation", ms: t.navigation.loadMs ?? t.navigation.domContentLoadedMs };
  }
  if (t.kind === "transition" && t.settleMs !== undefined) return { kind: "transition", ms: t.settleMs };
  return null;
}

export function summarizeTimings(timings: readonly (PageTiming | undefined)[], topN = 5): TimingSummary {
  const pageValues = new Map<string, { route: string; kind: "navigation" | "transition"; values: number[] }>();
  const endpointValues = new Map<string, { values: number[]; statuses: Set<number | null>; kind: RequestKind }>();
  for (const t of timings) {
    if (t === undefined) continue;
    const d = pageDuration(t);
    if (d !== null) {
      const key = `${d.kind} ${t.route}`;
      const cur = pageValues.get(key) ?? { route: t.route, kind: d.kind, values: [] };
      cur.values.push(d.ms);
      pageValues.set(key, cur);
    }
    for (const r of t.requests.samples) {
      const cur = endpointValues.get(r.endpoint) ?? { values: [], statuses: new Set<number | null>(), kind: r.kind };
      // A pattern seen as the API even once is the API (a data call can precede its content type).
      if (r.kind === "api") cur.kind = "api";
      cur.values.push(r.durationMs);
      cur.statuses.add(r.status);
      endpointValues.set(r.endpoint, cur);
    }
  }
  const pages: Record<string, PageTimingStat> = {};
  for (const [key, v] of pageValues) pages[key] = { key, route: v.route, kind: v.kind, ...stat(v.values) };
  const endpoints: Record<string, EndpointTimingStat> = {};
  for (const [endpoint, v] of endpointValues) {
    endpoints[endpoint] = { endpoint, kind: v.kind, ...stat(v.values), statuses: [...v.statuses] };
  }
  const byMax = <T extends TimingStat>(xs: T[]): T[] => xs.sort((a, b) => b.maxMs - a.maxMs || b.p50Ms - a.p50Ms).slice(0, topN);
  return {
    pages,
    endpoints,
    slowestPages: byMax(Object.values(pages)),
    slowestEndpoints: byMax(Object.values(endpoints).filter((e) => e.kind === "api")),
    slowestAssets: byMax(Object.values(endpoints).filter((e) => e.kind === "asset")),
  };
}
