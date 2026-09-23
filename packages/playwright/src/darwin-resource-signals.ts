import { execFile } from "node:child_process";
import { availableParallelism, loadavg } from "node:os";
import { promisify } from "node:util";
import { ResourceSignalError, type ResourceSample, type ResourceSignals } from "./resource-signals.js";

/**
 * macOS signals. macOS has no PSI, and `os.freemem()` is deliberately NOT used:
 * it counts only truly free pages (excluding inactive/purgeable/speculative
 * memory the kernel reclaims instantly), so a healthy Mac always looks starved.
 *
 *  - Memory pressure: `sysctl -n kern.memorystatus_vm_pressure_level`
 *    (1=normal, 2=warn, 4=critical) mapped to 0 / 50 / 100.
 *  - Memory available: `vm_stat` (free + inactive + speculative + purgeable pages) × page size.
 *  - CPU: `os.loadavg()[0] / os.availableParallelism()` × 100 (loadavg is real on macOS).
 */
export interface DarwinSignalDeps {
  /** Runs a command, resolving its stdout; rejects when it cannot run or exits non-zero. */
  readonly run: (file: string, args: readonly string[]) => Promise<string>;
  readonly loadavg: () => number[];
  readonly availableParallelism: () => number;
}

const execFileAsync = promisify(execFile);

export const defaultDarwinSignalDeps: DarwinSignalDeps = {
  run: async (file, args) => (await execFileAsync(file, [...args], { encoding: "utf8" })).stdout,
  loadavg,
  availableParallelism,
};

const PRESSURE_LEVEL: ReadonlyMap<number, number> = new Map([
  [1, 0],
  [2, 50],
  [4, 100],
]);

/** Maps `kern.memorystatus_vm_pressure_level` output to 0/50/100. Unknown levels throw. */
export function parseVmPressureLevel(stdout: string): number {
  const level = Number(stdout.trim());
  const mapped = PRESSURE_LEVEL.get(level);
  if (mapped === undefined) {
    throw new ResourceSignalError(`unexpected kern.memorystatus_vm_pressure_level ${JSON.stringify(stdout.trim())} (expected 1, 2 or 4)`);
  }
  return mapped;
}

const RECLAIMABLE = ["Pages free", "Pages inactive", "Pages speculative", "Pages purgeable"] as const;

/** Bytes the kernel can hand a new process now, from `vm_stat` output. Missing fields throw. */
export function parseVmStatAvailableBytes(stdout: string): number {
  const pageSize = /page size of (\d+) bytes/.exec(stdout);
  if (pageSize === null) throw new ResourceSignalError("vm_stat output has no page size header");
  let pages = 0;
  for (const key of RECLAIMABLE) {
    const match = new RegExp(`^${key}:\\s+(\\d+)\\.?$`, "m").exec(stdout);
    if (match === null) throw new ResourceSignalError(`vm_stat output has no "${key}" line`);
    pages += Number(match[1]);
  }
  return pages * Number(pageSize[1]);
}

async function runOrThrow(deps: DarwinSignalDeps, file: string, args: readonly string[]): Promise<string> {
  try {
    return await deps.run(file, args);
  } catch (err) {
    throw new ResourceSignalError(`${file} ${args.join(" ")} failed: ${err instanceof Error ? err.message : String(err)}`, { cause: err });
  }
}

export class DarwinResourceSignals implements ResourceSignals {
  constructor(private readonly deps: DarwinSignalDeps = defaultDarwinSignalDeps) {}

  async sample(): Promise<ResourceSample> {
    const memPressure = parseVmPressureLevel(await runOrThrow(this.deps, "sysctl", ["-n", "kern.memorystatus_vm_pressure_level"]));
    const memAvailableBytes = parseVmStatAvailableBytes(await runOrThrow(this.deps, "vm_stat", []));
    const cores = this.deps.availableParallelism();
    const load1 = this.deps.loadavg()[0];
    if (load1 === undefined || !Number.isFinite(load1) || cores < 1) {
      throw new ResourceSignalError(`loadavg/cores unusable on darwin: loadavg=${String(load1)} cores=${cores}`);
    }
    return {
      cpuPressure: (load1 / cores) * 100,
      cpuMetric: "loadavg1-per-core",
      memPressure,
      memMetric: "vm-pressure-level",
      memAvailableBytes,
      source: "darwin:loadavg+sysctl-vm-pressure-level+vm_stat",
    };
  }
}
