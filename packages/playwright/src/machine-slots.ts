import { randomUUID } from "node:crypto";
import { linkSync, mkdirSync, readFileSync, readdirSync, renameSync, rmdirSync, statSync, unlinkSync, utimesSync, writeFileSync } from "node:fs";
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
 */

export const DEFAULT_SLOT_HEARTBEAT_MS = 20_000;
export const DEFAULT_SLOT_STALE_MS = 180_000;
/** How often a waiter re-checks the slots. */
export const DEFAULT_SLOT_POLL_MS = 500;
/** A cleanup lock older than this was left by a process that died inside the (millisecond) critical section. */
const LOCK_STALE_MS = 10_000;
/** An unparseable slot file younger than this may be mid-write; older, it is garbage. */
const UNREADABLE_GRACE_MS = 10_000;

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
}

export interface MachineSlotLease {
  readonly index: number;
  readonly waitedMs: number;
  readonly cap: number;
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
}

/** Slot files held by this process, removed on exit. */
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

function readHolder(path: string): SlotHolder | null | undefined {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT" || isTransientSlotError(err)) return undefined;
    throw err;
  }
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
    let heartbeatAt: number;
    try {
      heartbeatAt = statSync(path).mtimeMs;
    } catch {
      return undefined;
    }
    return { index, path, holder, heartbeatAt, stale: this.#staleReason(holder, heartbeatAt) };
  }

  /** Removes every stale slot; returns what was removed. */
  clearStale(): SlotState[] {
    const cleared: SlotState[] = [];
    for (const s of this.list()) if (s.stale !== null && this.#removeStale(s)) cleared.push(s);
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
   * Waits (polling) until a slot in `0..cap-1` is free, until `deadline` (ms since epoch); past it
   * fails with `AdmissionTimeoutError` naming who holds the slots.
   */
  async acquire(cap: number, deadline: number): Promise<MachineSlotLease> {
    if (!Number.isInteger(cap) || cap < 1) throw new RangeError(`maxBrowsers must be a positive integer, got ${cap}`);
    const started = this.#now();
    for (;;) {
      const lease = this.#tryAcquire(cap, started);
      if (lease !== undefined) return lease;
      const remaining = deadline - this.#now();
      if (remaining <= 0) {
        const holders = this.list()
          .filter((s) => s.index < cap)
          .map((s) => (s.holder === null ? `slot ${s.index}: unreadable` : `slot ${s.index}: pid ${s.holder.pid} on ${s.holder.host}`));
        throw new AdmissionTimeoutError(
          `admission timed out after ${Math.round((this.#now() - started) / 1000)}s: all ${cap} machine-wide browser slot(s) stayed busy (${holders.join("; ")}). ` +
            `Other jevitate runs on this machine hold them (see \`jevitate doctor\`); wait, raise --max-browsers / JEVITATE_MAX_BROWSERS, or raise JEVITATE_ADMISSION_TIMEOUT_MS.`,
        );
      }
      await this.#sleep(Math.min(this.#pollMs, remaining));
    }
  }
}
