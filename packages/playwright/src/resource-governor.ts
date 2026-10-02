import { availableParallelism, loadavg, totalmem } from "node:os";
import { DEFAULT_ADMISSION_TIMEOUT_MS } from "./browser-pool.js";
import { measureOwnBrowserMemory, type BrowserMemoryReading, type MemoryMetric } from "./browser-processes.js";
import { MachineBrowserSlots, type MachineSlotLease } from "./machine-slots.js";
import type { MemMetric, ResourceSignals } from "./resource-signals.js";
import { createResourceSignals } from "./select-resource-signals.js";
import { clock } from "@jevitate/domain";

/**
 * Resource governance for shared machines (#205). jevitate often runs next to builds, test suites,
 * dev servers and other agents; a browser run that competes with them for memory and CPU either
 * times out (the app looks hung) or gets an unrelated process killed. One governor per jevitate
 * process applies four rules — every one recorded in the run's result (`hostHealth.resources`):
 *
 *  1. MACHINE-WIDE BROWSER CAP — a process takes one machine slot (`MachineBrowserSlots`) while it
 *     has any browser session open; at most `maxBrowsers` jevitate processes run browsers at once
 *     (`--max-browsers`, `JEVITATE_MAX_BROWSERS`, default `defaultMaxBrowsers`).
 *  2. MEMORY CEILING — the memory of the browser processes this process launched (browser +
 *     renderers + helpers, Linux PSS) is sampled every `intervalMs`; past the ceiling
 *     (`--max-browser-memory`, `JEVITATE_MAX_BROWSER_MEMORY_MB`, default `defaultMemoryCeilingBytes`)
 *     the offending session's page is closed WITH A REASON, and its run ends `inconclusive` with
 *     failure kind `resource-limit` naming the measured value and the ceiling — never a crash, never
 *     a finding about the app (`pageResourceLimit`).
 *  3. ADAPTIVE THROTTLING — the host's load and memory are judged (`throttleDecision`) at every
 *     session start and on every sample: `throttled` halves the machine cap a new run may take and
 *     doubles the settle windows (`resourceSettleFactor`); `starved` makes a NEW run refuse to start
 *     (`E_HOST_STARVED`, unless `--ignore-host-load`) — a run already going keeps going, throttled.
 *  4. ORPHAN CLEANUP — see `browser-processes.ts` (the owner marker) and the CLI's startup sweep /
 *     `jevitate doctor --cleanup`.
 *
 * `JEVITATE_RESOURCE_GOVERNANCE=off` turns the automatic parts off (no default machine cap, no
 * default memory ceiling, no throttling, no starved-host refusal, no startup sweep) — for a harness
 * that controls the machine itself (jevitate's own test suite sets it). An explicit
 * `--max-browsers` / `--max-browser-memory` still applies.
 */

// ── Throttle thresholds ───────────────────────────────────────────────────────────────────────

export interface ThrottleThresholds {
  /** Load per core above which new work is throttled (matches host-health's starved-host bound). */
  readonly throttleLoadPerCore: number;
  /** Load per core at/above which a NEW run refuses to start. */
  readonly refuseLoadPerCore: number;
  /** Available memory below which new work is throttled. */
  readonly throttleMemAvailableBytes: number;
  /** Available memory below which a NEW run refuses to start (less than one browser context needs). */
  readonly refuseMemAvailableBytes: number;
  /** Memory-pressure stall percentage (PSI full avg10 / macOS level) above which work is throttled. */
  readonly throttleMemPressure: number;
}

/**
 * Defaults: at 2 runnable tasks per core every task gets ≤ half a core — Playwright's fixed action
 * timeouts start measuring the queue, not the app (host-health's `STARVED_LOAD_PER_CORE`); at 4 per
 * core (a 16-core machine at load 64) a browser run only times out, so a new one is refused. Memory:
 * under 1.5 GiB available a browser (≈400 MiB/context plus the browser itself) competes with
 * everything else for the last of it; under 512 MiB one context does not fit.
 */
export const DEFAULT_THROTTLE_THRESHOLDS: ThrottleThresholds = Object.freeze({
  throttleLoadPerCore: 2,
  refuseLoadPerCore: 4,
  throttleMemAvailableBytes: 1.5 * 1024 ** 3,
  refuseMemAvailableBytes: 512 * 1024 ** 2,
  throttleMemPressure: 5,
});

export type ThrottleLevel = "normal" | "throttled" | "starved";

/** One host reading the decision is made from (every field optional: a platform may lack it). */
export interface HostLoadSample {
  readonly loadPerCore?: number;
  readonly memAvailableBytes?: number;
  readonly memPressure?: number;
  readonly memMetric?: MemMetric;
  readonly source?: string;
}

export interface ThrottleDecision {
  readonly level: ThrottleLevel;
  /** Why (empty for `normal`), e.g. `load 2.50/core > 2`. */
  readonly reasons: readonly string[];
  /** Multiplier for settle windows (quiet window, render ceiling): 1 normal, 2 throttled/starved. */
  readonly settleFactor: number;
  readonly sample: HostLoadSample;
}

const fmt = (n: number): string => (Number.isInteger(n) ? String(n) : n.toFixed(2));
const mib = (n: number): string => `${Math.round(n / 1024 ** 2)} MiB`;

/** The pure throttling rule (#205): one host sample → `normal` / `throttled` / `starved`, with reasons. */
export function throttleDecision(sample: HostLoadSample, t: ThrottleThresholds = DEFAULT_THROTTLE_THRESHOLDS): ThrottleDecision {
  const starved: string[] = [];
  const throttled: string[] = [];
  const load = sample.loadPerCore;
  if (load !== undefined) {
    if (load >= t.refuseLoadPerCore) starved.push(`load ${fmt(load)}/core >= ${fmt(t.refuseLoadPerCore)}`);
    else if (load > t.throttleLoadPerCore) throttled.push(`load ${fmt(load)}/core > ${fmt(t.throttleLoadPerCore)}`);
  }
  const mem = sample.memAvailableBytes;
  if (mem !== undefined) {
    if (mem < t.refuseMemAvailableBytes) starved.push(`memory available ${mib(mem)} < ${mib(t.refuseMemAvailableBytes)}`);
    else if (mem < t.throttleMemAvailableBytes) throttled.push(`memory available ${mib(mem)} < ${mib(t.throttleMemAvailableBytes)}`);
  }
  if (sample.memPressure !== undefined && sample.memPressure > t.throttleMemPressure) {
    throttled.push(`memory pressure ${fmt(sample.memPressure)}%${sample.memMetric === undefined ? "" : ` (${sample.memMetric})`} > ${fmt(t.throttleMemPressure)}%`);
  }
  if (starved.length > 0) return { level: "starved", reasons: [...starved, ...throttled], settleFactor: 2, sample };
  if (throttled.length > 0) return { level: "throttled", reasons: throttled, settleFactor: 2, sample };
  return { level: "normal", reasons: [], settleFactor: 1, sample };
}

/** The machine cap a NEW run may take under `level`: halved (at least 1) while the host is loaded. */
export function effectiveMaxBrowsers(maxBrowsers: number, level: ThrottleLevel): number {
  return level === "normal" ? maxBrowsers : Math.max(1, Math.floor(maxBrowsers / 2));
}

// ── Configuration ─────────────────────────────────────────────────────────────────────────────

/**
 * Default machine-wide cap: a quarter of the cores (each browser run is a browser process, its
 * renderers and the jevitate driver — several cores' worth under load), at least 2, at most 6, and
 * no more than one per 2 GiB of RAM. 16 cores / 24 GiB → 4.
 */
export function defaultMaxBrowsers(cores: number = availableParallelism(), totalMemBytes: number = totalmem()): number {
  return Math.max(2, Math.min(6, Math.floor(cores / 4), Math.floor(totalMemBytes / (2 * 1024 ** 3))));
}

/** Default memory ceiling of one run's browsers: 4 GiB, or half the machine's RAM when that is less. */
export function defaultMemoryCeilingBytes(totalMemBytes: number = totalmem()): number {
  return Math.min(4 * 1024 ** 3, Math.floor(totalMemBytes / 2));
}

/** Per-run limits (`--max-browsers`, `--max-browser-memory`); they override the governor's defaults. */
export interface ResourceLimits {
  /** Machine-wide cap on jevitate processes running browsers at once. */
  readonly maxBrowsers?: number;
  /** Ceiling on this run's browser memory (bytes). */
  readonly memoryCeilingBytes?: number;
}

export interface GovernanceConfig {
  /** `false` under `JEVITATE_RESOURCE_GOVERNANCE=off`: only explicit limits apply. */
  readonly enabled: boolean;
  /** The default machine cap (applied when enabled). */
  readonly maxBrowsers: number;
  /** The default memory ceiling (bytes; null = none). Applied when enabled. */
  readonly memoryCeilingBytes: number | null;
}

function envPositiveInt(env: NodeJS.ProcessEnv, name: string): number | undefined {
  const raw = env[name];
  if (raw === undefined || raw === "") return undefined;
  const n = Number(raw);
  if (!/^\d+$/.test(raw.trim()) || !Number.isSafeInteger(n) || n < 1) throw new RangeError(`${name} must be a positive integer, got ${JSON.stringify(raw)}`);
  return n;
}

/**
 * The governance configuration from the environment; a set-but-invalid value throws (a typo must
 * not silently mean "default"):
 *  - `JEVITATE_RESOURCE_GOVERNANCE`: `on` (default) | `off`;
 *  - `JEVITATE_MAX_BROWSERS`: the machine-wide cap (positive integer);
 *  - `JEVITATE_MAX_BROWSER_MEMORY_MB`: the memory ceiling in MiB (positive integer) or `off`.
 */
export function governanceFromEnv(env: NodeJS.ProcessEnv = process.env): GovernanceConfig {
  const mode = env.JEVITATE_RESOURCE_GOVERNANCE?.trim().toLowerCase();
  if (mode !== undefined && mode !== "" && mode !== "on" && mode !== "off") {
    throw new RangeError(`JEVITATE_RESOURCE_GOVERNANCE must be on or off, got ${JSON.stringify(env.JEVITATE_RESOURCE_GOVERNANCE)}`);
  }
  const maxBrowsers = envPositiveInt(env, "JEVITATE_MAX_BROWSERS") ?? defaultMaxBrowsers();
  const memRaw = env.JEVITATE_MAX_BROWSER_MEMORY_MB?.trim().toLowerCase();
  const memoryCeilingBytes = memRaw === "off" ? null : (envPositiveInt(env, "JEVITATE_MAX_BROWSER_MEMORY_MB") ?? undefined);
  return {
    enabled: mode !== "off",
    maxBrowsers,
    memoryCeilingBytes: memoryCeilingBytes === null ? null : memoryCeilingBytes === undefined ? defaultMemoryCeilingBytes() : memoryCeilingBytes * 1024 ** 2,
  };
}

function admissionTimeoutFromEnv(env: NodeJS.ProcessEnv): number {
  return envPositiveInt(env, "JEVITATE_ADMISSION_TIMEOUT_MS") ?? DEFAULT_ADMISSION_TIMEOUT_MS;
}

// ── The resource-limit ending ─────────────────────────────────────────────────────────────────

export type ResourceLimitBreach = {
  readonly kind: "memory";
  readonly measuredBytes: number;
  readonly ceilingBytes: number;
  readonly metric: MemoryMetric;
  /** The plain-words reason the page was closed with. */
  readonly message: string;
};

/** Pages the governor closed over a resource limit — read by a mission's failure path (`pageResourceLimit`). */
const limitedPages = new WeakMap<object, ResourceLimitBreach>();

/** Why the governor closed `page` (#205), when it did: its run ends `inconclusive` / `resource-limit`. */
export function pageResourceLimit(page: object): ResourceLimitBreach | undefined {
  return limitedPages.get(page);
}

/** The slice of a Playwright `Page` the memory watch needs. */
export interface MemoryWatchedPage {
  isClosed(): boolean;
  close(options?: { reason?: string }): Promise<void>;
  evaluate<R>(fn: () => R): Promise<R>;
}

// ── The summary every result carries ──────────────────────────────────────────────────────────

/** What governance did during one run (`hostHealth.resources` in every result). */
export type ResourceGovernanceSummary = {
  readonly governance: "on" | "off";
  /** The machine-wide cap this run was admitted under (after throttling); null = no machine cap. */
  readonly maxBrowsers: number | null;
  /** The machine slot this run's process held, and how long it waited for it. */
  readonly machineSlot: { readonly index: number; readonly waitedMs: number } | null;
  /** The most severe throttle level seen during the run, and why. */
  readonly throttle: { readonly level: ThrottleLevel; readonly reasons: string[]; readonly settleFactor: number };
  /** Every throttle level change during the run (first few). */
  readonly throttleChanges: Array<{ readonly at: string; readonly level: ThrottleLevel; readonly reasons: string[] }>;
  readonly memoryCeilingBytes: number | null;
  readonly peakBrowserMemoryBytes: number | null;
  /** How browser memory was measured: `pss`/`rss`, `unavailable` (no reader on this platform), or `off` (no ceiling). */
  readonly memoryMeasurement: MemoryMetric | "unavailable" | "off";
  /** Set when the run was ended by a resource limit. */
  readonly resourceLimit: ResourceLimitBreach | null;
};

const LEVEL_RANK: Readonly<Record<ThrottleLevel, number>> = { normal: 0, throttled: 1, starved: 2 };
const MAX_LISTED_CHANGES = 10;
const MAX_MEMORY_SAMPLES = 10_000;

// ── The governor ──────────────────────────────────────────────────────────────────────────────

export interface ResourceGovernorOptions {
  readonly config?: GovernanceConfig;
  readonly slots?: MachineBrowserSlots;
  /** One host reading (default: this platform's resource signals + load average). */
  readonly sampleHost?: () => Promise<HostLoadSample>;
  /** This process's browser memory (default: `measureOwnBrowserMemory`). */
  readonly measureMemory?: () => BrowserMemoryReading | undefined;
  readonly thresholds?: ThrottleThresholds;
  readonly now?: () => number;
  /** Background sampling interval while a session is open (memory + throttle). Default 2s. */
  readonly intervalMs?: number;
  /** A host decision is reused for this long. Default 2s. */
  readonly decisionTtlMs?: number;
  readonly admissionTimeoutMs?: number;
}

/** Ticket for one open session: release it when the session closes. */
export interface GovernorTicket {
  release(): void;
}

function systemHostSample(signals: ResourceSignals): () => Promise<HostLoadSample> {
  return async () => {
    const load = process.platform === "win32" ? undefined : loadavg()[0]! / Math.max(1, availableParallelism());
    const s = await signals.sample();
    return {
      ...(load === undefined ? {} : { loadPerCore: load }),
      memAvailableBytes: s.memAvailableBytes,
      ...(s.memPressure === undefined ? {} : { memPressure: s.memPressure }),
      ...(s.memMetric === undefined ? {} : { memMetric: s.memMetric }),
      source: s.source,
    };
  };
}

export class ResourceGovernor {
  readonly config: GovernanceConfig;
  readonly #slots: MachineBrowserSlots;
  readonly #sampleHost: () => Promise<HostLoadSample>;
  readonly #measureMemory: (() => BrowserMemoryReading | undefined) | undefined;
  readonly #thresholds: ThrottleThresholds;
  readonly #now: () => number;
  readonly #intervalMs: number;
  readonly #decisionTtlMs: number;
  readonly #admissionTimeoutMs: number;

  #decision: { at: number; value: ThrottleDecision } | undefined;
  #deciding: Promise<ThrottleDecision> | undefined;
  readonly #changes: Array<{ at: number; level: ThrottleLevel; reasons: readonly string[]; settleFactor: number }> = [];

  #open = 0;
  /** The limits the latest session was opened with (the summary reports what applied). */
  #limits: ResourceLimits = {};
  #slot: (MachineSlotLease & { at: number }) | undefined;
  readonly #slotHistory: Array<{ at: number; until: number | undefined; index: number; waitedMs: number; cap: number }> = [];
  #acquiring: Promise<void> | undefined;

  readonly #watched = new Map<MemoryWatchedPage, { ceiling: number; openedAt: number }>();
  readonly #memory: Array<{ at: number; bytes: number }> = [];
  #memoryMetric: MemoryMetric | "unavailable" | undefined;
  #roots: number[] | undefined;
  readonly #breaches: Array<{ at: number; breach: ResourceLimitBreach }> = [];
  #timer: ReturnType<typeof setInterval> | undefined;
  #ticking = false;

  constructor(opts: ResourceGovernorOptions = {}) {
    this.config = opts.config ?? governanceFromEnv();
    this.#slots = opts.slots ?? new MachineBrowserSlots();
    this.#sampleHost = opts.sampleHost ?? systemHostSample(createResourceSignals());
    this.#measureMemory = opts.measureMemory;
    this.#thresholds = opts.thresholds ?? DEFAULT_THROTTLE_THRESHOLDS;
    this.#now = opts.now ?? clock.now;
    this.#intervalMs = opts.intervalMs ?? 2_000;
    this.#decisionTtlMs = opts.decisionTtlMs ?? 2_000;
    this.#admissionTimeoutMs = opts.admissionTimeoutMs ?? admissionTimeoutFromEnv(process.env);
  }

  /** The machine slots this governor uses (for `jevitate doctor`). */
  get slots(): MachineBrowserSlots {
    return this.#slots;
  }

  /** Sessions currently open through this governor. */
  get openSessions(): number {
    return this.#open;
  }

  /** The host's throttle decision now (a fresh sample at most `decisionTtlMs` old); records level changes. */
  async decide(): Promise<ThrottleDecision> {
    const cached = this.#decision;
    if (cached !== undefined && this.#now() - cached.at < this.#decisionTtlMs) return cached.value;
    this.#deciding ??= (async () => {
      try {
        const value = throttleDecision(await this.#sampleHost(), this.#thresholds);
        const at = this.#now();
        this.#decision = { at, value };
        const last = this.#changes[this.#changes.length - 1];
        if (last === undefined || last.level !== value.level) {
          this.#changes.push({ at, level: value.level, reasons: value.reasons, settleFactor: value.settleFactor });
        }
        return value;
      } finally {
        this.#deciding = undefined;
      }
    })();
    return this.#deciding;
  }

  /** The settle multiplier in force (1 when governance is off or nothing was decided yet). */
  settleFactor(): number {
    if (!this.config.enabled) return 1;
    return this.#decision?.value.settleFactor ?? 1;
  }

  /**
   * Admits one session: the first open session of this process takes a machine slot (waiting up to
   * the admission timeout) under the cap — halved while the host is throttled; later concurrent
   * sessions share it. Release the ticket when the session closes.
   */
  async enter(limits: ResourceLimits = {}): Promise<GovernorTicket> {
    this.#limits = limits;
    const cap = limits.maxBrowsers ?? (this.config.enabled ? this.config.maxBrowsers : undefined);
    if (this.config.enabled) await this.decide();
    if (cap !== undefined && this.#slot === undefined) {
      this.#acquiring ??= (async () => {
        try {
          const level = this.config.enabled ? (this.#decision?.value.level ?? "normal") : "normal";
          const effective = effectiveMaxBrowsers(cap, level);
          const lease = await this.#slots.acquire(effective, this.#now() + this.#admissionTimeoutMs);
          const at = this.#now();
          this.#slot = { ...lease, at };
          this.#slotHistory.push({ at, until: undefined, index: lease.index, waitedMs: lease.waitedMs, cap: effective });
        } finally {
          this.#acquiring = undefined;
        }
      })();
      await this.#acquiring;
    }
    this.#open += 1;
    this.#startTicker();
    let released = false;
    return {
      release: () => {
        if (released) return;
        released = true;
        this.#open -= 1;
        this.#stopTicker();
        if (this.#open > 0) return;
        const slot = this.#slot;
        this.#slot = undefined;
        if (slot !== undefined) {
          slot.release();
          const h = this.#slotHistory[this.#slotHistory.length - 1];
          if (h !== undefined && h.until === undefined) h.until = this.#now();
        }
      },
    };
  }

  /**
   * Watches `page` against its memory ceiling (`limits.memoryCeilingBytes`, else the default when
   * governance is on). Returns the unwatch function; a no-op when no ceiling applies.
   */
  watchMemory(page: MemoryWatchedPage, limits: ResourceLimits = {}): () => void {
    const ceiling = limits.memoryCeilingBytes ?? (this.config.enabled ? this.config.memoryCeilingBytes : null);
    if (ceiling === null || ceiling === undefined) return () => undefined;
    this.#watched.set(page, { ceiling, openedAt: this.#now() });
    this.#startTicker();
    return () => {
      this.#watched.delete(page);
    };
  }

  #startTicker(): void {
    if (this.#timer !== undefined) return;
    if (this.#watched.size === 0 && !(this.config.enabled && this.#open > 0)) return;
    this.#timer = clock.setInterval(() => void this.tick(), this.#intervalMs);
    this.#timer.unref();
  }

  #stopTicker(): void {
    if (this.#timer === undefined || this.#watched.size > 0 || (this.config.enabled && this.#open > 0)) return;
    clock.clearInterval(this.#timer);
    this.#timer = undefined;
  }

  /** One sample (normally on the interval): refreshes the throttle decision and enforces the memory ceiling. */
  async tick(): Promise<void> {
    if (this.#ticking) return;
    this.#ticking = true;
    try {
      if (this.config.enabled) await this.decide().catch(() => undefined);
      for (const page of [...this.#watched.keys()]) if (page.isClosed()) this.#watched.delete(page);
      if (this.#watched.size === 0) {
        this.#stopTicker();
        return;
      }
      const reading = this.#readMemory();
      if (reading === undefined) return;
      const candidates = [...this.#watched].filter(([, w]) => reading.bytes > w.ceiling);
      if (candidates.length === 0) return;
      const victim = candidates.length === 1 ? candidates[0]! : await this.#largestHeap(candidates);
      const [page, w] = victim;
      this.#watched.delete(page);
      const breach: ResourceLimitBreach = {
        kind: "memory",
        measuredBytes: reading.bytes,
        ceilingBytes: w.ceiling,
        metric: reading.metric,
        message:
          `resource limit: this run's browser processes used ${mib(reading.bytes)} (${reading.metric} of ${reading.processes} processes), ` +
          `over the ${mib(w.ceiling)} memory ceiling (--max-browser-memory / JEVITATE_MAX_BROWSER_MEMORY_MB); ` +
          "the session was ended to keep the machine usable — this says nothing about the app's correctness",
      };
      limitedPages.set(page, breach);
      this.#breaches.push({ at: this.#now(), breach });
      // Visible whatever the command: a mission types it (`resource-limit`); any other run sees a closed page.
      process.emitWarning(`jevitate: ${breach.message}`);
      await page.close({ reason: breach.message }).catch(() => undefined);
    } finally {
      this.#ticking = false;
    }
  }

  #readMemory(): BrowserMemoryReading | undefined {
    let reading: BrowserMemoryReading | undefined;
    if (this.#measureMemory !== undefined) {
      reading = this.#measureMemory();
    } else {
      const r = measureOwnBrowserMemory({ ...(this.#roots === undefined ? {} : { roots: this.#roots }) });
      this.#roots = r?.roots;
      reading = r;
    }
    if (reading === undefined) {
      this.#memoryMetric ??= "unavailable";
      return undefined;
    }
    this.#memoryMetric = reading.metric;
    this.#memory.push({ at: this.#now(), bytes: reading.bytes });
    if (this.#memory.length > MAX_MEMORY_SAMPLES) this.#memory.shift();
    return reading;
  }

  /** Among several over-ceiling sessions, the one whose page holds the most JS heap (newest on a tie / no reading). */
  async #largestHeap(candidates: Array<[MemoryWatchedPage, { ceiling: number; openedAt: number }]>): Promise<[MemoryWatchedPage, { ceiling: number; openedAt: number }]> {
    const heapOf = async (page: MemoryWatchedPage): Promise<number> => {
      const read = page
        .evaluate(() => (performance as unknown as { memory?: { usedJSHeapSize: number } }).memory?.usedJSHeapSize ?? -1)
        .catch(() => -1);
      const timeout = new Promise<number>((resolve) => clock.setTimeout(() => resolve(-1), 1_000).unref());
      return Promise.race([read, timeout]);
    };
    const heaps = await Promise.all(candidates.map(([p]) => heapOf(p)));
    let best = 0;
    for (let i = 1; i < candidates.length; i++) {
      if (heaps[i]! > heaps[best]! || (heaps[i] === heaps[best] && candidates[i]![1].openedAt > candidates[best]![1].openedAt)) best = i;
    }
    return candidates[best]!;
  }

  /** What governance did since `sinceMs` (a run's start) — the result's `hostHealth.resources`. */
  snapshot(sinceMs: number, limits: ResourceLimits = this.#limits): ResourceGovernanceSummary {
    const enabled = this.config.enabled;
    const slot = [...this.#slotHistory].reverse().find((h) => h.until === undefined || h.until >= sinceMs);
    const inWindow = this.#changes.filter((c) => c.at >= sinceMs);
    const before = [...this.#changes].reverse().find((c) => c.at < sinceMs);
    const levels = [...(before === undefined ? [] : [before]), ...inWindow];
    const worst = levels.reduce<(typeof levels)[number] | undefined>((w, c) => (w === undefined || LEVEL_RANK[c.level] > LEVEL_RANK[w.level] ? c : w), undefined);
    const peaks = this.#memory.filter((m) => m.at >= sinceMs).map((m) => m.bytes);
    const breach = this.#breaches.find((b) => b.at >= sinceMs)?.breach ?? null;
    const ceiling = limits.memoryCeilingBytes ?? (enabled ? this.config.memoryCeilingBytes : null);
    const cap = limits.maxBrowsers ?? (enabled ? this.config.maxBrowsers : undefined);
    return {
      governance: enabled ? "on" : "off",
      maxBrowsers: slot?.cap ?? cap ?? null,
      machineSlot: slot === undefined ? null : { index: slot.index, waitedMs: slot.waitedMs },
      throttle: enabled && worst !== undefined ? { level: worst.level, reasons: [...worst.reasons], settleFactor: worst.settleFactor } : { level: "normal", reasons: [], settleFactor: 1 },
      throttleChanges: enabled ? inWindow.slice(0, MAX_LISTED_CHANGES).map((c) => ({ at: new Date(c.at).toISOString(), level: c.level, reasons: [...c.reasons] })) : [],
      memoryCeilingBytes: ceiling ?? null,
      peakBrowserMemoryBytes: peaks.length === 0 ? null : Math.max(...peaks),
      memoryMeasurement: ceiling === null || ceiling === undefined ? "off" : (this.#memoryMetric ?? (peaks.length === 0 ? "unavailable" : "pss")),
      resourceLimit: breach,
    };
  }
}

let shared: ResourceGovernor | undefined;

/** The process-wide governor (one per jevitate process), created lazily from the environment. */
export function sharedResourceGovernor(): ResourceGovernor {
  shared ??= new ResourceGovernor();
  return shared;
}

/** The settle multiplier the shared governor has in force (1 = normal; 2 while the host is loaded). */
export function resourceSettleFactor(): number {
  return shared?.settleFactor() ?? 1;
}
