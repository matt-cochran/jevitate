import { cpus, freemem, type CpuInfo } from "node:os";
import { setTimeout as sleep } from "node:timers/promises";
import { ResourceSignalError, type ResourceSample, type ResourceSignals } from "./resource-signals.js";

/**
 * Windows signals. `os.loadavg()` is ALWAYS [0, 0, 0] on Windows, so it is
 * never consulted here (it would read as "idle" forever).
 *
 *  - CPU: busy share of all logical cores over a short window, from two
 *    `os.cpus()` snapshots (1 − Δidle / Δtotal) × 100.
 *  - Memory available: `os.freemem()` — on Windows this is available physical
 *    memory (GlobalMemoryStatusEx ullAvailPhys), which is the right number.
 *  - Memory pressure: Windows exposes no PSI equivalent through Node; omitted.
 */
export interface Win32SignalDeps {
  readonly cpus: () => CpuInfo[];
  readonly freemem: () => number;
  readonly sleep: (ms: number) => Promise<unknown>;
  /** Sampling window between the two `cpus()` snapshots. */
  readonly windowMs: number;
}

export const defaultWin32SignalDeps: Win32SignalDeps = {
  cpus,
  freemem,
  sleep: (ms) => sleep(ms),
  windowMs: 250,
};

function totals(snapshot: readonly CpuInfo[]): { idle: number; total: number } {
  let idle = 0;
  let total = 0;
  for (const { times } of snapshot) {
    idle += times.idle;
    total += times.user + times.nice + times.sys + times.idle + times.irq;
  }
  return { idle, total };
}

/** Busy % between two `os.cpus()` snapshots. Throws when the window measured nothing. */
export function cpuBusyPercent(before: readonly CpuInfo[], after: readonly CpuInfo[]): number {
  if (before.length === 0 || before.length !== after.length) {
    throw new ResourceSignalError(`os.cpus() snapshots unusable (${before.length} → ${after.length} cores)`);
  }
  const a = totals(before);
  const b = totals(after);
  const dTotal = b.total - a.total;
  const dIdle = b.idle - a.idle;
  if (dTotal <= 0) throw new ResourceSignalError("os.cpus() times did not advance over the sampling window");
  return Math.min(100, Math.max(0, (1 - dIdle / dTotal) * 100));
}

export class Win32ResourceSignals implements ResourceSignals {
  constructor(private readonly deps: Win32SignalDeps = defaultWin32SignalDeps) {}

  async sample(): Promise<ResourceSample> {
    const before = this.deps.cpus();
    await this.deps.sleep(this.deps.windowMs);
    const after = this.deps.cpus();
    const memAvailableBytes = this.deps.freemem();
    if (!Number.isFinite(memAvailableBytes) || memAvailableBytes < 0) {
      throw new ResourceSignalError(`os.freemem() returned ${memAvailableBytes}`);
    }
    return {
      cpuPressure: cpuBusyPercent(before, after),
      cpuMetric: "cpu-busy-delta",
      memAvailableBytes,
      source: "win32:cpus-delta+freemem",
    };
  }
}
