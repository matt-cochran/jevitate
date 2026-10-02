/**
 * Page liveness watchdog (#220). A mission awaits Playwright operations on its page; a renderer that
 * DIES makes every pending operation reject ("Target crashed"), but a renderer that is alive yet
 * no longer answers (frozen, starved, wedged on a loaded host) makes them wait forever — the run
 * idles at 0% CPU until something external kills it, and every per-step bound in the mission is
 * blind to it because the await it is stuck in has none.
 *
 * The watchdog probes the page with a trivial evaluate on an interval. When the page has not
 * answered for `unresponsiveMs`, it closes the page WITH A REASON: Playwright then rejects every
 * pending and later operation on it with that reason, so the mission ends through its own crash
 * path — a typed `crashed` result that names why — instead of hanging. A page that is already gone
 * (closed, crashed) needs no help: the watchdog just stops.
 */

/** The slice of a Playwright `Page` the watchdog needs. */
import { clock } from "@jevitate/domain";

export interface LivenessPage {
  evaluate(fn: () => boolean): Promise<boolean>;
  isClosed(): boolean;
  close(options?: { reason?: string }): Promise<void>;
  on(event: "close" | "crash", listener: () => void): unknown;
}

/** Default bound: a page that answers no trivial evaluate for this long is treated as lost. */
export const DEFAULT_PAGE_UNRESPONSIVE_MS = 60_000;

export interface PageLivenessOptions {
  /** How long the page may go without answering a probe before it is closed. */
  readonly unresponsiveMs?: number;
  /** How often a probe is started (at most one is in flight). Default `min(5s, unresponsiveMs / 3)`. */
  readonly probeIntervalMs?: number;
  /** Told once, with the reason, when the watchdog gives up on the page (before it closes it). */
  readonly onLost?: (reason: string) => void;
  readonly now?: () => number;
}

/**
 * `JEVITATE_PAGE_UNRESPONSIVE_MS`: the liveness bound (ms). Unset → the default; a set-but-invalid
 * value throws (a typo must not silently mean "default").
 */
export function pageUnresponsiveMsFromEnv(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.JEVITATE_PAGE_UNRESPONSIVE_MS;
  if (raw === undefined || raw === "") return DEFAULT_PAGE_UNRESPONSIVE_MS;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1) throw new RangeError(`JEVITATE_PAGE_UNRESPONSIVE_MS must be a positive integer, got ${JSON.stringify(raw)}`);
  return n;
}

/** Pages a watchdog gave up on, with the reason — read by a mission's crash path (`pageLostReason`). */
const lostPages = new WeakMap<object, string>();

/**
 * Why a liveness watchdog closed `page`, when one did (#220). A mission's failure classification
 * reads it so a run that ended on an unresponsive page says so, instead of a generic "page closed".
 */
export function pageLostReason(page: object): string | undefined {
  return lostPages.get(page);
}

export class PageLivenessWatchdog {
  readonly #page: LivenessPage;
  readonly #unresponsiveMs: number;
  readonly #now: () => number;
  readonly #onLost: ((reason: string) => void) | undefined;
  readonly #timer: ReturnType<typeof setInterval>;
  #lastAnswer: number;
  #probing = false;
  #stopped = false;
  #lost: string | undefined;

  constructor(page: LivenessPage, opts: PageLivenessOptions = {}) {
    this.#page = page;
    this.#unresponsiveMs = opts.unresponsiveMs ?? DEFAULT_PAGE_UNRESPONSIVE_MS;
    if (!Number.isFinite(this.#unresponsiveMs) || this.#unresponsiveMs <= 0) {
      throw new RangeError(`unresponsiveMs must be a positive number, got ${String(this.#unresponsiveMs)}`);
    }
    this.#now = opts.now ?? clock.now;
    this.#onLost = opts.onLost;
    this.#lastAnswer = this.#now();
    const interval = opts.probeIntervalMs ?? Math.max(1, Math.min(5_000, Math.floor(this.#unresponsiveMs / 3)));
    page.on("close", () => this.stop());
    page.on("crash", () => this.stop());
    this.#timer = clock.setInterval(() => this.tick(), interval);
    // Never keep the process alive just for the watchdog.
    (this.#timer as { unref?: () => void }).unref?.();
  }

  /** Why the page was given up on, once it was. */
  get lost(): string | undefined {
    return this.#lost;
  }

  stop(): void {
    if (this.#stopped) return;
    this.#stopped = true;
    clock.clearInterval(this.#timer);
  }

  /** One interval: give up on a page silent for too long, else start a probe unless one is in flight. */
  tick(): void {
    if (this.#stopped) return;
    if (this.#page.isClosed()) {
      this.stop();
      return;
    }
    const silentMs = this.#now() - this.#lastAnswer;
    if (silentMs >= this.#unresponsiveMs) {
      this.#giveUp(silentMs);
      return;
    }
    if (this.#probing) return;
    this.#probing = true;
    this.#page.evaluate(() => true).then(
      () => this.#answered(),
      () => {
        // A live page that REJECTS answered (e.g. its execution context was replaced by a
        // navigation); a gone page stops the watchdog on the next tick.
        this.#answered();
      },
    );
  }

  #answered(): void {
    this.#probing = false;
    this.#lastAnswer = this.#now();
  }

  #giveUp(silentMs: number): void {
    this.stop();
    const reason =
      `the page process stopped responding: no answer for ${Math.round(silentMs / 1000)}s ` +
      "(renderer frozen, starved or wedged); jevitate closed the page so the run ends instead of hanging";
    this.#lost = reason;
    lostPages.set(this.#page, reason);
    try {
      this.#onLost?.(reason);
    } catch {
      // A listener must never keep the page from being closed.
    }
    this.#page.close({ reason }).catch(() => undefined);
  }
}
