import { randomUUID } from "node:crypto";
import { type Stats, closeSync, constants, fstatSync, linkSync, lstatSync, mkdirSync, openSync, readSync, readdirSync, renameSync, rmdirSync, statSync, unlinkSync, utimesSync, writeFileSync } from "node:fs";
import { homedir, hostname } from "node:os";
import { join } from "node:path";
import { AdmissionTimeoutError } from "./browser-pool.js";
import { processAlive } from "./browser-processes.js";
import { clock } from "@jevitate/domain";

/**
 * #205: a MACHINE-WIDE cap on how many jevitate processes run browsers at once — shared by every
 * jevitate on this machine (other terminals, agents, CI jobs, another project's checks), not just
 * the contexts of one process (that is the pool's `maxContexts`).
 *
 * A counting semaphore made of files: slot `i` is held by whoever created `slot-<i>.json` (created
 * with `O_EXCL` — `wx` — so exactly one creator wins). A process with cap `N` only ever takes slots
 * `0..N-1`, so however the processes' caps differ, at most `max(caps)` hold a slot at once, and a
 * process with a lower cap waits until one of ITS slots is free.
 *
 * Unit: a jevitate PROCESS with at least one browser session open holds one slot (the governor
 * refcounts its sessions), never one per context — a mission that opens a second context while its
 * first is open (an observer actor, a hang replay) can never wait on itself.
 *
 * Stale holders (a jevitate killed with SIGKILL, a crashed CI job) are recovered: a slot is stale
 * when its holder is on THIS host and its pid is not running, or when its holder has not refreshed
 * the file's mtime (the heartbeat) for `staleAfterMs` — which also covers a holder on another host
 * sharing the directory and a pid reused by an unrelated process. Removal happens under a short
 * mkdir lock and only after re-reading the file proves it is still the stale holder judged.
 *
 * Every slot this process holds is removed synchronously on process exit (SIGTERM/SIGINT included —
 * the kill switch exits through `process.exit`).
 *
 * A process that found its slots busy announces it with `waiter-<token>.json` for as long as it waits,
 * so a holder able to give a slot up between sessions (`hasWaiter`) can see someone needs it. It only
 * ever makes a holder yield, never grants anything: the slot files alone decide who holds what. A
 * waiter counts while its process runs and its file is refreshed, each poll; a dead one's file is
 * ignored and removed, so it cannot make holders yield for ever. A jevitate older than this file
 * announces nothing, and waits as it always did.
 *
 * Only a small regular file is ever read: every holder reads these on its main thread, where a FIFO
 * or a link to a device at one of these names would stop the kill switch and the heartbeat too.
 * Anything else at a slot's name occupies that index and at a waiter's name is no waiter; neither is
 * removed, since this process did not write it.
 */

export const DEFAULT_SLOT_HEARTBEAT_MS = 20_000;
export const DEFAULT_SLOT_STALE_MS = 180_000;
/** How often a waiter re-checks the slots. */
export const DEFAULT_SLOT_POLL_MS = 500;
/** A cleanup lock older than this was left by a process that died inside the (millisecond) critical section. */
const LOCK_STALE_MS = 10_000;
/** An unparseable slot file younger than this may be mid-write; older, it is garbage. */
const UNREADABLE_GRACE_MS = 10_000;
/**
 * A waiter that has not refreshed its file for this long no longer counts, whatever its pid says (a
 * reused pid, a process on another host). Far above the poll, so a busy host only ever costs a holder
 * one missed yield: the waiter's next poll refreshes it.
 */
const DEFAULT_WAITER_STALE_MS = 15_000;
/** Far above any holder or waiter record. A larger file is not one, and reads as unparseable. */
const MAX_SLOT_FILE_BYTES = 4 * 1024;
/** Opening what `lstat` just called a file must not block or follow a link, if it was swapped since. Absent on Windows. */
const SLOT_OPEN_FLAGS = constants.O_RDONLY | (constants.O_NONBLOCK ?? 0) | (constants.O_NOFOLLOW ?? 0);

/** `~/.jevitate/run/browser-slots` (the directory every jevitate on this machine shares). */
export function defaultSlotDir(home: string = homedir()): string {
  return join(home, ".jevitate", "run", "browser-slots");
}

export interface SlotHolder {
  readonly pid: number;
  readonly host: string;
  readonly token: string;
  readonly acquiredAt: string;
}

export interface SlotState {
  readonly index: number;
  readonly path: string;
  /** null when the file could not be parsed. */
  readonly holder: SlotHolder | null;
  /** Last heartbeat (file mtime, ms since epoch). */
  readonly heartbeatAt: number;
  /** Why the holder counts as stale; null while it is live. */
  readonly stale: string | null;
  /** Something other than a regular file sits at this slot's name. It holds the index until a person removes it. */
  readonly notRegularFile?: true;
}

export interface MachineSlotLease {
  readonly index: number;
  readonly waitedMs: number;
  readonly cap: number;
  /** False once the slot file is no longer this lease's (reclaimed as stale after the machine slept). */
  isHeld(): boolean;
  release(): void;
}

export interface MachineSlotsOptions {
  readonly dir?: string;
  readonly host?: string;
  readonly pid?: number;
  readonly isAlive?: (pid: number) => boolean;
  readonly now?: () => number;
  readonly sleep?: (ms: number) => Promise<unknown>;
  readonly heartbeatMs?: number;
  readonly staleAfterMs?: number;
  readonly pollMs?: number;
  readonly waiterStaleMs?: number;
}

/** Slot and waiter files held by this process, removed on exit. */
const heldPaths = new Map<string, string>();
let exitHookInstalled = false;
function installExitHook(): void {
  if (exitHookInstalled) return;
  exitHookInstalled = true;
  process.once("exit", () => {
    for (const [path, token] of heldPaths) unlinkIfHeld(path, token);
  });
}

/**
 * Windows: a slot file another process just unlinked while someone still had it open lingers as
 * DELETE-PENDING until the last handle closes — opening, creating (`wx`) or renaming it fails with
 * EPERM/EACCES/EBUSY instead of ENOENT/EEXIST. That is a slot mid-release (gone in milliseconds),
 * never a permission problem; POSIX has no such state, so there these codes stay real errors.
 */
export function isTransientSlotError(err: unknown, platform: NodeJS.Platform = process.platform): boolean {
  const code = (err as NodeJS.ErrnoException | undefined)?.code;
  return platform === "win32" && (code === "EPERM" || code === "EACCES" || code === "EBUSY");
}

/** The file's text; null when what is there is not a small regular file; undefined when nothing is. */
function readSlotFile(path: string): string | null | undefined {
  let fd: number | undefined;
  try {
    if (!lstatSync(path).isFile()) return null;
    fd = openSync(path, SLOT_OPEN_FLAGS);
    const opened = fstatSync(fd);
    if (!opened.isFile() || opened.size > MAX_SLOT_FILE_BYTES) return null;
    const bytes = Buffer.alloc(MAX_SLOT_FILE_BYTES);
    return bytes.toString("utf8", 0, readSync(fd, bytes, 0, MAX_SLOT_FILE_BYTES, 0));
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || isTransientSlotError(err)) return undefined;
    if (code === "ELOOP") return null; // swapped for a link since the lstat
    throw err;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

function readHolder(path: string): SlotHolder | null | undefined {
  const text = readSlotFile(path);
  return text === undefined ? undefined : parseHolder(text);
}

function parseHolder(text: string | null): SlotHolder | null {
  if (text === null) return null;
  try {
    const h = JSON.parse(text) as Partial<SlotHolder>;
    if (typeof h.pid === "number" && typeof h.host === "string" && typeof h.token === "string") {
      return { pid: h.pid, host: h.host, token: h.token, acquiredAt: String(h.acquiredAt ?? "") };
    }
    return null;
  } catch {
    return null;
  }
}

function unlinkIfHeld(path: string, token: string): void {
  try {
    if (readHolder(path)?.token === token) unlinkSync(path);
  } catch {
    // already gone (or the directory was removed): nothing is held any more
  }
}

interface SlotWaiter {
  /** null when the file could not be parsed (it may be mid-write). */
  readonly holder: SlotHolder | null;
  readonly cap: number;
  /** When it began waiting (ms since epoch). */
  readonly since: number;
  readonly heartbeatAt: number;
}

function readWaiter(path: string): SlotWaiter | undefined {
  try {
    const seen = lstatSync(path);
    if (!seen.isFile()) return undefined;
    const text = readSlotFile(path);
    if (text === undefined) return undefined;
    const holder = parseHolder(text);
    const { cap, since } = holder === null || text === null ? ({} as { cap?: unknown; since?: unknown }) : (JSON.parse(text) as { cap?: unknown; since?: unknown });
    return { holder, cap: typeof cap === "number" ? cap : 0, since: typeof since === "number" ? since : 0, heartbeatAt: seen.mtimeMs };
  } catch {
    return undefined; // gone while it was read
  }
}

function removeQuietly(path: string): void {
  try {
    unlinkSync(path);
  } catch {
    // already gone, or (Windows) still open: a uniquely named waiter file is never a slot
  }
}

export class MachineBrowserSlots {
  readonly dir: string;
  readonly #host: string;
  readonly #pid: number;
  readonly #isAlive: (pid: number) => boolean;
  readonly #now: () => number;
  readonly #sleep: (ms: number) => Promise<unknown>;
  readonly #heartbeatMs: number;
  readonly #staleAfterMs: number;
  readonly #pollMs: number;
  readonly #waiterStaleMs: number;

  constructor(opts: MachineSlotsOptions = {}) {
    this.dir = opts.dir ?? defaultSlotDir();
    this.#host = opts.host ?? hostname();
    this.#pid = opts.pid ?? process.pid;
    this.#isAlive = opts.isAlive ?? processAlive;
    this.#now = opts.now ?? clock.now;
    this.#sleep = opts.sleep ?? ((ms) => clock.sleep(ms));
    this.#heartbeatMs = opts.heartbeatMs ?? DEFAULT_SLOT_HEARTBEAT_MS;
    this.#staleAfterMs = opts.staleAfterMs ?? DEFAULT_SLOT_STALE_MS;
    this.#pollMs = opts.pollMs ?? DEFAULT_SLOT_POLL_MS;
    this.#waiterStaleMs = opts.waiterStaleMs ?? DEFAULT_WAITER_STALE_MS;
  }

  #path(index: number): string {
    return join(this.dir, `slot-${index}.json`);
  }

  /** Why `holder` (heartbeat at `heartbeatAt`) is stale, or null. */
  #staleReason(holder: SlotHolder | null, heartbeatAt: number): string | null {
    const age = this.#now() - heartbeatAt;
    if (holder === null) return age > UNREADABLE_GRACE_MS ? "unreadable slot file" : null;
    if (holder.host === this.#host && !this.#isAlive(holder.pid)) return `holder pid ${holder.pid} on ${holder.host} is not running`;
    if (age > this.#staleAfterMs) return `holder pid ${holder.pid} on ${holder.host} sent no heartbeat for ${Math.round(age / 1000)}s`;
    return null;
  }

  /** Every slot file present, with its holder and whether it is stale. */
  list(): SlotState[] {
    let names: string[];
    try {
      names = readdirSync(this.dir);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw err;
    }
    const out: SlotState[] = [];
    for (const name of names) {
      const m = /^slot-(\d+)\.json$/.exec(name);
      if (m === null) continue;
      const state = this.#state(Number(m[1]));
      if (state !== undefined) out.push(state);
    }
    return out.sort((a, b) => a.index - b.index);
  }

  #state(index: number): SlotState | undefined {
    const path = this.#path(index);
    const holder = readHolder(path);
    if (holder === undefined) return undefined;
    let seen: Stats;
    try {
      seen = lstatSync(path);
    } catch {
      return undefined;
    }
    // Not a file any holder wrote, so not a holder's to reclaim: it keeps this index.
    if (!seen.isFile()) return { index, path, holder, heartbeatAt: seen.mtimeMs, stale: null, notRegularFile: true };
    return { index, path, holder, heartbeatAt: seen.mtimeMs, stale: this.#staleReason(holder, seen.mtimeMs) };
  }

  /** Removes every stale slot; returns what was removed. */
  clearStale(): SlotState[] {
    const cleared: SlotState[] = [];
    for (const s of this.list()) if (s.stale !== null && this.#removeStale(s)) cleared.push(s);
    this.hasWaiter(0); // drops stale waiters' files as a side effect
    return cleared;
  }

  /**
   * Removes slot `s` if it is STILL the stale holder judged: under the cleanup lock, the file is
   * moved aside and re-read; when it turned out to be someone else's (a fresh holder that replaced
   * it in between) it is moved back.
   */
  #removeStale(s: SlotState): boolean {
    const lock = join(this.dir, ".cleanup.lock");
    try {
      mkdirSync(lock);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
      try {
        if (this.#now() - statSync(lock).mtimeMs > LOCK_STALE_MS) rmdirSync(lock);
      } catch {
        // another cleaner removed it first
      }
      return false;
    }
    try {
      const aside = `${s.path}.stale-${randomUUID()}`;
      try {
        renameSync(s.path, aside);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === "ENOENT" || isTransientSlotError(err)) return false;
        throw err;
      }
      const moved = readHolder(aside);
      const same = s.holder === null ? moved === null : moved?.token === s.holder.token;
      if (!same) {
        try {
          linkSync(aside, s.path);
        } catch {
          // a new holder took the index meanwhile; the moved file's owner re-acquires on its next heartbeat miss
        }
      }
      try {
        unlinkSync(aside);
      } catch (err) {
        // Windows: a reader still has it open; the uniquely named aside file is never a slot file
        if (!isTransientSlotError(err)) throw err;
      }
      return same;
    } finally {
      rmdirSync(lock);
    }
  }

  /** Takes a free slot in `0..cap-1` now, or undefined when all are held by live holders. */
  tryAcquire(cap: number): MachineSlotLease | undefined {
    return this.#tryAcquire(cap, this.#now());
  }

  #tryAcquire(cap: number, started: number): MachineSlotLease | undefined {
    mkdirSync(this.dir, { recursive: true });
    for (let index = 0; index < cap; index++) {
      const path = this.#path(index);
      // A stale holder removed on the first attempt frees the index for the second.
      for (let attempt = 0; attempt < 2; attempt++) {
        const holder: SlotHolder = { pid: this.#pid, host: this.#host, token: randomUUID(), acquiredAt: new Date(this.#now()).toISOString() };
        try {
          writeFileSync(path, `${JSON.stringify(holder)}\n`, { flag: "wx" });
        } catch (err) {
          // Windows: the previous holder's file is still being deleted — busy for now, next poll retries.
          if (isTransientSlotError(err)) break;
          if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
          const s = this.#state(index);
          if (s !== undefined && s.stale !== null && this.#removeStale(s)) continue;
          if (s === undefined) continue; // released between the create and the read: try again
          break;
        }
        return this.#lease(index, path, holder.token, cap, this.#now() - started);
      }
    }
    return undefined;
  }

  #lease(index: number, path: string, token: string, cap: number, waitedMs: number): MachineSlotLease {
    installExitHook();
    heldPaths.set(path, token);
    const beat = clock.setInterval(() => {
      const t = new Date(this.#now());
      try {
        utimesSync(path, t, t);
      } catch {
        // removed as stale (e.g. the machine slept past the stale bound): the next acquire re-takes a slot
      }
    }, this.#heartbeatMs);
    beat.unref();
    let released = false;
    return {
      index,
      waitedMs,
      cap,
      isHeld: () => {
        try {
          return readHolder(path)?.token === token;
        } catch {
          return false;
        }
      },
      release: () => {
        if (released) return;
        released = true;
        clock.clearInterval(beat);
        heldPaths.delete(path);
        unlinkIfHeld(path, token);
      },
    };
  }

  /**
   * Is another process waiting for a slot that slot `index` would serve? A waiter whose cap stops
   * below `index` would not be helped by it. Stale waiters do not count, and their files are removed.
   * With `announcedBy` (ms since epoch), only a waiter already waiting by then counts.
   */
  hasWaiter(index: number, announcedBy: number = Number.POSITIVE_INFINITY): boolean {
    let names: string[];
    try {
      names = readdirSync(this.dir);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return false;
      throw err;
    }
    let found = false;
    // No early exit: every stale file met is cleared, whichever waiter is live.
    for (const name of names) {
      if (!/^waiter-.+\.json$/.test(name)) continue;
      const path = join(this.dir, name);
      const waiter = readWaiter(path);
      if (waiter === undefined) continue;
      if (this.#waiterStale(waiter)) {
        removeQuietly(path);
        continue;
      }
      const own = waiter.holder?.pid === this.#pid && waiter.holder.host === this.#host;
      if (!own && waiter.holder !== null && waiter.cap > index && waiter.since <= announcedBy) found = true;
    }
    return found;
  }

  #waiterStale(waiter: SlotWaiter): boolean {
    // Either way round: a timestamp far in the future (a clock moved back) must not keep a waiter live.
    if (Math.abs(this.#now() - waiter.heartbeatAt) > this.#waiterStaleMs) return true;
    return waiter.holder !== null && waiter.holder.host === this.#host && !this.#isAlive(waiter.holder.pid);
  }

  /**
   * Announces (or refreshes) this process as waiting for a slot under `cap`. Best effort: one that
   * cannot be announced still waits, and a holder simply does not yield to it.
   */
  #announceWaiting(cap: number, announced: { path: string; token: string } | undefined): { path: string; token: string } {
    const token = announced?.token ?? randomUUID();
    const path = announced?.path ?? join(this.dir, `waiter-${token}.json`);
    const t = new Date(this.#now());
    try {
      if (announced !== undefined) {
        utimesSync(path, t, t);
        return announced;
      }
    } catch (err) {
      // A holder judged this waiter stale and removed the file (a long stall here): announce it again.
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") return { path, token };
    }
    try {
      writeFileSync(path, `${JSON.stringify({ pid: this.#pid, host: this.#host, token, cap, since: t.getTime() })}\n`);
      utimesSync(path, t, t);
      installExitHook();
      heldPaths.set(path, token);
    } catch {
      // Nothing to undo: an unannounced waiter is what an older jevitate is.
    }
    return { path, token };
  }

  /**
   * Waits (polling) until a slot in `0..cap-1` is free, until `deadline` (ms since epoch); past it
   * fails with `AdmissionTimeoutError` naming who holds the slots. `deferToWaiters` is for a holder
   * that just yielded slot `index`: for `forMs` it leaves free slots to a live waiter that slot serves,
   * since otherwise it would retake the slot before the waiter's next poll and yielding would do nothing.
   * Only a waiter already waiting when this call began counts, so two holders that yielded in turn do
   * not defer to each other: the later one defers, the earlier one takes the slot.
   */
  async acquire(cap: number, deadline: number, opts: { readonly deferToWaiters?: { readonly index: number; readonly forMs: number } } = {}): Promise<MachineSlotLease> {
    if (!Number.isInteger(cap) || cap < 1) throw new RangeError(`maxBrowsers must be a positive integer, got ${cap}`);
    const started = this.#now();
    const defer = opts.deferToWaiters;
    let announced: { path: string; token: string } | undefined;
    try {
      for (;;) {
        const deferring = defer !== undefined && this.#now() - started < defer.forMs && this.hasWaiter(defer.index, started);
        const lease = deferring ? undefined : this.#tryAcquire(cap, started);
        if (lease !== undefined) return lease;
        const remaining = deadline - this.#now();
        if (remaining <= 0) {
          const states = this.list().filter((s) => s.index < cap);
          const holders = states.map((s) => (s.notRegularFile === true ? `slot ${s.index}: ${s.path} is not a regular file` : s.holder === null ? `slot ${s.index}: unreadable` : `slot ${s.index}: pid ${s.holder.pid} on ${s.holder.host}`));
          const blocked = states.filter((s) => s.notRegularFile === true);
          const others = blocked.length === states.length ? "" : "Other jevitate runs on this machine hold the rest (see `jevitate doctor`); ";
          const remove = blocked.length === 0 ? "" : `No run holds ${blocked.map((s) => s.path).join(", ")}, and jevitate never removes one: remove it by hand. `;
          throw new AdmissionTimeoutError(
            `admission timed out after ${Math.round((this.#now() - started) / 1000)}s: all ${cap} machine-wide browser slot(s) stayed busy (${holders.join("; ")}). ` +
              (blocked.length === 0
                ? `Other jevitate runs on this machine hold them (see \`jevitate doctor\`); wait, raise --max-browsers / JEVITATE_MAX_BROWSERS, or raise JEVITATE_ADMISSION_TIMEOUT_MS.`
                : `${remove}${others}you can also raise --max-browsers / JEVITATE_MAX_BROWSERS.`),
          );
        }
        announced = this.#announceWaiting(cap, announced);
        await this.#sleep(Math.min(this.#pollMs, remaining));
      }
    } finally {
      if (announced !== undefined) {
        heldPaths.delete(announced.path);
        removeQuietly(announced.path);
      }
    }
  }
}
