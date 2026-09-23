import type { CpuInfo } from "node:os";
import { DarwinResourceSignals, defaultDarwinSignalDeps } from "./darwin-resource-signals.js";
import { LinuxResourceSignals, defaultLinuxSignalDeps } from "./linux-resource-signals.js";
import { ResourceSignalError, type ResourceSignals } from "./resource-signals.js";
import { Win32ResourceSignals, defaultWin32SignalDeps } from "./win32-resource-signals.js";

/** Every host primitive any platform reader may use; each reader receives only its own subset. */
export interface HostSignalDeps {
  readonly readText: (path: string) => Promise<string>;
  readonly run: (file: string, args: readonly string[]) => Promise<string>;
  readonly loadavg: () => number[];
  readonly availableParallelism: () => number;
  readonly cpus: () => CpuInfo[];
  readonly freemem: () => number;
  readonly sleep: (ms: number) => Promise<unknown>;
  readonly cpuWindowMs: number;
}

export const defaultHostSignalDeps: HostSignalDeps = {
  readText: defaultLinuxSignalDeps.readText,
  run: defaultDarwinSignalDeps.run,
  loadavg: defaultLinuxSignalDeps.loadavg,
  availableParallelism: defaultLinuxSignalDeps.availableParallelism,
  cpus: defaultWin32SignalDeps.cpus,
  freemem: defaultWin32SignalDeps.freemem,
  sleep: defaultWin32SignalDeps.sleep,
  cpuWindowMs: defaultWin32SignalDeps.windowMs,
};

/**
 * The reader for this platform. Linux covers WSL2 (same kernel interfaces; the
 * reader labels WSL in `source`). Any other platform fails fast rather than
 * admitting work blind.
 */
export function createResourceSignals(
  platform: NodeJS.Platform = process.platform,
  host: HostSignalDeps = defaultHostSignalDeps,
): ResourceSignals {
  switch (platform) {
    case "linux":
      return new LinuxResourceSignals({ readText: host.readText, loadavg: host.loadavg, availableParallelism: host.availableParallelism });
    case "darwin":
      return new DarwinResourceSignals({ run: host.run, loadavg: host.loadavg, availableParallelism: host.availableParallelism });
    case "win32":
      return new Win32ResourceSignals({ cpus: host.cpus, freemem: host.freemem, sleep: host.sleep, windowMs: host.cpuWindowMs });
    default:
      throw new ResourceSignalError(`no resource-signal reader for platform "${platform}" (supported: linux incl. WSL2, darwin, win32)`);
  }
}
