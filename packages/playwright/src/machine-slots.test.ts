import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { MachineBrowserSlots } from "./machine-slots.js";
import { AdmissionTimeoutError } from "./browser-pool.js";

/** #205: the machine-wide browser semaphore — concurrency, stale-holder recovery, timeouts. */

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "jev-slots-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

/** A pid that is certainly not running: a child that already exited. */
function deadPid(): number {
  const r = spawnSync(process.execPath, ["-e", "0"]);
  return r.pid!;
}

const slotFile = (i: number): string => join(dir, `slot-${i}.json`);

describe("MachineBrowserSlots", () => {
  it("never lets more than `cap` holders in at once, and every waiter gets a slot", async () => {
    const slots = new MachineBrowserSlots({ dir, pollMs: 5 });
    let held = 0;
    let peak = 0;
    const worker = async (): Promise<number> => {
      const lease = await slots.acquire(2, Date.now() + 10_000);
      held += 1;
      peak = Math.max(peak, held);
      await new Promise((r) => setTimeout(r, 30));
      held -= 1;
      lease.release();
      return lease.index;
    };
    const indexes = await Promise.all(Array.from({ length: 6 }, worker));
    expect(peak).toBe(2);
    expect(new Set(indexes)).toEqual(new Set([0, 1]));
    expect(slots.list()).toEqual([]); // all released, files removed
  });

  it("separate PROCESSES racing for 2 slots never exceed 2 holders", async () => {
    const mod = fileURLToPath(new URL("../dist/machine-slots.js", import.meta.url));
    expect(existsSync(mod), "build @jevitate/playwright first (pnpm -r build)").toBe(true);
    const log = join(dir, "log.txt");
    const child = `
      import { appendFileSync } from "node:fs";
      const { MachineBrowserSlots } = await import(${JSON.stringify(mod)});
      const slots = new MachineBrowserSlots({ dir: ${JSON.stringify(dir)}, pollMs: 10 });
      const lease = await slots.acquire(2, Date.now() + 30000);
      appendFileSync(${JSON.stringify(log)}, "+" + Date.now() + "\\n");
      await new Promise((r) => setTimeout(r, 150));
      appendFileSync(${JSON.stringify(log)}, "-" + Date.now() + "\\n");
      lease.release();
    `;
    await Promise.all(
      Array.from(
        { length: 5 },
        () =>
          new Promise<void>((resolve, reject) => {
            const p = spawn(process.execPath, ["--input-type=module", "-e", child], { stdio: "inherit" });
            p.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(`child exited ${code}`))));
          }),
      ),
    );
    // Replay the log: holders at any moment (a release is logged before the file is removed, so the
    // count can only over-estimate concurrency, never hide it).
    let holders = 0;
    let peak = 0;
    for (const line of readFileSync(log, "utf8").trim().split("\n")) {
      holders += line.startsWith("+") ? 1 : -1;
      peak = Math.max(peak, holders);
    }
    expect(peak).toBeLessThanOrEqual(2);
    expect(readFileSync(log, "utf8").trim().split("\n")).toHaveLength(10);
  }, 60_000);

  it("a process with a lower cap waits for one of ITS slots, even when higher slots are free", () => {
    const slots = new MachineBrowserSlots({ dir });
    const a = slots.tryAcquire(1)!;
    expect(a.index).toBe(0);
    expect(slots.tryAcquire(1)).toBeUndefined();
    const b = slots.tryAcquire(3)!;
    expect(b.index).toBe(1);
    a.release();
    b.release();
  });

  it("recovers a slot whose holder on this host is no longer running", () => {
    const pid = deadPid();
    writeFileSync(slotFile(0), JSON.stringify({ pid, host: "this-host", token: "t-dead", acquiredAt: "2026-01-01T00:00:00Z" }));
    const slots = new MachineBrowserSlots({ dir, host: "this-host" });
    expect(slots.list()[0]).toMatchObject({ index: 0, stale: `holder pid ${pid} on this-host is not running` });
    const lease = slots.tryAcquire(1);
    expect(lease?.index).toBe(0);
    expect(JSON.parse(readFileSync(slotFile(0), "utf8")).pid).toBe(process.pid);
    lease!.release();
  });

  it("never takes a live holder's slot on this host", () => {
    writeFileSync(slotFile(0), JSON.stringify({ pid: process.pid, host: "this-host", token: "t-live", acquiredAt: "x" }));
    const slots = new MachineBrowserSlots({ dir, host: "this-host" });
    expect(slots.list()[0]!.stale).toBeNull();
    expect(slots.tryAcquire(1)).toBeUndefined();
    expect(slots.clearStale()).toEqual([]);
    expect(JSON.parse(readFileSync(slotFile(0), "utf8")).token).toBe("t-live");
  });

  it("a holder on another host is stale only after its heartbeat stops", () => {
    writeFileSync(slotFile(0), JSON.stringify({ pid: 4242, host: "other-host", token: "t-other", acquiredAt: "x" }));
    const slots = new MachineBrowserSlots({ dir, host: "this-host", staleAfterMs: 60_000 });
    expect(slots.tryAcquire(1)).toBeUndefined(); // fresh heartbeat: live
    const old = new Date(Date.now() - 120_000);
    utimesSync(slotFile(0), old, old);
    expect(slots.list()[0]!.stale).toMatch(/holder pid 4242 on other-host sent no heartbeat for 1\d\ds/);
    const lease = slots.tryAcquire(1);
    expect(lease?.index).toBe(0);
    lease!.release();
  });

  it("clearStale removes unreadable and dead-holder slots and keeps live ones", () => {
    writeFileSync(slotFile(0), "{not json");
    const old = new Date(Date.now() - 60_000);
    utimesSync(slotFile(0), old, old);
    writeFileSync(slotFile(1), JSON.stringify({ pid: deadPid(), host: "h", token: "d", acquiredAt: "x" }));
    writeFileSync(slotFile(2), JSON.stringify({ pid: process.pid, host: "h", token: "l", acquiredAt: "x" }));
    const slots = new MachineBrowserSlots({ dir, host: "h" });
    expect(slots.clearStale().map((s) => s.index)).toEqual([0, 1]);
    expect(slots.list().map((s) => s.index)).toEqual([2]);
  });

  it("times out with AdmissionTimeoutError naming the holders", async () => {
    writeFileSync(slotFile(0), JSON.stringify({ pid: process.pid, host: "h", token: "l", acquiredAt: "x" }));
    const slots = new MachineBrowserSlots({ dir, host: "h", pollMs: 5 });
    const err = await slots.acquire(1, Date.now() + 30).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AdmissionTimeoutError);
    expect(String((err as Error).message)).toMatch(new RegExp(`all 1 machine-wide browser slot\\(s\\) stayed busy \\(slot 0: pid ${process.pid} on h\\)`));
  });

  it("refuses a non-positive cap", async () => {
    await expect(new MachineBrowserSlots({ dir }).acquire(0, Date.now())).rejects.toThrow(RangeError);
  });

  it("release only removes the slot it holds (never a successor's)", () => {
    const slots = new MachineBrowserSlots({ dir });
    const lease = slots.tryAcquire(1)!;
    // Simulate the slot having been reclaimed as stale and re-taken by someone else.
    writeFileSync(slotFile(0), JSON.stringify({ pid: process.pid, host: "x", token: "successor", acquiredAt: "x" }));
    lease.release();
    expect(JSON.parse(readFileSync(slotFile(0), "utf8")).token).toBe("successor");
  });
});
