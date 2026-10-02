/**
 * The injectable clock (#304): the ONE place Node-side code reads the time or schedules a timer.
 *
 * Production code calls `clock.now()`, `clock.nowIso()`, `clock.monotonicMs()`, `clock.setTimeout(...)`,
 * `clock.setInterval(...)`, `clock.sleep(ms)` (and the matching clears) instead of the globals. By default
 * every call goes straight to the REAL platform timers, so behaviour is unchanged. A test installs a
 * {@link FakeClock} with `installClock(fake)` and advances time explicitly (`advanceBy`, `runUntilIdle`)
 * or lets it run warped (`warp(factor)`), so hang thresholds, settle windows, reply/job waits, watchdogs
 * and sampling intervals elapse without real waiting. `resetClock()` restores the real clock.
 *
 * Code that runs INSIDE the browser (functions passed to `page.evaluate` / `addInitScript`, the in-page
 * instrumentation strings) keeps the page's native timers: page time is controlled with Playwright's
 * `page.clock`, not with this module. `scripts/check-clock.mjs` (part of `pnpm lint`) forbids new direct
 * `Date.now()` / `setTimeout` / `setInterval` / `performance.now()` in Node source outside this file.
 */

/** A timer handle: the platform's own (a Node `Timeout`), or a fake one shaped like it. */
export type TimerHandle = ReturnType<typeof globalThis.setTimeout>;

/** What a clock implementation provides; {@link clock} delegates every call to the installed one. */
export interface ClockImpl {
  /** Wall-clock epoch milliseconds (what `Date.now()` returns). */
  now(): number;
  /** Monotonic milliseconds (what `performance.now()` returns): for measuring durations. */
  monotonicMs(): number;
  setTimeout<A extends unknown[]>(fn: (...args: A) => void, ms?: number, ...args: A): TimerHandle;
  clearTimeout(handle: TimerHandle | string | number | undefined | null): void;
  setInterval<A extends unknown[]>(fn: (...args: A) => void, ms?: number, ...args: A): TimerHandle;
  clearInterval(handle: TimerHandle | string | number | undefined | null): void;
}

// FakeClock's own plumbing (warp ticks, I/O turns) uses timers captured once at module load, so it
// keeps working whatever a test does to the globals.
const realSetInterval = globalThis.setInterval.bind(globalThis);
const realClearInterval = globalThis.clearInterval.bind(globalThis);
const realSetImmediate = globalThis.setImmediate.bind(globalThis);
const realSetTimeout = globalThis.setTimeout.bind(globalThis);
const realClearTimeout = globalThis.clearTimeout.bind(globalThis);
const realDateNow = Date.now.bind(Date);
const realPerfNow = globalThis.performance.now.bind(globalThis.performance);

/**
 * The real platform clock: `Date.now`, `performance.now` and the global timers, looked up at CALL
 * time (so a test framework's own fake timers, e.g. `vi.useFakeTimers()`, still apply to it).
 */
export const realClock: ClockImpl = {
  now: () => Date.now(),
  monotonicMs: () => globalThis.performance.now(),
  setTimeout: (fn, ms, ...args) => globalThis.setTimeout(fn as (...a: unknown[]) => void, ms, ...args),
  clearTimeout: (handle) => globalThis.clearTimeout(handle as Parameters<typeof clearTimeout>[0]),
  setInterval: (fn, ms, ...args) => globalThis.setInterval(fn as (...a: unknown[]) => void, ms, ...args),
  clearInterval: (handle) => globalThis.clearInterval(handle as Parameters<typeof clearInterval>[0]),
};

let current: ClockImpl = realClock;

/** Route every {@link clock} call to `impl` (tests only). Returns the previously installed clock. */
export function installClock(impl: ClockImpl): ClockImpl {
  const previous = current;
  current = impl;
  return previous;
}

/** Restore the real platform clock. */
export function resetClock(): void {
  current = realClock;
}

/** The currently installed clock implementation (the real one unless a test installed a fake). */
export function currentClock(): ClockImpl {
  return current;
}

/**
 * The clock every Node-side module uses. Each method reads the installed implementation at call
 * time, so `installClock` takes effect for code that captured `clock` long before.
 */
export const clock = {
  now: (): number => current.now(),
  nowIso: (): string => new Date(current.now()).toISOString(),
  monotonicMs: (): number => current.monotonicMs(),
  setTimeout: <A extends unknown[]>(fn: (...args: A) => void, ms?: number, ...args: A): TimerHandle =>
    current.setTimeout(fn, ms, ...args),
  clearTimeout: (handle: TimerHandle | string | number | undefined | null): void => current.clearTimeout(handle),
  setInterval: <A extends unknown[]>(fn: (...args: A) => void, ms?: number, ...args: A): TimerHandle =>
    current.setInterval(fn, ms, ...args),
  clearInterval: (handle: TimerHandle | string | number | undefined | null): void => current.clearInterval(handle),
  /** Resolve after `ms` milliseconds of (installed-clock) time. */
  sleep: (ms: number): Promise<void> => new Promise<void>((resolve) => current.setTimeout(() => resolve(), ms)),
} as const;

interface FakeTimer {
  readonly id: number;
  at: number;
  readonly seq: number;
  readonly fn: (...args: unknown[]) => void;
  readonly args: unknown[];
  readonly interval: number | null;
}

/** Options for {@link FakeClock}. */
export interface FakeClockOptions {
  /** Starting wall-clock epoch ms. Default 2026-01-01T00:00:00.000Z. */
  readonly startMs?: number;
  /**
   * Real event-loop turns (`setImmediate`) yielded before each fired timer and at the end of an
   * advance, so awaited I/O (a socket, a file, a CDP reply) can progress between fake ticks. Default 1.
   */
  readonly ioTurns?: number;
}

/** A fake timer handle: shaped like Node's `Timeout` (ref/unref/hasRef/refresh, numeric primitive). */
class FakeTimeout {
  constructor(
    readonly id: number,
    private readonly owner: FakeClock,
  ) {}
  ref(): this {
    return this;
  }
  unref(): this {
    return this;
  }
  hasRef(): boolean {
    return true;
  }
  refresh(): this {
    this.owner.refreshTimer(this.id);
    return this;
  }
  close(): this {
    this.owner.clearTimeout(this as unknown as TimerHandle);
    return this;
  }
  [Symbol.toPrimitive](): number {
    return this.id;
  }
}

/**
 * A deterministic clock for tests. Time only moves when the test moves it:
 *
 *  - `advanceBy(ms)` fires every timer due within `ms`, in due order (ties in scheduling order),
 *    yielding microtasks and `ioTurns` real event-loop turns between timers so `await`ed work started
 *    by one timer (including real I/O) runs before the next fires;
 *  - `runUntilIdle()` keeps advancing to the next timer until none is pending;
 *  - `warp(factor)` lets fake time run `factor`× faster than real time in the background (for
 *    browser-driven tests where real I/O and fake waits interleave); `stopWarp()` ends it.
 */
export class FakeClock implements ClockImpl {
  #wall: number;
  #mono = 0;
  #nextId = 1;
  #seq = 0;
  readonly #timers = new Map<number, FakeTimer>();
  readonly #ioTurns: number;
  #warpHandle: ReturnType<typeof realSetInterval> | undefined;

  constructor(opts: FakeClockOptions = {}) {
    this.#wall = opts.startMs ?? Date.UTC(2026, 0, 1);
    this.#ioTurns = Math.max(0, opts.ioTurns ?? 1);
  }

  now(): number {
    return this.#wall;
  }

  monotonicMs(): number {
    return this.#mono;
  }

  /** Number of pending timers (intervals count once). */
  pending(): number {
    return this.#timers.size;
  }

  setTimeout<A extends unknown[]>(fn: (...args: A) => void, ms?: number, ...args: A): TimerHandle {
    return this.#schedule(fn as (...a: unknown[]) => void, ms, args, null);
  }

  setInterval<A extends unknown[]>(fn: (...args: A) => void, ms?: number, ...args: A): TimerHandle {
    const every = Math.max(1, Math.floor(Number(ms ?? 0)) || 0);
    return this.#schedule(fn as (...a: unknown[]) => void, every, args, every);
  }

  clearTimeout(handle: TimerHandle | string | number | undefined | null): void {
    if (handle === undefined || handle === null) return;
    this.#timers.delete(Number(handle));
  }

  clearInterval(handle: TimerHandle | string | number | undefined | null): void {
    this.clearTimeout(handle);
  }

  /** @internal — `FakeTimeout.refresh()`: restart a timer's countdown from now. */
  refreshTimer(id: number): void {
    const t = this.#timers.get(id);
    if (t === undefined) return;
    const delay = t.interval ?? 0;
    t.at = this.#mono + delay;
  }

  /** Move time forward by `ms`, firing every timer that comes due (async: awaited work interleaves). */
  async advanceBy(ms: number): Promise<void> {
    const target = this.#mono + Math.max(0, ms);
    await this.#yield();
    for (;;) {
      const next = this.#nextDue(target);
      if (next === undefined) break;
      this.#moveTo(next.at);
      this.#fire(next);
      await this.#yield();
    }
    this.#moveTo(target);
    await this.#yield();
  }

  /** Move to and fire the next pending timer (if any). Returns false when nothing is pending. */
  async next(): Promise<boolean> {
    await this.#yield();
    const t = this.#nextDue(Number.POSITIVE_INFINITY);
    if (t === undefined) return false;
    this.#moveTo(Math.max(this.#mono, t.at));
    this.#fire(t);
    await this.#yield();
    return true;
  }

  /** Fire timers until none is pending (bounded: an endless interval stops after `maxTimers`). */
  async runUntilIdle(maxTimers = 10_000): Promise<void> {
    for (let i = 0; i < maxTimers; i++) {
      if (!(await this.next())) return;
    }
    throw new Error(`FakeClock.runUntilIdle: still busy after ${maxTimers} timers (an endless interval?)`);
  }

  /**
   * Run fake time `factor`× faster than real time until `stopWarp()`: every real `tickMs`, time
   * advances by `factor * tickMs` (firing what comes due). A 15 s threshold at factor 100 takes ~150 ms.
   */
  warp(factor: number, tickMs = 5): void {
    this.stopWarp();
    let busy = false;
    this.#warpHandle = realSetInterval(() => {
      if (busy) return;
      busy = true;
      void this.advanceBy(factor * tickMs).finally(() => {
        busy = false;
      });
    }, tickMs);
  }

  stopWarp(): void {
    if (this.#warpHandle !== undefined) realClearInterval(this.#warpHandle);
    this.#warpHandle = undefined;
  }

  /** Set the wall clock (does not move monotonic time or fire timers). */
  setSystemTime(epochMs: number): void {
    this.#wall = epochMs;
  }

  #schedule(fn: (...a: unknown[]) => void, ms: number | undefined, args: unknown[], interval: number | null): TimerHandle {
    const id = this.#nextId++;
    const delay = Math.max(0, Math.floor(Number(ms ?? 0)) || 0);
    this.#timers.set(id, { id, at: this.#mono + delay, seq: this.#seq++, fn, args, interval });
    return new FakeTimeout(id, this) as unknown as TimerHandle;
  }

  #nextDue(limit: number): FakeTimer | undefined {
    let best: FakeTimer | undefined;
    for (const t of this.#timers.values()) {
      if (t.at > limit) continue;
      if (best === undefined || t.at < best.at || (t.at === best.at && t.seq < best.seq)) best = t;
    }
    return best;
  }

  #moveTo(mono: number): void {
    if (mono <= this.#mono) return;
    this.#wall += mono - this.#mono;
    this.#mono = mono;
  }

  #fire(t: FakeTimer): void {
    if (t.interval === null) this.#timers.delete(t.id);
    else this.#timers.set(t.id, { ...t, at: t.at + t.interval, seq: this.#seq++ });
    t.fn(...t.args);
  }

  async #yield(): Promise<void> {
    await Promise.resolve();
    for (let i = 0; i < this.#ioTurns; i++) await new Promise<void>((r) => realSetImmediate(r));
  }
}

/** Options for {@link TimeSkippingClock}. */
export interface TimeSkippingOptions {
  /**
   * Real ms with no clock call (nothing reading the time or scheduling) before an idle wait may be
   * skipped. Default 25.
   */
  readonly idleMs?: number;
  /**
   * Extra veto, asked before every skip: false while real work the clock cannot see is in flight
   * (a browser call awaiting its answer, a request on the wire). Default: always true.
   */
  readonly canSkip?: () => boolean;
  /** Awaited before time jumps by `ms` (e.g. advance the pages' `page.clock` by the same amount). */
  readonly onSkip?: (ms: number) => Promise<void> | void;
  /** How often (real ms) the skipper looks for an idle wait. Default 5. */
  readonly tickMs?: number;
}

interface SkipTimer {
  at: number;
  readonly fn: (...args: unknown[]) => void;
  readonly args: unknown[];
  readonly interval: number | null;
  real: ReturnType<typeof realSetTimeout> | undefined;
  refed: boolean;
}

/** A {@link TimeSkippingClock} handle: shaped like Node's `Timeout`; unref/ref reach the real timer. */
class SkipTimeout {
  constructor(
    readonly id: number,
    private readonly owner: TimeSkippingClock,
  ) {}
  ref(): this {
    this.owner.refTimer(this.id, true);
    return this;
  }
  unref(): this {
    this.owner.refTimer(this.id, false);
    return this;
  }
  hasRef(): boolean {
    return this.owner.timerRefed(this.id);
  }
  refresh(): this {
    return this;
  }
  close(): this {
    this.owner.clearTimeout(this as unknown as TimerHandle);
    return this;
  }
  [Symbol.toPrimitive](): number {
    return this.id;
  }
}

/**
 * Real time that SKIPS idle waits — for tests that drive a real browser. Time flows exactly like the
 * real clock (so real I/O, a real server and a real page all line up with it), but whenever the
 * process is only waiting on this clock's timers — no clock call for `idleMs`, and `canSkip()` says
 * no outside work is in flight — time jumps straight to the next timer. A 500 ms settle window, a
 * 15 s hang threshold or a 60 s liveness bound then costs a few real milliseconds once nothing is
 * happening, while anything that IS happening still runs in real time. `onSkip` lets the test move
 * in-page time (`page.clock.runFor`) by the same jump, so page and Node clocks stay in step.
 */
export class TimeSkippingClock implements ClockImpl {
  #offset = 0;
  #nextId = 1;
  #lastActivity = realPerfNow();
  #skipping = false;
  #skipped = 0;
  #skips = 0;
  readonly #timers = new Map<number, SkipTimer>();
  readonly #idleMs: number;
  readonly #canSkip: () => boolean;
  readonly #onSkip: ((ms: number) => Promise<void> | void) | undefined;
  #loop: ReturnType<typeof realSetInterval> | undefined;

  constructor(opts: TimeSkippingOptions = {}) {
    this.#idleMs = Math.max(0, opts.idleMs ?? 25);
    this.#canSkip = opts.canSkip ?? (() => true);
    this.#onSkip = opts.onSkip;
    this.#loop = realSetInterval(() => void this.#maybeSkip(), Math.max(1, opts.tickMs ?? 5));
    this.#loop.unref();
  }

  /** Total ms skipped so far, and how many jumps. */
  get skipped(): { ms: number; jumps: number } {
    return { ms: this.#skipped, jumps: this.#skips };
  }

  /** Stop skipping (time keeps flowing; pending timers still fire in real time). */
  stop(): void {
    if (this.#loop !== undefined) realClearInterval(this.#loop);
    this.#loop = undefined;
  }

  now(): number {
    this.#touch();
    return realDateNow() + this.#offset;
  }

  monotonicMs(): number {
    this.#touch();
    return this.#mono();
  }

  setTimeout<A extends unknown[]>(fn: (...args: A) => void, ms?: number, ...args: A): TimerHandle {
    return this.#schedule(fn as (...a: unknown[]) => void, ms, args, null);
  }

  setInterval<A extends unknown[]>(fn: (...args: A) => void, ms?: number, ...args: A): TimerHandle {
    const every = Math.max(1, Math.floor(Number(ms ?? 0)) || 0);
    return this.#schedule(fn as (...a: unknown[]) => void, every, args, every);
  }

  clearTimeout(handle: TimerHandle | string | number | undefined | null): void {
    this.#touch();
    if (handle === undefined || handle === null) return;
    const id = Number(handle);
    const t = this.#timers.get(id);
    if (t?.real !== undefined) realClearTimeout(t.real);
    this.#timers.delete(id);
  }

  clearInterval(handle: TimerHandle | string | number | undefined | null): void {
    this.clearTimeout(handle);
  }

  /** @internal */
  refTimer(id: number, refed: boolean): void {
    const t = this.#timers.get(id);
    if (t === undefined) return;
    t.refed = refed;
    if (refed) t.real?.ref();
    else t.real?.unref();
  }

  /** @internal */
  timerRefed(id: number): boolean {
    return this.#timers.get(id)?.refed ?? false;
  }

  #mono(): number {
    return realPerfNow() + this.#offset;
  }

  #touch(): void {
    if (!this.#skipping) this.#lastActivity = realPerfNow();
  }

  #schedule(fn: (...a: unknown[]) => void, ms: number | undefined, args: unknown[], interval: number | null): TimerHandle {
    this.#touch();
    const id = this.#nextId++;
    const delay = Math.max(0, Math.floor(Number(ms ?? 0)) || 0);
    const t: SkipTimer = { at: this.#mono() + delay, fn, args, interval, real: undefined, refed: true };
    this.#timers.set(id, t);
    this.#arm(id, t);
    return new SkipTimeout(id, this) as unknown as TimerHandle;
  }

  #arm(id: number, t: SkipTimer): void {
    if (t.real !== undefined) realClearTimeout(t.real);
    t.real = realSetTimeout(() => this.#fire(id), Math.max(0, t.at - this.#mono()));
    if (!t.refed) t.real.unref();
  }

  #fire(id: number): void {
    const t = this.#timers.get(id);
    if (t === undefined) return;
    if (t.at > this.#mono() + 0.5) {
      this.#arm(id, t); // a real timer that woke early (rounding): wait out the rest
      return;
    }
    if (t.interval === null) this.#timers.delete(id);
    else {
      t.at += t.interval;
      this.#arm(id, t);
    }
    this.#lastActivity = realPerfNow();
    t.fn(...t.args);
  }

  async #maybeSkip(): Promise<void> {
    if (this.#skipping || this.#timers.size === 0) return;
    if (realPerfNow() - this.#lastActivity < this.#idleMs) return;
    let next: SkipTimer | undefined;
    for (const t of this.#timers.values()) if (next === undefined || t.at < next.at) next = t;
    if (next === undefined) return;
    const jump = next.at - this.#mono();
    if (jump <= 1) return;
    if (!this.#canSkip()) return;
    this.#skipping = true;
    try {
      await this.#onSkip?.(jump);
      this.#offset += jump;
      this.#skipped += jump;
      this.#skips += 1;
      for (const [id, t] of this.#timers) this.#arm(id, t);
    } finally {
      this.#skipping = false;
      this.#lastActivity = realPerfNow();
    }
  }
}
