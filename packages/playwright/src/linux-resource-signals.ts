import { readFile } from "node:fs/promises";
import { availableParallelism, loadavg } from "node:os";
import {
  ResourceSignalError,
  errnoCode,
  parseMeminfoBytes,
  parsePsiAvg10,
  type CpuMetric,
  type MemMetric,
  type ResourceSample,
  type ResourceSignals,
} from "./resource-signals.js";

/**
 * Linux + WSL2 signals.
 *
 *  - CPU: PSI `/proc/pressure/cpu` `some avg10`.
 *  - Memory pressure: cgroup v2 `memory.pressure` `full avg10` when the process
 *    sits in a cgroup exposing it (containers), else `/proc/pressure/memory`.
 *  - Memory available: `/proc/meminfo` MemAvailable, clamped to the cgroup v2
 *    headroom `memory.max − memory.current` — inside a container `os.totalmem()`
 *    and meminfo describe the HOST, so the cgroup limit is the real ceiling.
 *
 * PSI is absent on older WSL kernels and denied in some restricted containers
 * (ENOENT / EACCES / EPERM / EOPNOTSUPP). Then, and only then, CPU falls back
 * to 1-minute loadavg per core and memory pressure is omitted — and `source`
 * says so, naming the reason. Any other read or parse failure throws.
 */
export interface LinuxSignalDeps {
  /** Reads a file as UTF-8; rejects with a Node errno error (`code`) when unreadable. */
  readonly readText: (path: string) => Promise<string>;
  readonly loadavg: () => number[];
  readonly availableParallelism: () => number;
}

export const defaultLinuxSignalDeps: LinuxSignalDeps = {
  readText: (path) => readFile(path, "utf8"),
  loadavg,
  availableParallelism,
};

/** Errno codes that mean "this kernel/container does not offer PSI" — the only fallback trigger. */
const PSI_UNAVAILABLE = new Set(["ENOENT", "EACCES", "EPERM", "EOPNOTSUPP", "ENOTSUP"]);

type Optional<T> = { ok: true; value: T } | { ok: false; reason: string };

async function readOptional(deps: LinuxSignalDeps, path: string): Promise<Optional<string>> {
  try {
    return { ok: true, value: await deps.readText(path) };
  } catch (err) {
    const code = errnoCode(err);
    if (code !== undefined && PSI_UNAVAILABLE.has(code)) return { ok: false, reason: `${code} ${path}` };
    throw new ResourceSignalError(`cannot read ${path}: ${err instanceof Error ? err.message : String(err)}`, { cause: err });
  }
}

async function readRequired(deps: LinuxSignalDeps, path: string): Promise<string> {
  try {
    return await deps.readText(path);
  } catch (err) {
    throw new ResourceSignalError(`cannot read required ${path}: ${err instanceof Error ? err.message : String(err)}`, { cause: err });
  }
}

/** The unified (v2) cgroup directory of this process, or undefined on cgroup v1 / no cgroupfs. */
async function cgroupV2Dir(deps: LinuxSignalDeps): Promise<string | undefined> {
  const self = await readOptional(deps, "/proc/self/cgroup");
  if (!self.ok) return undefined;
  const line = self.value.split("\n").find((l) => l.startsWith("0::"));
  if (line === undefined) return undefined;
  const rel = line.slice(3).trim();
  return rel === "/" || rel === "" ? "/sys/fs/cgroup" : `/sys/fs/cgroup${rel}`;
}

interface CgroupMemory {
  readonly headroomBytes?: number;
  readonly pressureText?: string;
  readonly pressurePath?: string;
}

async function readCgroupMemory(deps: LinuxSignalDeps, dir: string | undefined): Promise<CgroupMemory> {
  if (dir === undefined) return {};
  const pressurePath = `${dir}/memory.pressure`;
  const pressure = await readOptional(deps, pressurePath);
  const max = await readOptional(deps, `${dir}/memory.max`);
  const pressurePart = pressure.ok ? { pressureText: pressure.value, pressurePath } : {};
  if (!max.ok || max.value.trim() === "max") return pressurePart;
  const limit = Number(max.value.trim());
  if (!Number.isFinite(limit)) throw new ResourceSignalError(`malformed ${dir}/memory.max: ${JSON.stringify(max.value)}`);
  const current = Number((await readRequired(deps, `${dir}/memory.current`)).trim());
  if (!Number.isFinite(current)) throw new ResourceSignalError(`malformed ${dir}/memory.current`);
  return { ...pressurePart, headroomBytes: Math.max(0, limit - current) };
}

async function isWsl(deps: LinuxSignalDeps): Promise<boolean> {
  const release = await readOptional(deps, "/proc/sys/kernel/osrelease");
  return release.ok && /microsoft/i.test(release.value);
}

export class LinuxResourceSignals implements ResourceSignals {
  constructor(private readonly deps: LinuxSignalDeps = defaultLinuxSignalDeps) {}

  async sample(): Promise<ResourceSample> {
    const deps = this.deps;
    const parts: string[] = [];
    const notes: string[] = [];

    const meminfo = await readRequired(deps, "/proc/meminfo");
    let memAvailableBytes = parseMeminfoBytes(meminfo, "MemAvailable");
    const cgroup = await readCgroupMemory(deps, await cgroupV2Dir(deps));
    if (cgroup.headroomBytes !== undefined) {
      memAvailableBytes = Math.min(memAvailableBytes, cgroup.headroomBytes);
      parts.push("cgroup-memory.max");
    }
    parts.push("meminfo");

    let cpuPressure: number;
    let cpuMetric: CpuMetric;
    const cpuPsi = await readOptional(deps, "/proc/pressure/cpu");
    if (cpuPsi.ok) {
      cpuPressure = parsePsiAvg10(cpuPsi.value, "some", "/proc/pressure/cpu");
      cpuMetric = "psi-cpu-some-avg10";
      parts.unshift("psi-cpu");
    } else {
      const cores = deps.availableParallelism();
      const load1 = deps.loadavg()[0];
      if (load1 === undefined || !Number.isFinite(load1) || cores < 1) {
        throw new ResourceSignalError(`PSI unavailable (${cpuPsi.reason}) and loadavg/cores unusable: loadavg=${String(load1)} cores=${cores}`);
      }
      cpuPressure = (load1 / cores) * 100;
      cpuMetric = "loadavg1-per-core";
      parts.unshift("loadavg");
      notes.push(`psi unavailable: ${cpuPsi.reason}`);
    }

    let mem: { memPressure: number; memMetric: MemMetric } | undefined;
    if (cgroup.pressureText !== undefined && cgroup.pressurePath !== undefined) {
      mem = { memPressure: parsePsiAvg10(cgroup.pressureText, "full", cgroup.pressurePath), memMetric: "psi-memory-full-avg10" };
      parts.splice(1, 0, "psi-cgroup-memory");
    } else {
      const memPsi = await readOptional(deps, "/proc/pressure/memory");
      if (memPsi.ok) {
        mem = { memPressure: parsePsiAvg10(memPsi.value, "full", "/proc/pressure/memory"), memMetric: "psi-memory-full-avg10" };
        parts.splice(1, 0, "psi-memory");
      } else {
        notes.push(`memory pressure unavailable: ${memPsi.reason}`);
      }
    }

    const platform = (await isWsl(deps)) ? "wsl2" : "linux";
    const source = `${platform}:${parts.join("+")}${notes.length > 0 ? ` (${notes.join("; ")})` : ""}`;
    return { cpuPressure, cpuMetric, ...(mem ?? {}), memAvailableBytes, source };
  }
}
