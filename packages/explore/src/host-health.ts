import { availableParallelism } from "node:os";
import { monitorEventLoopDelay } from "node:perf_hooks";
import type { DegradedFindingKind, EnvironmentDegraded, HostHealthSummary } from "@jevitate/domain";
import { hostProbe, type HostPressure, type HostProbe } from "./host-pressure.js";
import type { TranscriptEntry } from "./transcript.js";
import { clock } from "@jevitate/domain";

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
 *     machine, not one slow route) — #368: only when a host sample in the window corroborates it.
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

/**
 * #452: a cheap CDP round-trip (`Browser.getVersion`) is sub-millisecond-to-tens-of-ms on a healthy
 * host; one that takes over a second means the browser process was not scheduled (or is wedged) —
 * the same "late reply" evidence as event-loop lag, measured on the browser's side of the pipe.
 */
export const STARVED_CDP_LATENCY_MS = 1_000;
/** A CDP probe with no reply in this long is recorded as this latency (the browser is unresponsive). */
export const CDP_PROBE_TIMEOUT_MS = 5_000;

/**
 * #213: the event-loop delay histogram also measures the driver's OWN synchronous work (a big
 * snapshot diff, a JSON write) — 506ms of lag at 0.70 load/core is self-inflicted, not the host.
 * Lag counts as starvation only when the CPU corroborates it: at least one runnable task per core
 * (load/core ≥ 1), i.e. no idle core the driver could have run on. With spare cores (or no load
 * reading) lag alone never blames the host.
 */
export const LAG_CORROBORATING_LOAD_PER_CORE = 1;

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
 * #368: a render slowdown is a SYMPTOM, not host evidence — a slow backend, a page that waits on a
 * reply that never comes, or a genuinely slow route slow every render down on an idle machine too.
 * It counts as starvation only when the host corroborates it like event-loop lag does (#213): a
 * sample inside `STARVATION_WINDOW_MS` at ≥ this load per core (no idle core). On a healthy host a
 * slow render is the app's timing (reported in `hostHealth.slowestRenderMs` and the timing summary),
 * never "the host was starved"; a hang or no-progress it causes is judged as an app finding.
 */
const RENDER_CORROBORATING_LOAD_PER_CORE = LAG_CORROBORATING_LOAD_PER_CORE;

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
  /**
   * #452: the round-trip (ms) of a cheap CDP command to the run's browser; `undefined` = no reading.
   * Default: none until `attachCdpProbe` (the CLI attaches the run's browser once it is open).
   */
  readonly cdpLatencyMs?: () => Promise<number | undefined>;
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
  readonly cdpMs: number | undefined;
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
function starvationOf(host: HostPressure, lagMs: number, cdpMs?: number): string | null {
  if (host.overThreshold !== null) return `host over threshold: ${host.overThreshold}`;
  if (cdpMs !== undefined && cdpMs > STARVED_CDP_LATENCY_MS) return `CDP round-trip ${Math.round(cdpMs)}ms > ${STARVED_CDP_LATENCY_MS}ms`;
  if (host.loadPerCore !== undefined && host.loadPerCore > STARVED_LOAD_PER_CORE) {
    return `load ${fmt(host.loadPerCore)}/core > ${STARVED_LOAD_PER_CORE}`;
  }
  if (lagMs > STARVED_EVENT_LOOP_LAG_MS && host.loadPerCore !== undefined && host.loadPerCore >= LAG_CORROBORATING_LOAD_PER_CORE) {
    return `driver event-loop lag ${Math.round(lagMs)}ms > ${STARVED_EVENT_LOOP_LAG_MS}ms at load ${fmt(host.loadPerCore)}/core`;
  }
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
  /** Distinct starvation causes, one per KIND of signal (#213: never one entry per load reading). */
  readonly #causes = new Map<string, string>();
  #timer: ReturnType<typeof setInterval> | undefined;
  #count = 0;
  #peakLoad: number | null = null;
  #minFree: number | null = null;
  #peakLag: number | null = null;
  #peakCdp: number | null = null;
  #cdp: (() => Promise<number | undefined>) | undefined;
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
    this.#cdp = opts.cdpLatencyMs;
    this.#now = opts.now ?? clock.now;
    this.#intervalMs = opts.intervalMs ?? HOST_SAMPLE_INTERVAL_MS;
    this.#attribute = opts.attribute ?? starvationAttributionFromEnv();
    this.#cores = opts.cores ?? availableParallelism();
  }

  /** #452: takes the CDP round-trip probe of the run's browser (once it is open). */
  attachCdpProbe(probe: () => Promise<number | undefined>): void {
    this.#cdp = probe;
  }

  /** One bounded CDP reading: a probe with no reply in `CDP_PROBE_TIMEOUT_MS` reads as that timeout. */
  async #measureCdp(): Promise<number | undefined> {
    const probe = this.#cdp;
    if (probe === undefined) return undefined;
    let timer: ReturnType<typeof clock.setTimeout> | undefined;
    try {
      return await Promise.race([
        probe().catch(() => undefined),
        new Promise<number>((resolve) => {
          timer = clock.setTimeout(() => resolve(CDP_PROBE_TIMEOUT_MS), CDP_PROBE_TIMEOUT_MS);
        }),
      ]);
    } finally {
      if (timer !== undefined) clock.clearTimeout(timer);
    }
  }

  /** Starts background sampling (never keeps the process alive). Idempotent. */
  start(): this {
    if (this.#timer === undefined && this.#intervalMs > 0) {
      this.#timer = clock.setInterval(() => void this.sample(), this.#intervalMs);
      this.#timer.unref();
    }
    return this;
  }

  /** Stops background sampling and releases the event-loop monitor. */
  stop(): void {
    if (this.#timer !== undefined) clock.clearInterval(this.#timer);
    this.#timer = undefined;
    this.#disposeLag();
  }

  /** Takes one host sample now and records it. Never throws (`hostProbe` reports its own errors). */
  async sample(): Promise<HostJudgment> {
    const host = await this.#probe();
    const lagMs = this.#lag();
    const cdpMs = await this.#measureCdp();
    const starved = this.#attribute ? starvationOf(host, lagMs, cdpMs) : null;
    this.#record({ at: this.#now(), host, lagMs, cdpMs, starved });
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
    let corroborating: number | null = null;
    for (let i = this.#samples.length - 1; i >= 0; i--) {
      const s = this.#samples[i]!;
      if (s.at < since) break;
      if (s.starved !== null) return s.starved;
      const load = s.host.loadPerCore;
      if (load !== undefined && load >= RENDER_CORROBORATING_LOAD_PER_CORE) corroborating = Math.max(corroborating ?? 0, load);
    }
    // #368: a slow render alone never blames the host — only with load corroborating it.
    if (corroborating === null) return null;
    const trend = this.#renderTrend();
    return trend === null ? null : `${trend} at load ${fmt(corroborating)}/core`;
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
    this.#noteCause(starved);
    if (!entry.actOk && entry.origin !== "engine" && entry.op !== null && /timeout/i.test(entry.reason ?? "")) {
      this.markDegraded({ finding: "click-timeout", detail: entry.reason ?? "", step: entry.step }, starved);
    }
  }

  /** Records a finding the host's starvation explains (advisory; never a defect/hang). */
  markDegraded(f: { readonly finding: DegradedFindingKind; readonly detail: string; readonly step?: number }, cause: string): void {
    this.#noteCause(cause);
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
      ...(this.#cdp === undefined ? {} : { peakCdpLatencyMs: this.#peakCdp }),
      slowestRenderMs: renders.length === 0 ? null : Math.max(...renders),
      baselineRenderMs: renders.length === 0 ? null : median(renders.slice(0, RENDER_BASELINE_RENDERS)),
      steps: this.#steps,
      degradedSteps: this.#degradedSteps,
      degraded: this.degraded,
      starvation: [...this.#causes.values()].slice(0, MAX_LISTED_CAUSES),
      attribution: this.#attribute ? "on" : "off",
    };
  }

  /** Keeps the first cause of each kind (`load …/core`, `driver event-loop lag …`): readings differ, the kind does not. */
  #noteCause(cause: string): void {
    const kind = cause.replace(/\d+(?:\.\d+)?/g, "#");
    if (!this.#causes.has(kind)) this.#causes.set(kind, cause);
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
    if (s.cdpMs !== undefined) this.#peakCdp = Math.max(this.#peakCdp ?? 0, s.cdpMs);
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

/** One sentence naming the host's peak readings (#213: never a list of per-sample readings). */
export function starvedHostSentence(health: HostHealthSummary): string {
  const peaks: string[] = [];
  if (health.peakLoadPerCore !== null) peaks.push(`peak load ${fmt(health.peakLoadPerCore)}/core`);
  if (health.minFreeMemoryBytes !== null) peaks.push(`min free memory ${Math.round(health.minFreeMemoryBytes / 1024 ** 2)} MiB`);
  // Lag and renders only when they were a starvation-sized reading (a 2ms lag is noise, not evidence).
  if (health.peakEventLoopLagMs !== null && health.peakEventLoopLagMs > STARVED_EVENT_LOOP_LAG_MS) {
    peaks.push(`peak driver event-loop lag ${Math.round(health.peakEventLoopLagMs)}ms`);
  }
  if (health.peakCdpLatencyMs != null && health.peakCdpLatencyMs > STARVED_CDP_LATENCY_MS) {
    peaks.push(`peak CDP round-trip ${Math.round(health.peakCdpLatencyMs)}ms`);
  }
  if (
    health.slowestRenderMs !== null &&
    health.baselineRenderMs !== null &&
    health.slowestRenderMs >= RENDER_SLOWDOWN_FLOOR_MS &&
    health.slowestRenderMs >= RENDER_SLOWDOWN_FACTOR * health.baselineRenderMs
  ) {
    peaks.push(`slowest render ${Math.round(health.slowestRenderMs)}ms vs a ${Math.round(health.baselineRenderMs)}ms baseline`);
  }
  return `${health.degradedSteps}/${health.steps} steps ran on a starved host${peaks.length === 0 ? "" : ` (${peaks.join(", ")})`}`;
}

/**
 * The run-level verdict rule (#203): a run most of whose steps ran on a starved host proved nothing,
 * so an outcome that would read as a pass or an app-level "could not" (`clean`, a goal's
 * `exhausted`/`blocked`/`failed`) becomes `inconclusive` with reason `degraded-environment`. A confirmed
 * defect, a `succeeded` goal (a positive proof holds whatever the host), a crash or an already
 * inconclusive run keep their outcome.
 *
 * `opts.verified` (#213): the ending was proven by code (a usability job whose completion the
 * independent checks / save signals verified) — a positive proof, kept like a `succeeded` goal.
 * `opts.wouldHaveBeen` (#213): the ending's own reason (e.g. the failed success check) — kept in the
 * degraded reason, so a starved `failed` goal still names the check that did not hold.
 */
export function degradedEnvironmentOutcome<O extends string>(
  outcome: O,
  health: HostHealthSummary,
  opts: { readonly verified?: boolean; readonly wouldHaveBeen?: string } = {},
): { readonly outcome: O | "inconclusive"; readonly failure?: { kind: "degraded-environment"; message: string } } {
  // #209: a goal's `failed` (a check missed after the model's done) is a miss a starved host can cause too.
  const overridable = outcome === "clean" || outcome === "exhausted" || outcome === "blocked" || outcome === "failed";
  if (!health.degraded || !overridable || opts.verified === true) return { outcome };
  const own = opts.wouldHaveBeen === undefined || opts.wouldHaveBeen === "" ? "" : `; otherwise it would have ended ${outcome}: ${opts.wouldHaveBeen}`;
  return {
    outcome: "inconclusive",
    failure: {
      kind: "degraded-environment",
      message: `${starvedHostSentence(health)}, so the run proves nothing about the app${own}`,
    },
  };
}

/** Failure kinds that mean the run STALLED (#452): nothing answered in time. */
const STALL_FAILURE_KINDS: ReadonlySet<string> = new Set(["stalled", "target-unresponsive"]);

/** True when a run's failure is a stall: a watchdog close, an unanswered navigation, or a bare timeout. */
export function isStallFailure(failure: { readonly kind: string; readonly message: string } | undefined): boolean {
  if (failure === undefined) return false;
  return STALL_FAILURE_KINDS.has(failure.kind) || (failure.kind === "exception" && /timeout/i.test(failure.message.split("\n")[0] ?? ""));
}

/** The measurements in a run's host health that show starvation (#452); empty = the host looked healthy. */
export function starvationMeasurements(health: HostHealthSummary): string[] {
  const out: string[] = [];
  if (health.peakCdpLatencyMs != null && health.peakCdpLatencyMs > STARVED_CDP_LATENCY_MS) {
    out.push(`CDP command round-trip peaked at ${Math.round(health.peakCdpLatencyMs)}ms (> ${STARVED_CDP_LATENCY_MS}ms)`);
  }
  if (health.peakEventLoopLagMs !== null && health.peakEventLoopLagMs > STARVED_EVENT_LOOP_LAG_MS) {
    out.push(`driver event-loop lag peaked at ${Math.round(health.peakEventLoopLagMs)}ms (> ${STARVED_EVENT_LOOP_LAG_MS}ms)`);
  }
  if (
    health.slowestRenderMs !== null &&
    health.baselineRenderMs !== null &&
    health.slowestRenderMs >= RENDER_SLOWDOWN_FLOOR_MS &&
    health.slowestRenderMs >= RENDER_SLOWDOWN_FACTOR * health.baselineRenderMs
  ) {
    out.push(`page load ${Math.round(health.slowestRenderMs)}ms vs the run's own ${Math.round(health.baselineRenderMs)}ms baseline (>=${RENDER_SLOWDOWN_FACTOR}x)`);
  }
  for (const cause of health.starvation) if (!out.some((o) => o.startsWith(cause))) out.push(cause);
  return out;
}

/**
 * #452 — the verdict rule for a STALLED run: when the run stalled (`isStallFailure`) and its host signals
 * show starvation (event-loop lag, CDP latency, page loads far past the run's baseline, a starved
 * sample), the stall is the host's, not the app's: failure kind `host-starved`, the measurements in
 * the message. Anything else keeps its own failure.
 */
export function hostStarvedFailure(
  failure: { readonly kind: string; readonly message: string } | undefined,
  health: HostHealthSummary,
): { readonly kind: "host-starved"; readonly message: string } | undefined {
  if (failure === undefined || health.attribution === "off" || !isStallFailure(failure)) return undefined;
  const measurements = starvationMeasurements(health);
  if (measurements.length === 0) return undefined;
  const what = failure.message.split("\n")[0]!.slice(0, 200);
  return {
    kind: "host-starved",
    message: `the run stalled (${failure.kind}: ${what}) while the host was starved: ${measurements.join("; ")} — not an app finding`,
  };
}
