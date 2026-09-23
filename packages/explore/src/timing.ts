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

export interface RequestTiming {
  /** `METHOD /normalized/path` — the endpoint pattern (query dropped, ids collapsed). */
  readonly endpoint: string;
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
    /** Every request in the window (capped), for per-endpoint aggregation. */
    readonly samples: RequestTiming[];
  };
  /** Largest Contentful Paint (ms from navigation start), where exposed. */
  readonly lcpMs?: number;
}

const MAX_SAMPLES = 100;
const SLOWEST = 3;

/** `METHOD /normalized/path` — the endpoint pattern a request is aggregated under. */
export function endpointOf(method: string, url: string): string {
  return `${method.toUpperCase()} ${normalizeRoute(redactUrl(url))}`;
}

function toRequestTiming(r: CompletedRequest | InflightRequest, now: number): RequestTiming {
  const done = "durationMs" in r;
  return {
    endpoint: endpointOf(r.method, r.url),
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
  },
): Promise<{ timing: PageTiming; docId: string | null }> {
  const side = await page.evaluate(readPageTiming).catch((): PageSideTiming => ({ docId: null, nav: null, lcp: null }));
  const now = window.settleEndedAt;
  const all = [
    ...window.completed.map((r) => toRequestTiming(r, now)),
    ...window.pending.map((r) => toRequestTiming(r, now)),
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
      samples: all.slice(0, MAX_SAMPLES),
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
  const all = [...completed.map((r) => toRequestTiming(r, now)), ...pending.map((r) => toRequestTiming(r, now))];
  return {
    route: normalizeRoute(redactUrl(url)),
    kind: "idle",
    settled: false,
    requests: {
      count: completed.length,
      pending: pending.length,
      slowest: [...all].sort((a, b) => b.durationMs - a.durationMs).slice(0, SLOWEST),
      samples: all.slice(0, MAX_SAMPLES),
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
  /** Distinct statuses seen (null = still pending / failed). */
  readonly statuses: Array<number | null>;
}

/**
 * The per-run timing summary: machine-readable (keyed by normalized route and endpoint pattern, so
 * the same route compares across runs) plus the top-N slowest pages/transitions and endpoints.
 */
export interface TimingSummary {
  readonly pages: Readonly<Record<string, PageTimingStat>>;
  readonly endpoints: Readonly<Record<string, EndpointTimingStat>>;
  readonly slowestPages: PageTimingStat[];
  readonly slowestEndpoints: EndpointTimingStat[];
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
  const endpointValues = new Map<string, { values: number[]; statuses: Set<number | null> }>();
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
      const cur = endpointValues.get(r.endpoint) ?? { values: [], statuses: new Set<number | null>() };
      cur.values.push(r.durationMs);
      cur.statuses.add(r.status);
      endpointValues.set(r.endpoint, cur);
    }
  }
  const pages: Record<string, PageTimingStat> = {};
  for (const [key, v] of pageValues) pages[key] = { key, route: v.route, kind: v.kind, ...stat(v.values) };
  const endpoints: Record<string, EndpointTimingStat> = {};
  for (const [endpoint, v] of endpointValues) {
    endpoints[endpoint] = { endpoint, ...stat(v.values), statuses: [...v.statuses] };
  }
  const byMax = <T extends TimingStat>(xs: T[]): T[] => xs.sort((a, b) => b.maxMs - a.maxMs || b.p50Ms - a.p50Ms).slice(0, topN);
  return {
    pages,
    endpoints,
    slowestPages: byMax(Object.values(pages)),
    slowestEndpoints: byMax(Object.values(endpoints)),
  };
}
