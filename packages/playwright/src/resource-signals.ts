/**
 * Host resource signals for admission control. Solution-agnostic: nothing here
 * knows what is being browsed — only whether the machine can afford ONE more
 * browser context right now.
 *
 * Every platform reads different kernel/OS interfaces (see the per-platform
 * readers); they are normalised into one `ResourceSample` so the pool's
 * admission gate is platform-free. Each sample says honestly WHERE its numbers
 * came from (`source`) and WHAT each number means (`cpuMetric`/`memMetric`), so
 * a fallback is always visible and thresholds are applied per metric — a PSI
 * stall percentage and a load-per-core ratio are not the same quantity.
 */

/**
 * What a `cpuPressure` / `memPressure` number measures. Every value is a
 * percentage (0–100, load-per-core may exceed 100) so thresholds read alike.
 *
 *  - `psi-cpu-some-avg10`: % of the last 10s some task stalled on CPU (Linux PSI).
 *  - `psi-memory-full-avg10`: % of the last 10s ALL non-idle tasks stalled on memory (Linux PSI).
 *  - `loadavg1-per-core`: 1-minute load average / logical cores × 100 (Linux fallback, macOS).
 *  - `cpu-busy-delta`: busy share of all cores over a short sampling window, from `os.cpus()` times (Windows).
 *  - `vm-pressure-level`: macOS `kern.memorystatus_vm_pressure_level` mapped normal=0, warn=50, critical=100.
 */
export type CpuMetric = "psi-cpu-some-avg10" | "loadavg1-per-core" | "cpu-busy-delta";
export type MemMetric = "psi-memory-full-avg10" | "vm-pressure-level";

export interface ResourceSample {
  /** Present unless the platform has no usable CPU signal. Percentage; see `cpuMetric`. */
  readonly cpuPressure?: number;
  readonly cpuMetric?: CpuMetric;
  /** Present only where the OS exposes memory PRESSURE (not just free bytes). See `memMetric`. */
  readonly memPressure?: number;
  readonly memMetric?: MemMetric;
  /** Memory a new context could use right now, bounded by any cgroup limit. Always present. */
  readonly memAvailableBytes: number;
  /** Human-readable provenance, e.g. `linux-psi+meminfo` or `linux-loadavg+meminfo (psi unavailable: …)`. */
  readonly source: string;
}

export interface ResourceSignals {
  sample(): Promise<ResourceSample>;
}

/** Thrown when a signal that MUST exist cannot be read or parsed. Never swallowed into a guess. */
export class ResourceSignalError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "ResourceSignalError";
  }
}

/** Code of a Node system error, or undefined. */
export function errnoCode(err: unknown): string | undefined {
  if (typeof err !== "object" || err === null || !("code" in err)) return undefined;
  const code = err.code;
  return typeof code === "string" ? code : undefined;
}

/** Parses `avg10=` of the named line (`some`/`full`) from a PSI file. Throws on malformed input. */
export function parsePsiAvg10(text: string, line: "some" | "full", path: string): number {
  for (const raw of text.split("\n")) {
    const fields = raw.trim().split(/\s+/);
    if (fields[0] !== line) continue;
    for (const field of fields.slice(1)) {
      const [key, value] = field.split("=");
      if (key !== "avg10" || value === undefined) continue;
      const n = Number(value);
      if (!Number.isFinite(n)) throw new ResourceSignalError(`malformed PSI ${line} avg10 in ${path}: ${JSON.stringify(raw)}`);
      return n;
    }
    throw new ResourceSignalError(`PSI ${line} line in ${path} has no avg10: ${JSON.stringify(raw)}`);
  }
  throw new ResourceSignalError(`PSI file ${path} has no "${line}" line`);
}

/** Parses a `/proc/meminfo` key (kB) into bytes. Throws when absent — MemAvailable is required. */
export function parseMeminfoBytes(text: string, key: string): number {
  const match = new RegExp(`^${key}:\\s+(\\d+)\\s+kB$`, "m").exec(text);
  if (match === null) throw new ResourceSignalError(`/proc/meminfo has no ${key} line`);
  return Number(match[1]) * 1024;
}
