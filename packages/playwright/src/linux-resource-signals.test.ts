import { describe, expect, test } from "vitest";
import { LinuxResourceSignals, type LinuxSignalDeps } from "./linux-resource-signals.js";
import { ResourceSignalError, parsePsiAvg10 } from "./resource-signals.js";

const MEMINFO = `MemTotal:       16000000 kB
MemFree:         1000000 kB
MemAvailable:    8000000 kB
Buffers:          100000 kB
`;
const PSI_CPU = `some avg10=24.40 avg60=14.79 avg300=27.97 total=12834394009
full avg10=0.00 avg60=0.00 avg300=0.00 total=0
`;
const PSI_MEM = `some avg10=2.36 avg60=3.65 avg300=5.06 total=5666207575
full avg10=1.59 avg60=3.02 avg300=2.85 total=2968766764
`;
const CGROUP_PSI_MEM = `some avg10=30.00 avg60=0.00 avg300=0.00 total=1
full avg10=12.50 avg60=0.00 avg300=0.00 total=1
`;

function errno(code: string, path: string): Error {
  return Object.assign(new Error(`${code}: ${path}`), { code });
}

/** A fixture filesystem: present paths return text; `denied` paths reject with the given errno; others ENOENT. */
function fixture(
  files: Record<string, string>,
  opts: { denied?: Record<string, string>; loadavg?: number[]; cores?: number } = {},
): LinuxSignalDeps {
  return {
    readText: async (path) => {
      const deniedCode = opts.denied?.[path];
      if (deniedCode !== undefined) throw errno(deniedCode, path);
      const text = files[path];
      if (text === undefined) throw errno("ENOENT", path);
      return text;
    },
    loadavg: () => opts.loadavg ?? [0, 0, 0],
    availableParallelism: () => opts.cores ?? 8,
  };
}

const hostFiles = {
  "/proc/meminfo": MEMINFO,
  "/proc/pressure/cpu": PSI_CPU,
  "/proc/pressure/memory": PSI_MEM,
  "/proc/self/cgroup": "0::/\n",
  "/proc/sys/kernel/osrelease": "6.8.0-45-generic\n",
};

describe("parsePsiAvg10", () => {
  test("reads some/full avg10", () => {
    expect(parsePsiAvg10(PSI_CPU, "some", "x")).toBe(24.4);
    expect(parsePsiAvg10(PSI_MEM, "full", "x")).toBe(1.59);
  });
  test("malformed PSI throws instead of guessing", () => {
    expect(() => parsePsiAvg10("some avg10=abc", "some", "x")).toThrow(ResourceSignalError);
    expect(() => parsePsiAvg10("garbage", "full", "x")).toThrow(/no "full" line/);
  });
});

describe("LinuxResourceSignals", () => {
  test("bare-metal Linux with PSI: cpu some avg10, memory full avg10, MemAvailable", async () => {
    const sample = await new LinuxResourceSignals(fixture(hostFiles)).sample();
    expect(sample).toEqual({
      cpuPressure: 24.4,
      cpuMetric: "psi-cpu-some-avg10",
      memPressure: 1.59,
      memMetric: "psi-memory-full-avg10",
      memAvailableBytes: 8000000 * 1024,
      source: "linux:psi-cpu+psi-memory+meminfo",
    });
  });

  test("WSL2 kernel is labelled wsl2 in source", async () => {
    const files = { ...hostFiles, "/proc/sys/kernel/osrelease": "6.6.87.2-microsoft-standard-WSL2\n" };
    const sample = await new LinuxResourceSignals(fixture(files)).sample();
    expect(sample.source).toBe("wsl2:psi-cpu+psi-memory+meminfo");
  });

  test("PSI missing (old WSL kernel) → loadavg/cores fallback, reported honestly in source", async () => {
    const files: Record<string, string> = { ...hostFiles, "/proc/sys/kernel/osrelease": "5.10.16.3-microsoft-standard-WSL2\n" };
    delete files["/proc/pressure/cpu"];
    delete files["/proc/pressure/memory"];
    const sample = await new LinuxResourceSignals(fixture(files, { loadavg: [6, 5, 4], cores: 4 })).sample();
    expect(sample.cpuPressure).toBe(150);
    expect(sample.cpuMetric).toBe("loadavg1-per-core");
    expect(sample.memPressure).toBeUndefined();
    expect(sample.memMetric).toBeUndefined();
    expect(sample.source).toBe(
      "wsl2:loadavg+meminfo (psi unavailable: ENOENT /proc/pressure/cpu; memory pressure unavailable: ENOENT /proc/pressure/memory)",
    );
  });

  test("PSI denied in a restricted container (EOPNOTSUPP / EACCES) → fallback, reason named", async () => {
    const sample = await new LinuxResourceSignals(
      fixture(hostFiles, { denied: { "/proc/pressure/cpu": "EOPNOTSUPP", "/proc/pressure/memory": "EACCES" }, loadavg: [1, 1, 1], cores: 2 }),
    ).sample();
    expect(sample.cpuMetric).toBe("loadavg1-per-core");
    expect(sample.cpuPressure).toBe(50);
    expect(sample.source).toContain("psi unavailable: EOPNOTSUPP /proc/pressure/cpu");
    expect(sample.source).toContain("memory pressure unavailable: EACCES /proc/pressure/memory");
  });

  test("cgroup v2 container: memory.max − memory.current clamps MemAvailable (host meminfo lies)", async () => {
    const files = {
      ...hostFiles,
      "/proc/self/cgroup": "0::/\n",
      "/sys/fs/cgroup/memory.max": "1073741824\n",
      "/sys/fs/cgroup/memory.current": "805306368\n",
    };
    const sample = await new LinuxResourceSignals(fixture(files)).sample();
    expect(sample.memAvailableBytes).toBe(1073741824 - 805306368);
    expect(sample.source).toBe("linux:psi-cpu+psi-memory+cgroup-memory.max+meminfo");
  });

  test("cgroup memory.pressure (nested cgroup path) is preferred over host PSI", async () => {
    const files = {
      ...hostFiles,
      "/proc/self/cgroup": "0::/system.slice/docker-abc.scope\n",
      "/sys/fs/cgroup/system.slice/docker-abc.scope/memory.pressure": CGROUP_PSI_MEM,
      "/sys/fs/cgroup/system.slice/docker-abc.scope/memory.max": "max\n",
    };
    const sample = await new LinuxResourceSignals(fixture(files)).sample();
    expect(sample.memPressure).toBe(12.5);
    expect(sample.memAvailableBytes).toBe(8000000 * 1024);
    expect(sample.source).toBe("linux:psi-cpu+psi-cgroup-memory+meminfo");
  });

  test("memory.max above MemAvailable does not raise availability", async () => {
    const files = {
      ...hostFiles,
      "/sys/fs/cgroup/memory.max": String(64 * 1024 ** 3),
      "/sys/fs/cgroup/memory.current": "0",
    };
    const sample = await new LinuxResourceSignals(fixture(files)).sample();
    expect(sample.memAvailableBytes).toBe(8000000 * 1024);
  });

  test("cgroup v1 (no 0:: line) → no cgroup clamp, meminfo only", async () => {
    const files = { ...hostFiles, "/proc/self/cgroup": "12:memory:/docker/abc\n" };
    const sample = await new LinuxResourceSignals(fixture(files)).sample();
    expect(sample.source).toBe("linux:psi-cpu+psi-memory+meminfo");
  });

  test("missing /proc/meminfo fails fast — no guessed memory", async () => {
    const files: Record<string, string> = { ...hostFiles };
    delete files["/proc/meminfo"];
    await expect(new LinuxResourceSignals(fixture(files)).sample()).rejects.toThrow(/required \/proc\/meminfo/);
  });

  test("meminfo without MemAvailable fails fast", async () => {
    const files = { ...hostFiles, "/proc/meminfo": "MemTotal: 1 kB\n" };
    await expect(new LinuxResourceSignals(fixture(files)).sample()).rejects.toThrow(/no MemAvailable/);
  });

  test("an unexpected PSI read error (EIO) is not treated as 'unavailable'", async () => {
    await expect(
      new LinuxResourceSignals(fixture(hostFiles, { denied: { "/proc/pressure/cpu": "EIO" } })).sample(),
    ).rejects.toThrow(ResourceSignalError);
  });

  test("malformed memory.max fails fast", async () => {
    const files = { ...hostFiles, "/sys/fs/cgroup/memory.max": "lots" };
    await expect(new LinuxResourceSignals(fixture(files)).sample()).rejects.toThrow(/malformed/);
  });
});
