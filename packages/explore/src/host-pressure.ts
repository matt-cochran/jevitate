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
}

export type HostProbe = () => Promise<HostPressure>;

/** A probe over `signals` (default: this platform's), judged like admission control judges. */
export function hostProbe(
  signals: ResourceSignals = createResourceSignals(),
  thresholds: PressureThresholds = DEFAULT_PRESSURE_THRESHOLDS,
  minMemAvailableBytes: number = DEFAULT_CONTEXT_MEMORY_BYTES,
): HostProbe {
  return async () => {
    try {
      const sample = await signals.sample();
      return { sample, overThreshold: admissionViolation(sample, thresholds, minMemAvailableBytes) ?? null };
    } catch (e) {
      return { sample: null, overThreshold: null, error: e instanceof Error ? e.message : String(e) };
    }
  };
}
