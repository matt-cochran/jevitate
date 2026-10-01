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
