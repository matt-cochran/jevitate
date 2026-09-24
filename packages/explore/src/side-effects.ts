import type { CapturedRequest, InflightRequest, PageMonitor, RequestCapture } from "./page-monitor.js";

/**
 * The repeated-side-effect guard (#92) — independent code, keyed on what the NETWORK saw, never on
 * what the model says.
 *
 * Dogfood evidence (Preveti J7, 2026-09-24): the loop clicked "Run the simulation →" (a paid job),
 * waited 3s while the page said "Simulating…", reloaded, and clicked it again — a duplicate paid job.
 *
 * Rule: once a click has fired a WRITE request (POST/PUT/PATCH/DELETE seen by the page monitor after
 * the click), the same control is not clicked again on the same route while
 *  - that write is still in flight (the loop waits for it to resolve instead), or
 *  - it went through (a response below 400, or an outcome unknown because the page navigated away
 *    from it — the server may well have run it),
 * unless the page shows the action can be retried (a visible "Retry"/"Try again" control, or an
 * error alert) or every write it fired was rejected (4xx/5xx, or failed without a response).
 * Changing an input (typing, selecting, toggling) makes a new request, so it clears the guard.
 */

/** The request methods that change server state. */
export const WRITE_METHODS: ReadonlySet<string> = new Set(["POST", "PUT", "PATCH", "DELETE"]);

/** A control on the page that offers to retry. */
const RETRY_NAME = /\b(retry|try again|resubmit|re-run|rerun)\b/i;
/** An alert that says the last attempt failed. */
const FAILURE_ALERT = /\b(error|failed|failure|could not|couldn't|unable to|went wrong|try again)\b/i;

/** One write a click fired: finished (with its outcome) or still in flight. */
export interface FiredWrite {
  readonly method: string;
  readonly path: string;
  /** The response status; null when still in flight or it ended without a response. */
  readonly status: number | null;
  /** Rejected by the server (>= 400) or failed without a response. */
  readonly rejected: boolean;
}

interface Fired {
  readonly label: string;
  readonly route: string;
  readonly writes: FiredWrite[];
  /** The writes that were still in flight when the click's window closed (identity-tracked). */
  readonly inflight: InflightRequest[];
}

interface Open {
  readonly key: string;
  readonly label: string;
  readonly route: string;
  readonly at: number;
  readonly capture: RequestCapture;
}

/** Whether the most recently closed click sent any request (#130a). */
export interface LastClick {
  readonly requestSent: boolean;
}

/** What the guard says about a proposed click. */
export type RepeatVerdict =
  | { readonly refuse: false }
  | {
      readonly refuse: true;
      /** The transcript/history reason. */
      readonly reason: string;
      /** True when the click's write is still in flight — the loop should wait for it. */
      readonly inflight: boolean;
    };

const describeWrite = (w: FiredWrite): string => `${w.method} ${w.path}${w.status === null ? "" : ` → ${w.status}`}`;

export class SideEffectGuard {
  readonly #monitor: PageMonitor;
  readonly #fired = new Map<string, Fired>();
  #open: Open | null = null;
  /** Whether the most recently CLOSED click sent any request at all (#130a). */
  #lastClick: LastClick | null = null;

  constructor(monitor: PageMonitor) {
    this.#monitor = monitor;
  }

  /** A click on `key` is about to be dispatched: watch what it sends. */
  beginClick(key: string, label: string, route: string, at: number): void {
    this.#closeOpen();
    this.#open = { key, label, route, at, capture: this.#monitor.startCapture() };
  }

  /**
   * The click's window closes (the next perception has settled the page): the writes it fired are
   * the ones that finished since, plus those still in flight that started after it.
   */
  settle(): void {
    this.#closeOpen();
  }

  /**
   * The most recently closed click (#130a): did it send ANY request (of any method), by the time its
   * window closed? Null before any click has closed.
   */
  lastClick(): LastClick | null {
    return this.#lastClick;
  }

  #closeOpen(): void {
    const o = this.#open;
    if (o === null) return;
    this.#open = null;
    this.#monitor.stopCapture(o.capture);
    const requests = o.capture.requests();
    const inflightAny = this.#monitor.pending().some((r) => r.startedAt >= o.at);
    this.#lastClick = { requestSent: requests.length > 0 || inflightAny };
    const done: FiredWrite[] = requests
      .filter((r: CapturedRequest) => WRITE_METHODS.has(r.method.toUpperCase()))
      .map((r) => ({
        method: r.method.toUpperCase(),
        path: r.path,
        status: r.status,
        rejected: (r.status !== null && r.status >= 400) || (r.status === null && r.failed),
      }));
    const inflight = this.#monitor
      .pending()
      .filter((r) => r.startedAt >= o.at && WRITE_METHODS.has(r.method.toUpperCase()));
    const pending: FiredWrite[] = inflight.map((r) => ({ method: r.method.toUpperCase(), path: pathOf(r.url), status: null, rejected: false }));
    if (done.length + pending.length === 0) return;
    this.#fired.set(o.key, { label: o.label, route: o.route, writes: [...done, ...pending], inflight });
  }

  /** Writes fired by this run's clicks that are still in flight now. */
  inflight(): FiredWrite[] {
    const live = new Set(this.#monitor.pending());
    const out: FiredWrite[] = [];
    for (const f of this.#fired.values()) {
      for (const r of f.inflight) {
        if (live.has(r)) out.push({ method: r.method.toUpperCase(), path: pathOf(r.url), status: null, rejected: false });
      }
    }
    return out;
  }

  /** An input changed (typed, selected, toggled, uploaded): a repeat now sends something new. */
  inputChanged(): void {
    this.#fired.clear();
  }

  /**
   * May `key` be clicked on `route` now? `page` is what the page shows: its control names and alerts
   * (a visible retry affordance, or an error alert, re-allows it).
   */
  check(key: string, route: string, page: { readonly controlNames: readonly string[]; readonly alerts: readonly string[] }): RepeatVerdict {
    const f = this.#fired.get(key);
    if (f === undefined || f.route !== route) return { refuse: false };
    const live = new Set(this.#monitor.pending());
    const stillInFlight = f.inflight.filter((r) => live.has(r));
    const what = f.writes.map(describeWrite).join(", ");
    if (stillInFlight.length > 0) {
      const w = stillInFlight.map((r) => `${r.method.toUpperCase()} ${pathOf(r.url)}`).join(", ");
      return {
        refuse: true,
        inflight: true,
        reason: `repeated side effect refused: "${f.label}" already sent ${w}, still in flight — waiting for it instead of re-clicking`,
      };
    }
    // Every write it fired was rejected: the side effect did not land, so trying again is fair.
    if (f.writes.every((w) => w.rejected)) return { refuse: false };
    const retryOffered =
      page.controlNames.some((n) => RETRY_NAME.test(n)) || page.alerts.some((a) => FAILURE_ALERT.test(a));
    if (retryOffered) return { refuse: false };
    return {
      refuse: true,
      inflight: false,
      reason: `repeated side effect refused: "${f.label}" already sent ${what} on this page and the page does not offer a retry — clicking it again would repeat that action`,
    };
  }
}

function pathOf(url: string): string {
  try {
    return new URL(url).pathname;
  } catch {
    return url.split(/[?#]/)[0] ?? url;
  }
}

/**
 * Waits (bounded) until none of the given in-flight requests is pending any more, then for the page
 * to settle — the "observe until idle" answer to a write still in flight, instead of reload + retry.
 * Returns how long it waited and whether the writes resolved within `ceilingMs`.
 */
export async function awaitWrites(
  monitor: PageMonitor,
  guard: SideEffectGuard,
  ceilingMs: number,
  pollMs = 250,
): Promise<{ resolved: boolean; waitedMs: number }> {
  const started = Date.now();
  const remaining = (): number => ceilingMs - (Date.now() - started);
  while (guard.inflight().length > 0) {
    if (remaining() <= 0) return { resolved: false, waitedMs: Date.now() - started };
    await new Promise((r) => setTimeout(r, Math.max(1, Math.min(pollMs, remaining()))));
  }
  if (remaining() > 0) await monitor.waitSettled({ ceilingMs: Math.min(remaining(), 15_000) }).catch(() => undefined);
  return { resolved: true, waitedMs: Date.now() - started };
}
