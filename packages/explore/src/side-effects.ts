import { createHash } from "node:crypto";
import { writeClassifier, type WriteClassifier } from "@jevitate/recording";
import { requestEndpoint } from "./authorized-targets.js";
import { FirstPartyOrigins } from "./third-party.js";
import type { CapturedRequest, InflightRequest, PageMonitor, RequestCapture } from "./page-monitor.js";
import type { ControlRisk } from "./safety.js";

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
 * A write is classified by `writeClassifier` (#110): a gRPC-web/Connect read (`POST /pkg.Svc/GetX`)
 * is a read, never a guarded side effect.
 * Changing an input makes a new request, so it lifts the guard — but only when the submitted VALUES
 * differ from those at the earlier click (#123): re-typing identical values is not a change.
 * A sign-in control ("Log in") is never guarded (repeating a sign-in creates nothing), and a
 * back / start-over click ("Back to sign in") abandons the flow on its route, lifting the guard for
 * the controls clicked there (#110).
 */

/** The request methods that change server state. */
export const WRITE_METHODS: ReadonlySet<string> = new Set(["POST", "PUT", "PATCH", "DELETE"]);

/** A control on the page that offers to retry. */
const RETRY_NAME = /\b(retry|try again|resubmit|re-run|rerun)\b/i;
/** An alert that says the last attempt failed. */
const FAILURE_ALERT = /\b(error|failed|failure|could not|couldn't|unable to|went wrong|try again)\b/i;
/** A sign-in submit: repeating it creates nothing, so it is never refused as a repeat (#110). */
const SIGN_IN_NAME = /^\W*(?:log ?in|sign ?in|verify|submit code)\b/i;
/** A control that abandons the current flow and returns to its start (#110). */
const BACK_NAME = /^\W*(?:back|go back|start over|start again|use (?:a )?different|change (?:email|account|number))\b|^\s*←/i;

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
  /** The input values in effect when it was clicked (`#valuesKey`). */
  readonly values: string;
}

interface Open {
  readonly key: string;
  readonly label: string;
  readonly route: string;
  readonly at: number;
  readonly capture: RequestCapture;
  readonly values: string;
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

/** A value digest: a typed secret never sits in the guard's memory in clear. */
const digest = (v: string): string => createHash("sha256").update(v).digest("hex").slice(0, 16);

export class SideEffectGuard {
  readonly #monitor: PageMonitor;
  readonly #isWrite: WriteClassifier;
  readonly #fired = new Map<string, Fired>();
  /** The value each input holds now (field key → value digest), as this run set it. */
  readonly #values = new Map<string, string>();
  /** Bumped by an input change whose resulting value is unknown (an upload, a radio…). */
  #generation = 0;
  #open: Open | null = null;
  /** Whether the most recently CLOSED click sent any request at all (#130a). */
  #lastClick: LastClick | null = null;

  /** The run's authorized origins: an off-origin write is named origin + path (#194). */
  readonly #origins: readonly string[];

  constructor(monitor: PageMonitor, opts: { readonly isWrite?: WriteClassifier; readonly allowlist?: readonly string[] } = {}) {
    this.#monitor = monitor;
    this.#isWrite = opts.isWrite ?? writeClassifier();
    this.#origins = opts.allowlist ?? [];
  }

  /** How a request is named (#194): path on an allowed origin, else origin + path. */
  #name(url: string): string {
    return this.#origins.length === 0 ? pathOf(url) : requestEndpoint(url, this.#origins);
  }

  #valuesKey(): string {
    return JSON.stringify([this.#generation, [...this.#values.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))]);
  }

  #write(r: { readonly method: string; readonly path: string; readonly requestContentType?: string }): boolean {
    return this.#isWrite({ method: r.method, path: r.path, contentType: r.requestContentType ?? null });
  }

  /** A click on `key` is about to be dispatched: watch what it sends. */
  beginClick(key: string, label: string, route: string, at: number): void {
    this.#closeOpen();
    // A back / start-over control abandons the flow on this route: its earlier submits may be redone.
    if (BACK_NAME.test(label)) {
      for (const [k, f] of this.#fired) if (f.route === route) this.#fired.delete(k);
    }
    this.#open = { key, label, route, at, capture: this.#monitor.startCapture(), values: this.#valuesKey() };
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
    // #130a: ANY request counts here (a read proves the click did something) — never just a write.
    const inflightAny = this.#monitor.pending().some((r) => r.startedAt >= o.at);
    this.#lastClick = { requestSent: requests.length > 0 || inflightAny };
    const done: FiredWrite[] = requests
      .filter((r: CapturedRequest) => this.#write(r))
      .map((r) => ({
        method: r.method.toUpperCase(),
        path: this.#name(r.url),
        status: r.status,
        rejected: (r.status !== null && r.status >= 400) || (r.status === null && r.failed),
      }));
    const inflight = this.#monitor.pending().filter((r) => r.startedAt >= o.at && this.#write({ ...r, path: pathOf(r.url) }));
    const pending: FiredWrite[] = inflight.map((r) => ({ method: r.method.toUpperCase(), path: this.#name(r.url), status: null, rejected: false }));
    if (done.length + pending.length === 0) return;
    this.#fired.set(o.key, { label: o.label, route: o.route, writes: [...done, ...pending], inflight, values: o.values });
  }

  /** Writes fired by this run's clicks that are still in flight now. */
  inflight(): FiredWrite[] {
    const live = new Set(this.#monitor.pending());
    const out: FiredWrite[] = [];
    for (const f of this.#fired.values()) {
      for (const r of f.inflight) {
        if (live.has(r)) out.push({ method: r.method.toUpperCase(), path: this.#name(r.url), status: null, rejected: false });
      }
    }
    return out;
  }

  /**
   * An input changed. With `field` and `value` (typed, selected), the guard remembers the value: a
   * repeat is allowed only when the values differ from those at the earlier click (#123) — typing the
   * same values again is not a change. `{ toggled: true }` flips a checkbox-like field; without a
   * field (an upload, a radio) the change is taken as new.
   */
  inputChanged(field?: string, value?: string | { readonly toggled: true }): void {
    if (field === undefined || value === undefined) {
      this.#generation += 1;
      return;
    }
    if (typeof value === "string") {
      this.#values.set(field, digest(value));
      return;
    }
    const was = this.#values.get(field);
    if (was === "toggled") this.#values.delete(field);
    else if (was === undefined) this.#values.set(field, "toggled");
    else this.#generation += 1;
  }

  /**
   * May `key` be clicked on `route` now? `page` is what the page shows: its control names and alerts
   * (a visible retry affordance, or an error alert, re-allows it).
   */
  check(key: string, route: string, page: { readonly controlNames: readonly string[]; readonly alerts: readonly string[] }): RepeatVerdict {
    const f = this.#fired.get(key);
    if (f === undefined || f.route !== route) return { refuse: false };
    // Repeating a sign-in creates nothing (a retry after "Back to sign in", a 2FA restart).
    if (SIGN_IN_NAME.test(f.label)) return { refuse: false };
    const live = new Set(this.#monitor.pending());
    const stillInFlight = f.inflight.filter((r) => live.has(r));
    const what = f.writes.map(describeWrite).join(", ");
    if (stillInFlight.length > 0) {
      const w = stillInFlight.map((r) => `${r.method.toUpperCase()} ${this.#name(r.url)}`).join(", ");
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
    // The inputs now hold different values: the repeat sends something new.
    if (f.values !== this.#valuesKey()) return { refuse: false };
    const retyped = this.#values.size > 0 ? " (the inputs hold the same values as when it was sent — nothing new would be submitted)" : "";
    return {
      refuse: true,
      inflight: false,
      reason: `repeated side effect refused: "${f.label}" already sent ${what} on this page and the page does not offer a retry — clicking it again would repeat that action${retyped}`,
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

/** One write a run's action fired (#116: the result's `sideEffects`). */
export interface SideEffect {
  /** The transcript step of the action that fired it. */
  readonly step: number;
  /** The control acted on (its accessible name), or the op when there was no control. */
  readonly control: string;
  readonly request: {
    readonly method: string;
    /**
     * The request path (no query — never a value); origin + path when the origin is not one of the
     * run's allowed origins (#194: `https://m.stripe.com/6`, never a bare `/6`).
     */
    readonly endpoint: string;
    /** The response status; null when it was still in flight or ended without a response. */
    readonly status: number | null;
  };
  /** Set when the control is a paid / destructive / session-ending one (see `SafetyPolicy`). */
  readonly risk?: Exclude<ControlRisk, "denied">;
  /**
   * The app's own write, fired after the last action's window closed (a token refresh, heartbeat,
   * telemetry) — not caused by an action (#158: a read-only run lets these through). `control` is
   * the action it followed.
   */
  readonly background?: true;
  /**
   * The request went to a THIRD-PARTY origin (#194, decided by code — `FirstPartyOrigins`: off the
   * run's allowed origins and their sites, with no API credentials, to an origin the page never
   * sent a credentialed request to), e.g. Stripe.js's fraud beacon
   * `https://m.stripe.com/6`, analytics, telemetry. Recorded for the record, but not the mission's
   * write: the read-only guard never blocks it. `step`/`control` still say which action it followed.
   */
  readonly thirdParty?: true;
}

/** Most side effects a result lists (the rest are counted, never silently dropped). */
export const MAX_SIDE_EFFECTS = 200;

interface Mark {
  readonly at: number;
  readonly step: number;
  readonly control: string;
  readonly risk: Exclude<ControlRisk, "denied"> | null;
  readonly background?: true;
}

/**
 * Records the writes a run's actions fired (#116), attributing each to the latest action that began
 * before the request started. Reads (by the shared write classifier, #110) are never listed.
 * Survives a session reset: `attach` a new page's monitor and the old captures are kept.
 */
export class SideEffectLog {
  readonly #isWrite: WriteClassifier;
  readonly #now: () => number;
  readonly #sources: Array<{ readonly monitor: PageMonitor; readonly capture: RequestCapture }> = [];
  readonly #marks: Mark[] = [];
  /** The run's authorized origins (#194); empty = every request is first-party, named by path. */
  readonly #origins: readonly string[];
  /** Which origins are the app's (#194) — fed every request's headers by the run. */
  readonly #firstParty: FirstPartyOrigins;

  constructor(
    opts: {
      readonly isWrite?: WriteClassifier;
      readonly now?: () => number;
      readonly allowlist?: readonly string[];
      readonly firstParty?: FirstPartyOrigins;
    } = {},
  ) {
    this.#isWrite = opts.isWrite ?? writeClassifier();
    this.#now = opts.now ?? Date.now;
    this.#origins = opts.allowlist ?? [];
    this.#firstParty = opts.firstParty ?? new FirstPartyOrigins(this.#origins);
  }

  /** Starts capturing on a page's monitor (call again after a session reset). */
  attach(monitor: PageMonitor): void {
    if (this.#sources.some((s) => s.monitor === monitor)) return;
    this.#sources.push({ monitor, capture: monitor.startCapture() });
  }

  /** An action on `control` (step `step`) is about to be dispatched. */
  mark(step: number, control: string, risk: Exclude<ControlRisk, "denied"> | null = null): void {
    this.#marks.push({ at: this.#now(), step, control: control.replace(/\s+/g, " ").trim().slice(0, 120), risk });
  }

  /**
   * The last action's window closed: writes from now until the next `mark` are the app's own
   * (`background`), still attributed to the step they followed.
   */
  markBackground(): void {
    const last = this.#marks[this.#marks.length - 1];
    this.#marks.push({ at: this.#now(), step: last?.step ?? 0, control: last?.control ?? "(page load)", risk: null, background: true });
  }

  #owner(startedAt: number | undefined): Mark | undefined {
    if (startedAt === undefined) return this.#marks[this.#marks.length - 1];
    let owner: Mark | undefined;
    for (const m of this.#marks) if (m.at <= startedAt) owner = m;
    return owner;
  }

  /** The writes fired so far (finished and still in flight), in start order. */
  entries(): { readonly sideEffects: SideEffect[]; readonly truncated: number } {
    const out: Array<SideEffect & { readonly at: number }> = [];
    const push = (m: Mark, method: string, url: string, status: number | null, at: number): void => {
      const thirdParty = this.#firstParty.thirdParty(url) !== null;
      out.push({
        at,
        step: m.step,
        control: m.control,
        request: { method: method.toUpperCase(), endpoint: this.#origins.length === 0 ? pathOf(url) : requestEndpoint(url, this.#origins), status },
        ...(m.risk === null ? {} : { risk: m.risk }),
        ...(m.background === true ? { background: true as const } : {}),
        ...(thirdParty ? { thirdParty: true as const } : {}),
      });
    };
    for (const { monitor, capture } of this.#sources) {
      for (const r of capture.requests()) {
        if (!this.#isWrite({ method: r.method, path: r.path, contentType: r.requestContentType ?? null })) continue;
        const m = this.#owner(r.startedAt);
        if (m !== undefined) push(m, r.method, r.url, r.status, r.startedAt ?? m.at);
      }
      for (const r of monitor.pending()) {
        const path = pathOf(r.url);
        if (!this.#isWrite({ method: r.method, path, contentType: r.requestContentType ?? null })) continue;
        const m = this.#owner(r.startedAt);
        if (m !== undefined) push(m, r.method, r.url, null, r.startedAt);
      }
    }
    out.sort((a, b) => a.at - b.at);
    const listed = out.slice(0, MAX_SIDE_EFFECTS).map(({ at: _at, ...e }) => e);
    return { sideEffects: listed, truncated: Math.max(0, out.length - MAX_SIDE_EFFECTS) };
  }

  /** Stops capturing (what was captured is kept). */
  close(): void {
    for (const { monitor, capture } of this.#sources) monitor.stopCapture(capture);
  }
}
