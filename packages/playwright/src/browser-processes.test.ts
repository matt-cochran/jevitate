import { afterEach, describe, expect, it } from "vitest";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import {
  cleanupOrphanBrowsers,
  findOrphanBrowsers,
  measureOwnBrowserMemory,
  ownerMarkerArg,
  parseOwnerMarker,
  processAlive,
  systemProcessTable,
  terminateOwnBrowsersSync,
  type ProcessInfo,
  type ProcessTable,
} from "./browser-processes.js";

/**
 * #205: orphan cleanup. Fake "browsers" are real processes this test spawns, carrying the owner
 * marker exactly as a jevitate-launched Chromium does. The process table the code sees is the REAL
 * one restricted to this test's own children, so nothing else on the machine is ever looked at or
 * signalled — and the assertions prove an unmarked process and a marked one whose owner is alive are
 * never touched.
 */

const linux = process.platform === "linux";
const spawned: ChildProcess[] = [];

afterEach(() => {
  for (const p of spawned.splice(0)) if (p.pid !== undefined && processAlive(p.pid)) p.kill("SIGKILL");
});

/** A long-lived child whose argv carries `extra` (so it shows in /proc/<pid>/cmdline). */
function fakeProcess(extra: readonly string[]): ChildProcess {
  const p = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)", "--", ...extra], { stdio: "ignore" });
  spawned.push(p);
  return p;
}

/** The real process table, restricted to `pids` (startOf/memoryOf of the owner pids stay real). */
function restricted(pids: () => readonly number[]): ProcessTable {
  const real = systemProcessTable();
  return {
    list: () => real.list()?.filter((p) => pids().includes(p.pid)),
    startOf: (pid) => real.startOf(pid),
    memoryOf: (pid) => (pids().includes(pid) ? real.memoryOf(pid) : undefined),
  };
}

async function waitFor(cond: () => boolean, ms = 5_000): Promise<void> {
  const until = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > until) throw new Error("condition not met in time");
    await new Promise((r) => setTimeout(r, 20));
  }
}

describe("owner marker", () => {
  it("round-trips pid and start time", () => {
    expect(parseOwnerMarker(["chrome", "--no-sandbox", "--jevitate-owner=123@4567"])).toEqual({ pid: 123, start: "4567" });
    expect(parseOwnerMarker(["chrome", "--no-sandbox"])).toBeUndefined();
    expect(parseOwnerMarker([ownerMarkerArg()])?.pid).toBe(process.pid);
  });
});

describe.runIf(linux)("orphan cleanup (real processes, restricted table)", () => {
  it("closes only marked processes whose owner is gone — never an unmarked one or one whose owner runs", async () => {
    const dead = spawnSync(process.execPath, ["-e", "0"]).pid!;
    const orphan = fakeProcess([`--jevitate-owner=${dead}@0`]);
    const owned = fakeProcess([ownerMarkerArg()]); // owner: this (live) process
    const unmarked = fakeProcess(["--type=renderer"]);
    const pids = (): number[] => [orphan, owned, unmarked].map((p) => p.pid!);
    const table = restricted(pids);
    await waitFor(() => (table.list() ?? []).filter((p) => p.argv.length > 2).length === 3);

    const found = findOrphanBrowsers(table);
    expect(found.map((b) => b.pid)).toEqual([orphan.pid]);
    expect(found[0]!.orphan).toBe(`its jevitate process (pid ${dead}) is no longer running`);

    const cleanup = await cleanupOrphanBrowsers({ table, graceMs: 3_000 });
    expect(cleanup.supported).toBe(true);
    expect(cleanup.orphans.map((o) => [o.pid, o.result])).toEqual([[orphan.pid, "terminated"]]);
    await waitFor(() => !processAlive(orphan.pid!));
    expect(processAlive(owned.pid!)).toBe(true);
    expect(processAlive(unmarked.pid!)).toBe(true);
  });

  it("a reused owner pid (same pid, different start time) is an orphan's owner gone", async () => {
    const reused = fakeProcess([`--jevitate-owner=${process.pid}@1`]); // this pid, but a start that is not ours
    const table = restricted(() => [reused.pid!]);
    await waitFor(() => (table.list() ?? []).length === 1);
    expect(findOrphanBrowsers(table)[0]?.orphan).toMatch(/now belongs to another process/);
    const cleanup = await cleanupOrphanBrowsers({ table });
    expect(cleanup.orphans.map((o) => o.result)).toEqual(["terminated"]);
  });

  it("escalates to SIGKILL when an orphan ignores SIGTERM", async () => {
    const dead = spawnSync(process.execPath, ["-e", "0"]).pid!;
    const stubborn = spawn(process.execPath, ["-e", "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)", "--", `--jevitate-owner=${dead}@0`], { stdio: "ignore" });
    spawned.push(stubborn);
    const table = restricted(() => [stubborn.pid!]);
    await waitFor(() => (table.list() ?? []).length === 1);
    await new Promise((r) => setTimeout(r, 200)); // its SIGTERM handler is installed
    const cleanup = await cleanupOrphanBrowsers({ table, graceMs: 300 });
    expect(cleanup.orphans.map((o) => o.result)).toEqual(["killed"]);
    await waitFor(() => !processAlive(stubborn.pid!));
  });

  it("measures the memory of this process's marked browser tree (and nobody else's)", async () => {
    const mine = fakeProcess([ownerMarkerArg()]);
    const dead = spawnSync(process.execPath, ["-e", "0"]).pid!;
    const notMine = fakeProcess([`--jevitate-owner=${dead}@0`]);
    const table = restricted(() => [mine.pid!, notMine.pid!]);
    await waitFor(() => (table.list() ?? []).length === 2);
    const reading = measureOwnBrowserMemory({ table });
    expect(reading).toBeDefined();
    expect(reading!.roots).toEqual([mine.pid]);
    expect(reading!.processes).toBe(1);
    expect(reading!.bytes).toBeGreaterThan(1024 * 1024);
    expect(["pss", "rss"]).toContain(reading!.metric);
  });
});

describe("unsupported platform", () => {
  it("reports unsupported instead of guessing", async () => {
    const table = systemProcessTable("win32");
    expect(table.list()).toBeUndefined();
    expect(await cleanupOrphanBrowsers({ table })).toEqual({ orphans: [], supported: false });
    expect(measureOwnBrowserMemory({ table })).toBeUndefined();
  });
});

describe("terminateOwnBrowsersSync (#326)", () => {
  /** A fake table: `procs` is the whole machine; signals and the wait are recorded, never real. */
  function fake(procs: ProcessInfo[], opts: { exitsOn?: NodeJS.Signals } = {}) {
    const running = new Set(procs.map((p) => p.pid));
    const signals: Array<[number, NodeJS.Signals]> = [];
    let slept = 0;
    const table: ProcessTable = { list: () => procs.filter((p) => running.has(p.pid)), startOf: () => "1", memoryOf: () => undefined };
    const kill = (pid: number, sig: NodeJS.Signals): void => {
      signals.push([pid, sig]);
      if (sig === "SIGKILL" || sig === opts.exitsOn) {
        if (pid < 0) {
          // a group signal: the leader and its descendants in this fake all share the group
          for (const p of procs) if (p.pid === -pid || p.ppid === -pid || procs.some((q) => q.pid === p.ppid && q.ppid === -pid)) running.delete(p.pid);
        } else running.delete(pid);
      }
    };
    return { table, kill, signals, alive: (pid: number) => running.has(pid), sleepSync: (ms: number) => (slept += ms), slept: () => slept, running };
  }
  const browser = (pid: number, owner: number): ProcessInfo => ({ pid, ppid: owner, argv: [`chrome --headless --jevitate-owner=${owner}@1 --no-sandbox`] });
  const child = (pid: number, ppid: number): ProcessInfo => ({ pid, ppid, argv: ["chrome", "--type=renderer"] });

  it("SIGTERMs its own browser trees (group + every descendant) and stops waiting once they are gone", () => {
    const f = fake([browser(100, 7), child(101, 100), child(102, 101), browser(200, 8), child(201, 200), { pid: 300, ppid: 7, argv: ["unrelated"] }], { exitsOn: "SIGTERM" });
    const r = terminateOwnBrowsersSync({ table: f.table, ownerPid: 7, kill: f.kill, alive: f.alive, sleepSync: f.sleepSync });
    expect(r).toEqual({ supported: true, roots: [100], killed: [] });
    expect(f.signals.filter(([, s]) => s === "SIGTERM").map(([p]) => p)).toEqual([-100, 100, 101, 102]);
    expect(f.signals.some(([, s]) => s === "SIGKILL")).toBe(false);
    // Another owner's browser and an unmarked sibling are never touched.
    expect(f.running.has(200) && f.running.has(201) && f.running.has(300)).toBe(true);
    expect(f.slept()).toBe(0);
  });

  it("SIGKILLs what still runs after the bounded grace", () => {
    const f = fake([browser(100, 7), child(101, 100)]);
    const r = terminateOwnBrowsersSync({ table: f.table, ownerPid: 7, kill: f.kill, alive: f.alive, sleepSync: f.sleepSync, graceMs: 100, pollMs: 25 });
    expect(r.killed).toEqual([100, 101]);
    expect(f.slept()).toBe(100);
    expect(f.signals.filter(([, s]) => s === "SIGKILL").map(([p]) => p)).toEqual([-100, 100, 101]);
    expect(f.running.size).toBe(0);
  });

  it("no browsers, an unsupported platform, or failing signals: returns without throwing", () => {
    const f = fake([{ pid: 5, ppid: 7, argv: ["node"] }]);
    expect(terminateOwnBrowsersSync({ table: f.table, ownerPid: 7, kill: f.kill, alive: f.alive, sleepSync: f.sleepSync })).toEqual({ supported: true, roots: [], killed: [] });
    expect(f.signals).toEqual([]);
    const unsupported: ProcessTable = { list: () => undefined, startOf: () => undefined, memoryOf: () => undefined };
    expect(terminateOwnBrowsersSync({ table: unsupported }).supported).toBe(false);
    const g = fake([browser(100, 7)]);
    const throwing = () => {
      throw Object.assign(new Error("EPERM"), { code: "EPERM" });
    };
    expect(() => terminateOwnBrowsersSync({ table: g.table, ownerPid: 7, kill: throwing, alive: g.alive, sleepSync: g.sleepSync, graceMs: 50 })).not.toThrow();
  });

  it.runIf(linux)("real processes: a marked tree owned by this process is gone after the call", async () => {
    const owner = 2_000_000_000; // a fake owner pid, so only this test's processes match
    const p = fakeProcess([`--jevitate-owner=${owner}@1`]);
    await waitFor(() => p.pid !== undefined && processAlive(p.pid));
    const table = restricted(() => (p.pid === undefined ? [] : [p.pid]));
    const r = terminateOwnBrowsersSync({ table, ownerPid: owner, graceMs: 2000 });
    expect(r.roots).toEqual([p.pid]);
    await waitFor(() => p.exitCode !== null || p.signalCode !== null);
  });
});
