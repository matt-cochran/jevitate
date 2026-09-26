import { availableParallelism, loadavg, platform } from "node:os";
import {
  DEFAULT_CONTEXT_MEMORY_BYTES,
  DEFAULT_PRESSURE_THRESHOLDS,
  admissionViolation,
  createResourceSignals,
  type PressureThresholds,
  type ResourceSample,
  type ResourceSignals,
} from "@jevitate/playwright";

/**
 * The HOST's resource pressure at the moment a hang or crash is detected: the same sample
 * admission control takes (PSI / cgroup / meminfo on Linux and WSL, the portable fallback
 * elsewhere), judged against the same thresholds. A main-thread-unresponsive page or a navigation
 * timeout on a host that was itself starved says nothing certain about the app, so attribution
 * uses this (see `attributeCrash`).
 */
export interface HostPressure {
  /** The raw sample (null when the host could not be sampled). */
  readonly sample: ResourceSample | null;
  /** The threshold the host was over, described; null when it was within all of them. */
  readonly overThreshold: string | null;
  /** Why the host could not be sampled. */
  readonly error?: string;
  /**
   * 1-minute load average per logical core (#203), when the platform has one (not Windows, whose
   * `os.loadavg()` is always zeros). Independent of which CPU metric `sample` carries.
   */
  readonly loadPerCore?: number;
}

export type HostProbe = () => Promise<HostPressure>;

/** This host's 1-minute load average per logical core; `undefined` where there is none (Windows). */
export function defaultLoadPerCore(): number | undefined {
  if (platform() === "win32") return undefined;
  return loadavg()[0]! / Math.max(1, availableParallelism());
}

/** A probe over `signals` (default: this platform's), judged like admission control judges. */
export function hostProbe(
  signals: ResourceSignals = createResourceSignals(),
  thresholds: PressureThresholds = DEFAULT_PRESSURE_THRESHOLDS,
  minMemAvailableBytes: number = DEFAULT_CONTEXT_MEMORY_BYTES,
  loadPerCore: () => number | undefined = defaultLoadPerCore,
): HostProbe {
  return async () => {
    const load = loadPerCore();
    const withLoad = load === undefined ? {} : { loadPerCore: load };
    try {
      const sample = await signals.sample();
      return { sample, overThreshold: admissionViolation(sample, thresholds, minMemAvailableBytes) ?? null, ...withLoad };
    } catch (e) {
      return { sample: null, overThreshold: null, error: e instanceof Error ? e.message : String(e), ...withLoad };
    }
  };
}
