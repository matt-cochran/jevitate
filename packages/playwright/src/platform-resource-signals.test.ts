import { describe, expect, test } from "vitest";
import type { CpuInfo } from "node:os";
import {
  DarwinResourceSignals,
  parseVmPressureLevel,
  parseVmStatAvailableBytes,
  type DarwinSignalDeps,
} from "./darwin-resource-signals.js";
import { ResourceSignalError } from "./resource-signals.js";
import { createResourceSignals, type HostSignalDeps } from "./select-resource-signals.js";
import { Win32ResourceSignals, cpuBusyPercent } from "./win32-resource-signals.js";

// Real `vm_stat` output shape (Apple Silicon, 16 KiB pages).
const VM_STAT = `Mach Virtual Memory Statistics: (page size of 16384 bytes)
Pages free:                               10000.
Pages active:                            400000.
Pages inactive:                          300000.
Pages speculative:                         5000.
Pages throttled:                              0.
Pages wired down:                        150000.
Pages purgeable:                           2000.
"Translation faults":                 123456789.
`;

function darwinDeps(outputs: Record<string, string>, loadavg: number[] = [4, 3, 2], cores = 8): DarwinSignalDeps {
  return {
    run: async (file, args) => {
      const key = [file, ...args].join(" ");
      const out = outputs[key];
      if (out === undefined) throw new Error(`command not found: ${key}`);
      return out;
    },
    loadavg: () => loadavg,
    availableParallelism: () => cores,
  };
}

const SYSCTL = "sysctl -n kern.memorystatus_vm_pressure_level";

function cpu(user: number, sys: number, idle: number): CpuInfo {
  return { model: "fixture", speed: 3000, times: { user, nice: 0, sys, idle, irq: 0 } };
}

describe("darwin", () => {
  test("vm pressure level 1/2/4 → 0/50/100; unknown throws", () => {
    expect(parseVmPressureLevel("1\n")).toBe(0);
    expect(parseVmPressureLevel("2")).toBe(50);
    expect(parseVmPressureLevel("4\n")).toBe(100);
    expect(() => parseVmPressureLevel("3")).toThrow(ResourceSignalError);
  });

  test("vm_stat available = (free + inactive + speculative + purgeable) × page size", () => {
    expect(parseVmStatAvailableBytes(VM_STAT)).toBe((10000 + 300000 + 5000 + 2000) * 16384);
    expect(() => parseVmStatAvailableBytes("Pages free: 1.")).toThrow(/page size/);
  });

  test("sample: sysctl memory pressure + vm_stat availability + loadavg/cores CPU", async () => {
    const sample = await new DarwinResourceSignals(darwinDeps({ [SYSCTL]: "2\n", vm_stat: VM_STAT })).sample();
    expect(sample).toEqual({
      cpuPressure: 50,
      cpuMetric: "loadavg1-per-core",
      memPressure: 50,
      memMetric: "vm-pressure-level",
      memAvailableBytes: (10000 + 300000 + 5000 + 2000) * 16384,
      source: "darwin:loadavg+sysctl-vm-pressure-level+vm_stat",
    });
  });

  test("sysctl failing is a loud error, not a guess", async () => {
    await expect(new DarwinResourceSignals(darwinDeps({ vm_stat: VM_STAT })).sample()).rejects.toThrow(
      /sysctl -n kern.memorystatus_vm_pressure_level failed/,
    );
  });
});

describe("win32", () => {
  test("cpu busy % from two os.cpus() snapshots", () => {
    const before = [cpu(100, 100, 800), cpu(100, 100, 800)];
    const after = [cpu(250, 150, 900), cpu(200, 200, 900)];
    // Δtotal = (1300-1000)+(1300-1000)=600; Δidle = 100+100=200 → busy 66.67%
    expect(cpuBusyPercent(before, after)).toBeCloseTo((1 - 200 / 600) * 100, 5);
  });

  test("a window where times did not advance throws", () => {
    const snap = [cpu(1, 1, 1)];
    expect(() => cpuBusyPercent(snap, snap)).toThrow(/did not advance/);
  });

  test("sample: delta-sampled CPU + freemem, over the configured window", async () => {
    const snaps = [[cpu(0, 0, 1000)], [cpu(400, 100, 1500)]];
    const slept: number[] = [];
    const sample = await new Win32ResourceSignals({
      cpus: () => snaps.shift() ?? [],
      freemem: () => 3 * 1024 ** 3,
      sleep: async (ms) => slept.push(ms),
      windowMs: 250,
    }).sample();
    expect(slept).toEqual([250]);
    expect(sample).toEqual({ cpuPressure: 50, cpuMetric: "cpu-busy-delta", memAvailableBytes: 3 * 1024 ** 3, source: "win32:cpus-delta+freemem" });
  });
});

describe("createResourceSignals (platform selection)", () => {
  function host(overrides: Partial<HostSignalDeps> = {}): HostSignalDeps & { loadavgCalls: number } {
    const state = { loadavgCalls: 0 };
    const snaps = [[cpu(0, 0, 1000)], [cpu(900, 0, 1100)]];
    return Object.assign(state, {
      readText: async (path: string): Promise<string> => {
        const files: Record<string, string> = {
          "/proc/meminfo": "MemAvailable: 1024 kB\n",
          "/proc/pressure/cpu": "some avg10=1.00 avg60=0 avg300=0 total=0\n",
          "/proc/pressure/memory": "some avg10=0 avg60=0 avg300=0 total=0\nfull avg10=0.50 avg60=0 avg300=0 total=0\n",
          "/proc/self/cgroup": "0::/\n",
          "/proc/sys/kernel/osrelease": "6.6.87.2-microsoft-standard-WSL2\n",
        };
        const text = files[path];
        if (text === undefined) throw Object.assign(new Error(`ENOENT ${path}`), { code: "ENOENT" });
        return text;
      },
      run: async (file: string): Promise<string> => (file === "sysctl" ? "1\n" : VM_STAT),
      loadavg: (): number[] => {
        state.loadavgCalls += 1;
        return [0, 0, 0];
      },
      availableParallelism: () => 4,
      cpus: () => snaps.shift() ?? [],
      freemem: () => 2048,
      sleep: async () => undefined,
      cpuWindowMs: 1,
      ...overrides,
    });
  }

  test("win32 never uses loadavg (it is always [0,0,0] there)", async () => {
    const deps = host();
    const sample = await createResourceSignals("win32", deps).sample();
    expect(deps.loadavgCalls).toBe(0);
    expect(sample.cpuMetric).toBe("cpu-busy-delta");
    expect(sample.cpuPressure).toBe(90);
    expect(sample.source).toBe("win32:cpus-delta+freemem");
  });

  test("darwin never uses os.freemem (misleading on macOS)", async () => {
    let freememCalls = 0;
    const deps = host({
      freemem: () => {
        freememCalls += 1;
        return 1;
      },
    });
    const sample = await createResourceSignals("darwin", deps).sample();
    expect(freememCalls).toBe(0);
    expect(sample.memMetric).toBe("vm-pressure-level");
  });

  test("linux (WSL2) selects the PSI reader", async () => {
    const sample = await createResourceSignals("linux", host()).sample();
    expect(sample.source).toBe("wsl2:psi-cpu+psi-memory+meminfo");
    expect(sample.memAvailableBytes).toBe(1024 * 1024);
  });

  test("unsupported platform fails fast", () => {
    expect(() => createResourceSignals("aix", host())).toThrow(/no resource-signal reader for platform "aix"/);
  });
});
