import { availableParallelism } from "node:os";
import { monitorEventLoopDelay } from "node:perf_hooks";
import type { DegradedFindingKind, EnvironmentDegraded, HostHealthSummary } from "@jevitate/domain";
import { hostProbe, type HostPressure, type HostProbe } from "./host-pressure.js";
import type { TranscriptEntry } from "./transcript.js";

/**
 * Host-health sampling for one run (#203) — telling a STARVED HOST apart from an app finding.
 *
 * On a saturated machine (parallel builds, a busy CI runner, a laptop on battery) a run produces
 * "findings" that are really environment starvation: a `ui-no-progress` hang that reproduces 0/N, a
 * `locator.click: Timeout 5000ms`, a dev server that renders slowly, a coverage frontier "exhausted"
 * after one state. One sampler per run watches four independent signals and says, around any such
 * finding, whether the host was starved at the time:
 *
 *  1. the admission sample the browser pool already judges (PSI / cgroup / meminfo, the free-memory
 *     floor — `hostProbe`'s `overThreshold`);
 *  2. the 1-minute load average per core;
 *  3. the DRIVER's own event-loop lag (this process — a late timer is a late CDP reply);
 *  4. the run's render trend against its OWN baseline (every page slowing down together is the
 *     machine, not one slow route).
 *
 * A finding met while starved is `environment-degraded`: advisory, never a defect/hang finding,
 * never failing the run. A run most of whose steps ran starved proved nothing: its caller reports it
 * `inconclusive` (reason `degraded-environment`), never `clean`.
 *
 * Every probe is injectable (`HostHealthOptions`), so tests starve a DETERMINISTIC fake host instead
 * of the real machine.
 */

/**
 * Load per core above which the host counts as starved. Load average counts RUNNABLE tasks: at 2 per
 * core every task gets at most half a core, so a browser renderer and the driver both run at ≤50%
 * speed — Playwright's fixed action timeouts (5s) and the settle windows then measure the queue, not
 * the app. (Below 2 a busy runner is still healthy: admission control keeps load advisory for the same
 * reason — GitHub macOS runners idle near 2x cores.)
 */
export const STARVED_LOAD_PER_CORE = 2;

/**
 * Driver event-loop lag above which the host counts as starved. The settle rule's quiet window is
 * ~500ms and a CDP round-trip is normally sub-millisecond; a driver whose own timers fire half a
 * second late cannot tell "the page did nothing" from "we were not scheduled".
 */
export const STARVED_EVENT_LOOP_LAG_MS = 500;

/** Renders that form the run's own baseline (the median of the first few, before any trend is judged). */
export const RENDER_BASELINE_RENDERS = 3;
/** Recent renders the trend looks at (their median — one slow route alone is never "the host"). */
export const RENDER_TREND_RENDERS = 3;
/**
 * A sustained render slowdown counts as starvation when the recent median is at least this many
 * times the baseline AND over `RENDER_SLOWDOWN_FLOOR_MS`. 5x across several consecutive pages is far
 * beyond route-to-route variance of one app; the floor keeps a 20ms→120ms jitter from counting.
 */
export const RENDER_SLOWDOWN_FACTOR = 5;
export const RENDER_SLOWDOWN_FLOOR_MS = 3_000;

/**
 * How long a starved sample explains what happens after it. Load average is itself a 1-minute
 * moving average and PSI a 10s one; 15s covers one Playwright action timeout plus its settle wait.
 */
export const STARVATION_WINDOW_MS = 15_000;

/** Background sampling interval — often enough that every step has a sample inside the window. */
export const HOST_SAMPLE_INTERVAL_MS = 2_000;

/** A run whose starved steps exceed this share proved nothing (`inconclusive: degraded-environment`). */
export const DEGRADED_STEP_MAJORITY = 0.5;

/** Distinct starvation causes kept in the summary. */
const MAX_LISTED_CAUSES = 5;

/**
 * `JEVITATE_HOST_STARVATION=off` samples and reports `hostHealth` but never attributes a finding to
 * the host — for a harness that guarantees a quiet host itself (jevitate's own test suite sets it, so
 * its unrelated tests never flip on a loaded CI box).
 */
export function starvationAttributionFromEnv(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.JEVITATE_HOST_STARVATION !== "off";
}

export interface HostHealthOptions {
  /** The host sample (admission thresholds + load per core). Default: this platform's `hostProbe()`. */
  readonly probe?: HostProbe;
  /** The driver's max event-loop delay (ms) since the previous call. Default: `perf_hooks` histogram. */
  readonly eventLoopLagMs?: () => number;
  readonly now?: () => number;
  /** Background sampling interval (`start()`); 0 disables it. Default `HOST_SAMPLE_INTERVAL_MS`. */
  readonly intervalMs?: number;
  /** Attribute findings to a starved host. Default: `starvationAttributionFromEnv()`. */
  readonly attribute?: boolean;
  readonly cores?: number;
}

interface HealthSample {
  readonly at: number;
  readonly host: HostPressure;
  readonly lagMs: number;
  readonly starved: string | null;
}

/** What `judge()` returns: the fresh host sample (evidence) and why the host is starved, if it is. */
export interface HostJudgment {
  readonly host: HostPressure;
  readonly starved: string | null;
}

const median = (xs: readonly number[]): number => {
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 === 1 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
};
const fmt = (n: number): string => (Number.isInteger(n) ? String(n) : n.toFixed(2));

/** A step's render time: DOMContentLoaded for a navigation, the settle time for an in-page transition. */
function renderMsOf(entry: TranscriptEntry): number | undefined {
  const t = entry.timing;
  if (t === undefined) return undefined;
  return t.navigation?.domContentLoadedMs ?? t.settleMs;
}

/** Why one sample counts as starved, or null. */
function starvationOf(host: HostPressure, lagMs: number): string | null {
  if (host.overThreshold !== null) return `host over threshold: ${host.overThreshold}`;
  if (host.loadPerCore !== undefined && host.loadPerCore > STARVED_LOAD_PER_CORE) {
    return `load ${fmt(host.loadPerCore)}/core > ${STARVED_LOAD_PER_CORE}`;
  }
  if (lagMs > STARVED_EVENT_LOOP_LAG_MS) return `driver event-loop lag ${Math.round(lagMs)}ms > ${STARVED_EVENT_LOOP_LAG_MS}ms`;
  return null;
}

export class HostHealthSampler {
  readonly #probe: HostProbe;
  readonly #lag: () => number;
  readonly #disposeLag: () => void;
  readonly #now: () => number;
  readonly #intervalMs: number;
  readonly #attribute: boolean;
  readonly #cores: number;
  readonly #samples: HealthSample[] = [];
  readonly #renders: number[] = [];
  readonly #findings: EnvironmentDegraded[] = [];
  readonly #causes = new Set<string>();
  #timer: ReturnType<typeof setInterval> | undefined;
  #count = 0;
  #peakLoad: number | null = null;
  #minFree: number | null = null;
  #peakLag: number | null = null;
  #steps = 0;
  #degradedSteps = 0;

  constructor(opts: HostHealthOptions = {}) {
    this.#probe = opts.probe ?? hostProbe();
    if (opts.eventLoopLagMs !== undefined) {
      this.#lag = opts.eventLoopLagMs;
      this.#disposeLag = () => undefined;
    } else {
      const h = monitorEventLoopDelay({ resolution: 20 });
      h.enable();
      this.#lag = () => {
        const ms = h.max / 1e6;
        h.reset();
        return ms;
      };
      this.#disposeLag = () => h.disable();
    }
    this.#now = opts.now ?? Date.now;
    this.#intervalMs = opts.intervalMs ?? HOST_SAMPLE_INTERVAL_MS;
    this.#attribute = opts.attribute ?? starvationAttributionFromEnv();
    this.#cores = opts.cores ?? availableParallelism();
  }

  /** Starts background sampling (never keeps the process alive). Idempotent. */
  start(): this {
    if (this.#timer === undefined && this.#intervalMs > 0) {
      this.#timer = setInterval(() => void this.sample(), this.#intervalMs);
      this.#timer.unref();
    }
    return this;
  }

  /** Stops background sampling and releases the event-loop monitor. */
  stop(): void {
    if (this.#timer !== undefined) clearInterval(this.#timer);
    this.#timer = undefined;
    this.#disposeLag();
  }

  /** Takes one host sample now and records it. Never throws (`hostProbe` reports its own errors). */
  async sample(): Promise<HostJudgment> {
    const host = await this.#probe();
    const lagMs = this.#lag();
    const starved = this.#attribute ? starvationOf(host, lagMs) : null;
    this.#record({ at: this.#now(), host, lagMs, starved });
    return { host, starved };
  }

  /**
   * Around a finding: samples the host now, and says why it is starved — this sample, any starved
   * sample inside `STARVATION_WINDOW_MS`, or a run-wide render slowdown. `starved: null` = healthy.
   */
  async judge(): Promise<HostJudgment> {
    const { host } = await this.sample();
    return { host, starved: this.starvedNow() };
  }

  /** Why the host is starved right now, from the samples already taken (no new sample). */
  starvedNow(): string | null {
    if (!this.#attribute) return null;
    const since = this.#now() - STARVATION_WINDOW_MS;
    for (let i = this.#samples.length - 1; i >= 0; i--) {
      const s = this.#samples[i]!;
      if (s.at < since) break;
      if (s.starved !== null) return s.starved;
    }
    return this.#renderTrend();
  }

  /**
   * One recorded transcript step (every strategy's runner routes its entries here): counts it as
   * starved or not, feeds the render trend, and marks a timed-out action met while starved as an
   * `environment-degraded` click timeout.
   */
  noteStep(entry: TranscriptEntry): void {
    const render = renderMsOf(entry);
    if (render !== undefined) this.#renders.push(render);
    this.#steps += 1;
    const starved = this.starvedNow();
    if (starved === null) return;
    this.#degradedSteps += 1;
    this.#causes.add(starved);
    if (!entry.actOk && entry.origin !== "engine" && entry.op !== null && /timeout/i.test(entry.reason ?? "")) {
      this.markDegraded({ finding: "click-timeout", detail: entry.reason ?? "", step: entry.step }, starved);
    }
  }

  /** Records a finding the host's starvation explains (advisory; never a defect/hang). */
  markDegraded(f: { readonly finding: DegradedFindingKind; readonly detail: string; readonly step?: number }, cause: string): void {
    this.#causes.add(cause);
    this.#findings.push({
      kind: "environment-degraded",
      finding: f.finding,
      detail: f.detail.split("\n")[0]!.slice(0, 300),
      cause,
      ...(f.step === undefined ? {} : { step: f.step }),
      advisory: true,
    });
  }

  /** The findings marked `environment-degraded` so far. */
  findings(): EnvironmentDegraded[] {
    return [...this.#findings];
  }

  /** Most recorded steps ran on a starved host (`DEGRADED_STEP_MAJORITY`). */
  get degraded(): boolean {
    return this.#steps > 0 && this.#degradedSteps / this.#steps > DEGRADED_STEP_MAJORITY;
  }

  summary(): HostHealthSummary {
    const renders = this.#renders;
    return {
      samples: this.#count,
      cores: this.#cores,
      peakLoadPerCore: this.#peakLoad,
      minFreeMemoryBytes: this.#minFree,
      peakEventLoopLagMs: this.#peakLag,
      slowestRenderMs: renders.length === 0 ? null : Math.max(...renders),
      baselineRenderMs: renders.length === 0 ? null : median(renders.slice(0, RENDER_BASELINE_RENDERS)),
      steps: this.#steps,
      degradedSteps: this.#degradedSteps,
      degraded: this.degraded,
      starvation: [...this.#causes].slice(0, MAX_LISTED_CAUSES),
      attribution: this.#attribute ? "on" : "off",
    };
  }

  #record(s: HealthSample): void {
    this.#count += 1;
    this.#samples.push(s);
    // Only the window matters for judging; the peaks are kept separately.
    const since = s.at - STARVATION_WINDOW_MS;
    while (this.#samples.length > 1 && this.#samples[0]!.at < since) this.#samples.shift();
    const load = s.host.loadPerCore;
    if (load !== undefined) this.#peakLoad = Math.max(this.#peakLoad ?? 0, load);
    const free = s.host.sample?.memAvailableBytes;
    if (free !== undefined) this.#minFree = Math.min(this.#minFree ?? Number.POSITIVE_INFINITY, free);
    this.#peakLag = Math.max(this.#peakLag ?? 0, s.lagMs);
  }

  #renderTrend(): string | null {
    const r = this.#renders;
    if (r.length < RENDER_BASELINE_RENDERS + RENDER_TREND_RENDERS) return null;
    const baseline = median(r.slice(0, RENDER_BASELINE_RENDERS));
    const recent = median(r.slice(-RENDER_TREND_RENDERS));
    if (recent < RENDER_SLOWDOWN_FLOOR_MS || recent < RENDER_SLOWDOWN_FACTOR * baseline) return null;
    return `renders ${Math.round(recent)}ms vs the run's baseline ${Math.round(baseline)}ms (>=${RENDER_SLOWDOWN_FACTOR}x)`;
  }
}

/**
 * The run-level verdict rule (#203): a run most of whose steps ran on a starved host proved nothing,
 * so an outcome that would read as a pass or an app-level "could not" (`clean`, a goal's
 * `exhausted`/`blocked`/`failed`) becomes `inconclusive` with reason `degraded-environment`. A confirmed
 * defect, a `succeeded` goal (a positive proof holds whatever the host), a crash or an already
 * inconclusive run keep their outcome.
 */
export function degradedEnvironmentOutcome<O extends string>(
  outcome: O,
  health: HostHealthSummary,
): { readonly outcome: O | "inconclusive"; readonly failure?: { kind: "degraded-environment"; message: string } } {
  // #209: a goal's `failed` (a check missed after the model's done) is a miss a starved host can cause too.
  const overridable = outcome === "clean" || outcome === "exhausted" || outcome === "blocked" || outcome === "failed";
  if (!health.degraded || !overridable) return { outcome };
  const causes = health.starvation.length === 0 ? "" : `: ${health.starvation.join("; ")}`;
  return {
    outcome: "inconclusive",
    failure: {
      kind: "degraded-environment",
      message: `degraded-environment — ${health.degradedSteps}/${health.steps} steps ran on a starved host${causes}; a starved run proves nothing about the app`,
    },
  };
}
