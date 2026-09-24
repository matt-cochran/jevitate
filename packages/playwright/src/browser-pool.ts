import { availableParallelism } from "node:os";
import { setTimeout as sleep } from "node:timers/promises";
import type { CpuMetric, MemMetric, ResourceSample, ResourceSignals } from "./resource-signals.js";

/**
 * One browser process, many isolated contexts — with admission control.
 *
 * Every session is a fresh browser CONTEXT (own cookies, storage, tracing) on a
 * browser process shared per launch configuration; tabs are never the unit
 * (tabs share cookies and would break isolation and replay determinism).
 *
 * Admission control throttles NEW work only — a running context is never
 * killed. Before a context is created the pool (1) takes one of `maxContexts`
 * slots and (2) samples host `ResourceSignals` and waits, with backoff, while
 * any signal is over its threshold. Both waits share one bounded deadline; on
 * expiry acquisition fails fast with an error naming the violated signal and
 * its source. Slots are released in `finally` paths, so a throwing body can
 * never leak one — and a context close that never settles (a hung page) is
 * bounded by `closeTimeoutMs`, after which the slot is freed anyway.
 *
 * A browser that disconnects without the pool closing it is a CRASH: every live
 * lease on it is failed loudly with `BrowserCrashedError`, and the next acquire
 * relaunches lazily. There is no silent retry of the crashed work.
 */

/** The slice of a Playwright `Browser` the pool needs; a real `Browser` satisfies it. */
export interface PooledBrowser<C, O> {
  newContext(options: O): Promise<C>;
  close(): Promise<void>;
  on(event: "disconnected", listener: () => void): unknown;
}

/** The slice of a Playwright `BrowserContext` the pool needs. */
export interface PooledContext {
  close(): Promise<void>;
}

/** Per-metric "block admission while value > threshold" limits (percentages). */
export type PressureThresholds = Readonly<Record<CpuMetric | MemMetric, number>>;

/**
 * Defaults, one per signal meaning (see `CpuMetric` / `MemMetric`). Only signals that measure a
 * genuine STALL block admission by default; the rest are recorded in every admission sample but
 * are advisory (limit = Infinity) unless a caller sets an explicit threshold:
 *  - psi-cpu-some-avg10 > 80%: most of the last 10s something waited for CPU (a real stall measure).
 *  - psi-memory-full-avg10 > 5%: ALL tasks stalled on memory 5% of the time — thrashing.
 *  - vm-pressure-level > 50: macOS at CRITICAL (warn=50 still admits).
 *  - loadavg1-per-core: ADVISORY. Load average counts runnable tasks, not stalls; a healthy busy
 *    runner routinely sits at ~2x cores (GitHub macOS runners read ~194% while working normally —
 *    a 200% limit starved the pool for >2 minutes there). Set a threshold explicitly to enforce it.
 *  - cpu-busy-delta: ADVISORY for the same reason (Windows cores at 100% busy is not a stall).
 * Memory exhaustion — what actually crashes/deadlocks browsers — is always enforced via the
 * memory metric above and the free-memory floor.
 */
export const DEFAULT_PRESSURE_THRESHOLDS: PressureThresholds = Object.freeze({
  "psi-cpu-some-avg10": 80,
  "loadavg1-per-core": Number.POSITIVE_INFINITY,
  "cpu-busy-delta": Number.POSITIVE_INFINITY,
  "psi-memory-full-avg10": 5,
  "vm-pressure-level": 50,
});

/** Memory budget one browser context is assumed to need; also the free-memory admission floor. */
export const DEFAULT_CONTEXT_MEMORY_BYTES = 400 * 1024 * 1024;
export const DEFAULT_ADMISSION_TIMEOUT_MS = 5 * 60 * 1000;
/** Bound on one context close; past it the slot is freed and the stuck close is reported. */
export const DEFAULT_CLOSE_TIMEOUT_MS = 10_000;

export interface BrowserPoolOptions {
  readonly signals: ResourceSignals;
  /** Concurrent context cap. Default `max(1, min(floor(cores/2), floor(memAvailable / contextMemoryBytes)))`. */
  readonly maxContexts?: number;
  readonly thresholds?: Partial<PressureThresholds>;
  /** Assumed memory per context; admission also requires at least this much available. */
  readonly contextMemoryBytes?: number;
  /** Bound on the total admission wait (slot + pressure). */
  readonly admissionTimeoutMs?: number;
  readonly backoffInitialMs?: number;
  readonly backoffMaxMs?: number;
  /** Close a browser this long after its last context is released (keeps a CLI from hanging). */
  readonly idleCloseMs?: number;
  /**
   * Bound on `release()`'s context close. A hung page can keep `close()` from ever settling; the
   * slot is freed after this long regardless (a process warning names the stuck close), so one
   * hung context can never drain the pool.
   */
  readonly closeTimeoutMs?: number;
  readonly availableParallelism?: () => number;
  readonly now?: () => number;
  readonly sleep?: (ms: number) => Promise<unknown>;
}

/** What admission cost and saw — recorded into run metadata. */
export interface AdmissionRecord {
  readonly waitedMs: number;
  readonly maxContexts: number;
  readonly sample: ResourceSample;
}

export class AdmissionTimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AdmissionTimeoutError";
  }
}

export class BrowserCrashedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BrowserCrashedError";
  }
}

export interface ContextLease<C> {
  readonly context: C;
  readonly admission: AdmissionRecord;
  /** Set once the lease's browser crashed; every later use of the lease should surface it. */
  readonly crash: BrowserCrashedError | undefined;
  /** Closes the context and frees the slot. Rejects with the crash error if the browser crashed. */
  release(): Promise<void>;
}

const METRIC_LABEL: Readonly<Record<CpuMetric | MemMetric, string>> = {
  "psi-cpu-some-avg10": "cpu pressure some avg10",
  "loadavg1-per-core": "cpu load1 per core",
  "cpu-busy-delta": "cpu busy",
  "psi-memory-full-avg10": "memory pressure full avg10",
  "vm-pressure-level": "memory pressure vm level",
};

const fmt = (n: number): string => (Number.isInteger(n) ? String(n) : n.toFixed(2));
const mib = (n: number): string => `${Math.round(n / (1024 * 1024))}MiB`;

/** The first signal over its limit, described for humans; undefined = admit. */
export function admissionViolation(
  sample: ResourceSample,
  thresholds: PressureThresholds,
  minMemAvailableBytes: number,
): string | undefined {
  if (sample.memPressure !== undefined && sample.memMetric !== undefined) {
    const limit = thresholds[sample.memMetric];
    if (sample.memPressure > limit) {
      return `${METRIC_LABEL[sample.memMetric]}=${fmt(sample.memPressure)}% > ${fmt(limit)}% (source=${sample.source})`;
    }
  }
  if (sample.memAvailableBytes < minMemAvailableBytes) {
    return `memory available=${mib(sample.memAvailableBytes)} < ${mib(minMemAvailableBytes)} (source=${sample.source})`;
  }
  if (sample.cpuPressure !== undefined && sample.cpuMetric !== undefined) {
    const limit = thresholds[sample.cpuMetric];
    if (sample.cpuPressure > limit) {
      return `${METRIC_LABEL[sample.cpuMetric]}=${fmt(sample.cpuPressure)}% > ${fmt(limit)}% (source=${sample.source})`;
    }
  }
  return undefined;
}

/** The default cap: half the cores, bounded by how many context budgets fit in available memory. */
export function defaultMaxContexts(cores: number, memAvailableBytes: number, contextMemoryBytes: number): number {
  return Math.max(1, Math.min(Math.floor(cores / 2), Math.floor(memAvailableBytes / contextMemoryBytes)));
}

interface BrowserEntry<C, O> {
  readonly browser: Promise<PooledBrowser<C, O>>;
  readonly leases: Set<LeaseState<C>>;
  closing: boolean;
  idleTimer: ReturnType<typeof setTimeout> | undefined;
}

interface LeaseState<C> {
  crash: BrowserCrashedError | undefined;
  context: C | undefined;
}

export class BrowserPool<C extends PooledContext, O> {
  readonly #signals: ResourceSignals;
  readonly #thresholds: PressureThresholds;
  readonly #contextMemoryBytes: number;
  readonly #timeoutMs: number;
  readonly #backoffInitialMs: number;
  readonly #backoffMaxMs: number;
  readonly #idleCloseMs: number;
  readonly #closeTimeoutMs: number;
  readonly #cores: () => number;
  readonly #now: () => number;
  readonly #sleep: (ms: number) => Promise<unknown>;
  #maxContexts: number | undefined;
  #inUse = 0;
  readonly #slotWaiters: (() => void)[] = [];
  readonly #browsers = new Map<string, BrowserEntry<C, O>>();

  constructor(opts: BrowserPoolOptions) {
    if (opts.maxContexts !== undefined && (!Number.isInteger(opts.maxContexts) || opts.maxContexts < 1)) {
      throw new RangeError(`maxContexts must be a positive integer, got ${opts.maxContexts}`);
    }
    this.#signals = opts.signals;
    this.#thresholds = { ...DEFAULT_PRESSURE_THRESHOLDS, ...opts.thresholds };
    this.#contextMemoryBytes = opts.contextMemoryBytes ?? DEFAULT_CONTEXT_MEMORY_BYTES;
    this.#timeoutMs = opts.admissionTimeoutMs ?? DEFAULT_ADMISSION_TIMEOUT_MS;
    this.#backoffInitialMs = opts.backoffInitialMs ?? 250;
    this.#backoffMaxMs = opts.backoffMaxMs ?? 5_000;
    this.#idleCloseMs = opts.idleCloseMs ?? 1_000;
    this.#closeTimeoutMs = opts.closeTimeoutMs ?? DEFAULT_CLOSE_TIMEOUT_MS;
    this.#cores = opts.availableParallelism ?? availableParallelism;
    this.#now = opts.now ?? Date.now;
    this.#sleep = opts.sleep ?? ((ms) => sleep(ms));
    this.#maxContexts = opts.maxContexts;
  }

  /** Contexts currently holding a slot (for tests and diagnostics). */
  get inUse(): number {
    return this.#inUse;
  }

  /** The effective cap, once known (resolved from the first sample when not configured). */
  get maxContexts(): number | undefined {
    return this.#maxContexts;
  }

  /**
   * Admits and creates one context on the browser for `launchKey`, launching it
   * lazily via `launch`. Callers MUST `release()` the lease (use `withContext`
   * to get that in a `finally` for free).
   */
  async acquire(launchKey: string, launch: () => Promise<PooledBrowser<C, O>>, options: O): Promise<ContextLease<C>> {
    const started = this.#now();
    const deadline = started + this.#timeoutMs;
    const sample = await this.#admit(deadline);
    const maxContexts = sample.maxContexts;
    let entry: BrowserEntry<C, O> | undefined;
    const state: LeaseState<C> = { crash: undefined, context: undefined };
    try {
      entry = this.#entryFor(launchKey, launch);
      if (entry.idleTimer !== undefined) {
        clearTimeout(entry.idleTimer);
        entry.idleTimer = undefined;
      }
      entry.leases.add(state);
      const browser = await entry.browser;
      state.context = await browser.newContext(options);
    } catch (err) {
      if (entry !== undefined) this.#detach(launchKey, entry, state);
      this.#freeSlot();
      throw err;
    }
    const context = state.context;
    const admission: AdmissionRecord = { waitedMs: this.#now() - started, maxContexts, sample: sample.sample };
    let released = false;
    const owner = entry;
    return {
      context,
      admission,
      get crash() {
        return state.crash;
      },
      release: async () => {
        if (released) return;
        released = true;
        try {
          if (state.crash === undefined) await this.#boundedClose(context, launchKey);
        } finally {
          this.#detach(launchKey, owner, state);
          this.#freeSlot();
        }
        if (state.crash !== undefined) throw state.crash;
      },
    };
  }

  /** `acquire` + `body` + `release` in `finally` — a throwing body can never leak the slot. */
  async withContext<T>(
    launchKey: string,
    launch: () => Promise<PooledBrowser<C, O>>,
    options: O,
    body: (lease: ContextLease<C>) => Promise<T>,
  ): Promise<T> {
    const lease = await this.acquire(launchKey, launch, options);
    try {
      return await body(lease);
    } finally {
      await lease.release();
    }
  }

  /** Closes every browser now (live leases are failed as crashes would be, but named as shutdown). */
  async close(): Promise<void> {
    const entries = [...this.#browsers.values()];
    this.#browsers.clear();
    await Promise.all(
      entries.map(async (entry) => {
        entry.closing = true;
        if (entry.idleTimer !== undefined) clearTimeout(entry.idleTimer);
        await (await entry.browser).close();
      }),
    );
  }

  async #admit(deadline: number): Promise<{ sample: ResourceSample; maxContexts: number }> {
    // The cap needs one sample; take it before the slot so an unconfigured cap is known.
    let sample = await this.#signals.sample();
    if (this.#maxContexts === undefined) {
      this.#maxContexts = defaultMaxContexts(this.#cores(), sample.memAvailableBytes, this.#contextMemoryBytes);
    }
    const maxContexts = this.#maxContexts;
    await this.#takeSlot(deadline, maxContexts);
    try {
      let backoff = this.#backoffInitialMs;
      for (;;) {
        const violation = admissionViolation(sample, this.#thresholds, this.#contextMemoryBytes);
        if (violation === undefined) return { sample, maxContexts };
        const remaining = deadline - this.#now();
        if (remaining <= 0) {
          throw new AdmissionTimeoutError(
            `admission timed out after ${this.#timeoutMs}ms: ${violation}. ` +
              "The host is over a resource threshold; free resources, lower concurrency (maxContexts), or raise the threshold/timeout.",
          );
        }
        await this.#sleep(Math.min(backoff, remaining));
        backoff = Math.min(backoff * 2, this.#backoffMaxMs);
        sample = await this.#signals.sample();
      }
    } catch (err) {
      this.#freeSlot();
      throw err;
    }
  }

  async #takeSlot(deadline: number, maxContexts: number): Promise<void> {
    if (this.#inUse < maxContexts) {
      this.#inUse += 1;
      return;
    }
    const remaining = Math.max(0, deadline - this.#now());
    await new Promise<void>((resolve, reject) => {
      const waiter = (): void => {
        clearTimeout(timer);
        resolve();
      };
      const timer = setTimeout(() => {
        const at = this.#slotWaiters.indexOf(waiter);
        if (at >= 0) this.#slotWaiters.splice(at, 1);
        reject(
          new AdmissionTimeoutError(
            `admission timed out after ${this.#timeoutMs}ms: all ${maxContexts} browser context slot(s) stayed busy. ` +
              "Lower concurrency or raise maxContexts / the admission timeout.",
          ),
        );
      }, remaining);
      this.#slotWaiters.push(waiter);
    });
  }

  /**
   * Closes `context`, waiting at most `closeTimeoutMs`. A close that is still pending then is left
   * to finish on its own and reported as a process warning — the slot is not held hostage by it.
   */
  async #boundedClose(context: C, launchKey: string): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const closing = context.close();
    const timedOut = new Promise<"timeout">((resolve) => {
      timer = setTimeout(() => resolve("timeout"), this.#closeTimeoutMs);
      timer.unref?.();
    });
    try {
      const r = await Promise.race([closing.then(() => "closed" as const), timedOut]);
      if (r === "timeout") {
        closing.catch(() => undefined);
        process.emitWarning(
          `jevitate: closing a browser context (${launchKey}) did not finish within ${this.#closeTimeoutMs}ms ` +
            "(a hung page?); its slot was freed anyway",
        );
      }
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }

  /** Frees a slot, handing it straight to the next waiter (FIFO) when there is one. */
  #freeSlot(): void {
    const next = this.#slotWaiters.shift();
    if (next !== undefined) next();
    else this.#inUse -= 1;
  }

  #entryFor(launchKey: string, launch: () => Promise<PooledBrowser<C, O>>): BrowserEntry<C, O> {
    const existing = this.#browsers.get(launchKey);
    if (existing !== undefined) return existing;
    const leases = new Set<LeaseState<C>>();
    const entry: BrowserEntry<C, O> = {
      browser: launch().then((browser) => {
        browser.on("disconnected", () => this.#onDisconnected(launchKey, entry));
        return browser;
      }),
      leases,
      closing: false,
      idleTimer: undefined,
    };
    // A failed launch must not poison the key: the next acquire launches afresh.
    entry.browser.catch(() => {
      if (this.#browsers.get(launchKey) === entry) this.#browsers.delete(launchKey);
    });
    this.#browsers.set(launchKey, entry);
    return entry;
  }

  #onDisconnected(launchKey: string, entry: BrowserEntry<C, O>): void {
    if (this.#browsers.get(launchKey) === entry) this.#browsers.delete(launchKey);
    if (entry.closing) return;
    const live = entry.leases.size;
    for (const lease of entry.leases) {
      lease.crash = new BrowserCrashedError(
        `browser for launch config ${launchKey} disconnected unexpectedly (crashed or was killed) with ${live} live context(s); ` +
          "this session's work is lost and was NOT retried. The next session relaunches the browser.",
      );
    }
  }

  #detach(launchKey: string, entry: BrowserEntry<C, O>, state: LeaseState<C>): void {
    entry.leases.delete(state);
    if (entry.leases.size > 0 || entry.closing || this.#browsers.get(launchKey) !== entry) return;
    const timer = setTimeout(() => {
      if (entry.leases.size > 0 || this.#browsers.get(launchKey) !== entry) return;
      this.#browsers.delete(launchKey);
      entry.closing = true;
      // A launch failure was already thrown to the acquirer that triggered it;
      // a failed idle close is surfaced as a process warning, never dropped.
      void entry.browser.then(
        (b) => b.close().catch((err: unknown) => process.emitWarning(`jevitate: closing idle browser ${launchKey} failed: ${String(err)}`)),
        () => undefined,
      );
    }, this.#idleCloseMs);
    timer.unref();
    entry.idleTimer = timer;
  }
}
