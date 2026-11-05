import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { FakeClock, clock, installClock, resetClock } from "@jevitate/domain";
import { MachineBrowserSlots, isTransientSlotError, type MachineSlotLease } from "./machine-slots.js";
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
    const modUrl = new URL("../dist/machine-slots.js", import.meta.url);
    expect(existsSync(fileURLToPath(modUrl)), "build @jevitate/playwright first (pnpm -r build)").toBe(true);
    // import() takes a URL: a bare Windows path (`D:\…`) parses as the scheme `d:` and is refused.
    const mod = modUrl.href;
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

describe("a process waiting for a slot (#766)", () => {
  const HOLDER = 100;
  const WAITER = 200;
  let fake: FakeClock;
  let leases: MachineSlotLease[];
  let waits: Promise<unknown>[];

  const slotsOf = (pid: number, extra: { isAlive?: (pid: number) => boolean } = {}): MachineBrowserSlots => new MachineBrowserSlots({ dir, host: "h", pid, isAlive: () => true, ...extra });
  const held = (): MachineSlotLease => {
    const lease = slotsOf(HOLDER).tryAcquire(1)!;
    leases.push(lease);
    return lease;
  };
  /** Starts another process's wait, already announced when this returns. */
  const waitFor = (cap = 1, forMs = 60_000): Promise<MachineSlotLease> => {
    const waiting = slotsOf(WAITER).acquire(cap, clock.now() + forMs);
    waits.push(waiting.then((lease) => void leases.push(lease), () => undefined));
    return waiting;
  };
  /** A waiter's file as a process that has stopped refreshing it left it, `ageMs` ago. */
  const leftBehind = (ageMs: number, pid = WAITER): string => {
    const path = join(dir, "waiter-left.json");
    writeFileSync(path, JSON.stringify({ pid, host: "h", token: "left", cap: 1 }));
    const t = new Date(clock.now() - ageMs);
    utimesSync(path, t, t);
    return path;
  };

  beforeEach(() => {
    fake = new FakeClock();
    installClock(fake);
    leases = [];
    waits = [];
  });
  afterEach(async () => {
    // Each release lets the next wait in, at most one per wait.
    for (let turn = 0; turn <= waits.length; turn++) {
      for (const lease of leases) lease.release();
      await fake.advanceBy(1_000);
    }
    await fake.advanceBy(120_000);
    await Promise.all(waits);
    for (const lease of leases) lease.release();
    resetClock();
  });

  it("is visible to a holder", () => {
    held();
    void waitFor();
    expect(slotsOf(HOLDER).hasWaiter(0)).toBe(true);
  });

  it("stays visible for as long as it keeps waiting", async () => {
    held();
    void waitFor();
    await fake.advanceBy(30_000);
    expect(slotsOf(HOLDER).hasWaiter(0)).toBe(true);
  });

  it("is not visible once it has the slot", async () => {
    const lease = held();
    const waiting = waitFor();
    lease.release();
    await fake.advanceBy(500);
    await waiting;
    expect(slotsOf(HOLDER).hasWaiter(0)).toBe(false);
  });

  it("is not visible once it has given up", async () => {
    held();
    const waiting = waitFor(1, 1_000).catch(() => undefined);
    await fake.advanceBy(1_000);
    await waiting;
    expect(slotsOf(HOLDER).hasWaiter(0)).toBe(false);
  });

  it("does not count when its process is dead", () => {
    leftBehind(0);
    expect(slotsOf(HOLDER, { isAlive: (pid) => pid !== WAITER }).hasWaiter(0)).toBe(false);
  });

  it("does not count when its file stopped being refreshed, even with its pid alive", () => {
    leftBehind(16_000);
    expect(slotsOf(HOLDER).hasWaiter(0)).toBe(false);
  });

  it("has its stale file removed by the holder that judged it", () => {
    const path = leftBehind(16_000);
    slotsOf(HOLDER).hasWaiter(0);
    expect(existsSync(path)).toBe(false);
  });

  it("has its stale file removed by clearStale", () => {
    const path = leftBehind(16_000);
    slotsOf(HOLDER).clearStale();
    expect(existsSync(path)).toBe(false);
  });

  it("announces itself again after a holder wrongly judged it stale", async () => {
    held();
    void waitFor();
    for (const name of readdirSync(dir)) if (name.startsWith("waiter-")) rmSync(join(dir, name));
    await fake.advanceBy(500);
    expect(slotsOf(HOLDER).hasWaiter(0)).toBe(true);
  });

  it("does not count for a slot above its own cap", () => {
    void waitFor(1);
    expect(slotsOf(HOLDER).hasWaiter(1)).toBe(false);
  });

  it("does not count for its own process", () => {
    held();
    void waitFor();
    expect(slotsOf(WAITER).hasWaiter(0)).toBe(false);
  });

  it("is not a slot: `list` does not show it", () => {
    leftBehind(0);
    expect(slotsOf(HOLDER).list()).toEqual([]);
  });

  it("gets the slot from a holder deferring to it, though the holder asked first", async () => {
    const lease = held();
    const waiting = waitFor();
    lease.release();
    const deferring = slotsOf(HOLDER).acquire(1, clock.now() + 60_000, { deferToWaiters: { index: 0, forMs: 5_000 } });
    waits.push(deferring.then((l) => void leases.push(l), () => undefined));
    await fake.advanceBy(500);
    await waiting;
    expect(JSON.parse(readFileSync(slotFile(0), "utf8")).pid).toBe(WAITER);
  });

  it("does not hold back a deferring holder that began waiting before it did", async () => {
    const other = slotsOf(HOLDER).tryAcquire(1)!;
    const earlier = slotsOf(300).acquire(1, clock.now() + 60_000, { deferToWaiters: { index: 0, forMs: 5_000 } });
    waits.push(earlier.then((l) => void leases.push(l), () => undefined));
    await fake.advanceBy(1_000);
    void waitFor();
    other.release();
    await fake.advanceBy(500);
    expect(JSON.parse(readFileSync(slotFile(0), "utf8")).pid).toBe(300);
  });

  it("holds a deferring holder back no longer than the grace it was given", async () => {
    leftBehind(0);
    const deferring = slotsOf(HOLDER).acquire(1, clock.now() + 60_000, { deferToWaiters: { index: 0, forMs: 2_000 } });
    // Short of the waiter's stale bound, so it is still live when the grace ends.
    await fake.advanceBy(2_000);
    const lease = await deferring;
    leases.push(lease);
    expect(lease.index).toBe(0);
  });
});

describe("a lease", () => {
  it("is held while its slot file is its own", () => {
    const lease = new MachineBrowserSlots({ dir }).tryAcquire(1)!;
    expect(lease.isHeld()).toBe(true);
    lease.release();
  });

  it("is not held once its slot was reclaimed and taken by someone else", () => {
    const lease = new MachineBrowserSlots({ dir }).tryAcquire(1)!;
    writeFileSync(slotFile(0), JSON.stringify({ pid: process.pid, host: "x", token: "successor", acquiredAt: "x" }));
    expect(lease.isHeld()).toBe(false);
    lease.release();
  });
});

describe("isTransientSlotError (Windows delete-pending slot files)", () => {
  const e = (code: string): NodeJS.ErrnoException => Object.assign(new Error(code), { code });
  it("EPERM/EACCES/EBUSY are a slot mid-release on Windows only; real errors elsewhere", () => {
    for (const code of ["EPERM", "EACCES", "EBUSY"]) {
      expect(isTransientSlotError(e(code), "win32")).toBe(true);
      expect(isTransientSlotError(e(code), "linux")).toBe(false);
      expect(isTransientSlotError(e(code), "darwin")).toBe(false);
    }
    expect(isTransientSlotError(e("ENOSPC"), "win32")).toBe(false);
    expect(isTransientSlotError(undefined, "win32")).toBe(false);
  });
});

/**
 * What only the file's type or size rules out. A fix that is removed must fail here, not hang the
 * worker, so the FIFOs always have a writer: a read that should not have happened then succeeds.
 */
describe.skipIf(process.platform === "win32")("what is not a small regular file at a slot's or a waiter's name", () => {
  const OTHER_PID = 4242;
  const slots = (): MachineBrowserSlots => new MachineBrowserSlots({ dir, host: "h", pid: 1, isAlive: () => true });
  const record = (): string => JSON.stringify({ pid: OTHER_PID, host: "h", token: "t", cap: 1, since: 0 });
  const writers: ReturnType<typeof spawn>[] = [];

  /** A FIFO that hands `text` to every reader, until the test ends. */
  const fifoServing = (path: string, text: string): void => {
    spawnSync("sh", ["-c", 'mkfifo "$1"', "sh", path]);
    writers.push(spawn("sh", ["-c", 'while :; do printf %s "$1" > "$2"; done', "sh", text, path], { stdio: "ignore" }));
  };
  const linkToRecord = (name: string): string => {
    const target = join(dir, "elsewhere.txt");
    writeFileSync(target, record());
    symlinkSync(target, join(dir, name));
    return target;
  };

  afterEach(() => {
    for (const writer of writers.splice(0)) writer.kill("SIGKILL");
  });

  it("a FIFO at a waiter's name does not count as a waiter", () => {
    fifoServing(join(dir, "waiter-f.json"), record());
    expect(slots().hasWaiter(0)).toBe(false);
  });

  it("a link at a waiter's name does not count as a waiter", () => {
    linkToRecord("waiter-l.json");
    expect(slots().hasWaiter(0)).toBe(false);
  });

  it("an oversized file at a waiter's name does not count as a waiter", () => {
    writeFileSync(join(dir, "waiter-big.json"), record() + " ".repeat(8_192));
    expect(slots().hasWaiter(0)).toBe(false);
  });

  it("a small regular file at a waiter's name still counts as a waiter", () => {
    writeFileSync(join(dir, "waiter-ok.json"), record());
    expect(slots().hasWaiter(0)).toBe(true);
  });

  it("an old link at a waiter's name is left in place", () => {
    linkToRecord("waiter-l.json");
    new MachineBrowserSlots({ dir, host: "h", pid: 1, isAlive: () => true, waiterStaleMs: -1 }).hasWaiter(0);
    expect(lstatSync(join(dir, "waiter-l.json")).isSymbolicLink()).toBe(true);
  });

  it("an old oversized file at a waiter's name is removed like any other unreadable waiter", () => {
    const path = join(dir, "waiter-big.json");
    writeFileSync(path, "x".repeat(8_192));
    new MachineBrowserSlots({ dir, host: "h", pid: 1, isAlive: () => true, waiterStaleMs: -1 }).hasWaiter(0);
    expect(existsSync(path)).toBe(false);
  });

  it("a FIFO at a slot's name reads as an unreadable holder", () => {
    fifoServing(slotFile(0), record());
    expect(slots().list()[0]?.holder).toBeNull();
  });

  it("a link at a slot's name reads as an unreadable holder", () => {
    linkToRecord("slot-0.json");
    expect(slots().list()[0]?.holder).toBeNull();
  });

  it("an oversized file at a slot's name reads as an unreadable holder", () => {
    writeFileSync(slotFile(0), record() + " ".repeat(8_192));
    expect(slots().list()[0]?.holder).toBeNull();
  });

  it("a link at a slot's name keeps that index from being taken", () => {
    linkToRecord("slot-0.json");
    const lease = slots().tryAcquire(2);
    lease?.release();
    expect(lease?.index).toBe(1);
  });

  it("an old link at a slot's name is not cleared as stale", () => {
    linkToRecord("slot-0.json");
    new MachineBrowserSlots({ dir, host: "h", pid: 1, isAlive: () => true, now: () => Date.now() + 3_600_000 }).clearStale();
    expect(lstatSync(slotFile(0)).isSymbolicLink()).toBe(true);
  });

  it("a directory at a slot's name keeps that index instead of failing the acquire", () => {
    mkdirSync(slotFile(0));
    const lease = slots().tryAcquire(2);
    lease?.release();
    expect(lease?.index).toBe(1);
  });

  it("a slot's non-regular file is reported as one", () => {
    linkToRecord("slot-0.json");
    expect(slots().list()[0]?.notRegularFile).toBe(true);
  });

  it("clearStale removes no old non-regular file", () => {
    mkdirSync(slotFile(0));
    expect(new MachineBrowserSlots({ dir, host: "h", pid: 1, isAlive: () => true, now: () => Date.now() + 3_600_000 }).clearStale()).toEqual([]);
  });

  it("a regular slot file is not reported as a non-regular one", () => {
    const lease = slots().tryAcquire(1);
    const reported = slots().list()[0]?.notRegularFile;
    lease?.release();
    expect(reported).toBeUndefined();
  });

  it("an admission timeout names the non-regular slot file's path", async () => {
    mkdirSync(slotFile(0));
    await expect(slots().acquire(1, Date.now())).rejects.toThrow(`${slotFile(0)} is not a regular file`);
  });

  it("an admission timeout on non-regular slot files alone does not blame other runs", async () => {
    mkdirSync(slotFile(0));
    await expect(slots().acquire(1, Date.now())).rejects.not.toThrow(/Other jevitate runs/);
  });

  it("an admission timeout on live holders still blames other runs", async () => {
    const lease = slots().tryAcquire(1);
    const timedOut = slots().acquire(1, Date.now());
    await expect(timedOut.finally(() => lease?.release())).rejects.toThrow(/Other jevitate runs on this machine hold them/);
  });

  it("a regular holder's slot is still released by its own process", () => {
    const lease = slots().tryAcquire(1);
    lease?.release();
    expect(existsSync(slotFile(0))).toBe(false);
  });
});
