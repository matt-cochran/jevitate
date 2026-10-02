import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import { clock } from "@jevitate/domain";

/**
 * #205: which browser processes jevitate started, how much memory they use, and which of them a
 * killed jevitate left behind.
 *
 * Every Chromium jevitate launches carries one extra command-line switch naming its OWNER —
 * `--jevitate-owner=<pid>@<start>`: the launching jevitate process's pid and that process's start
 * time (Linux `/proc/<pid>/stat` starttime ticks; `0` where the platform gives none). Chromium ignores
 * unknown switches; the switch is visible in the process table (`/proc/<pid>/cmdline`, `ps`), so:
 *
 *  - the MEMORY of "this run's browsers" is the marked processes whose owner is this process, plus
 *    every descendant (renderers, GPU, utility processes) — `measureOwnBrowserMemory`;
 *  - an ORPHAN is a marked process whose owner is gone: the owner pid is not running, or it is
 *    running but started at another time (the pid was reused) — `findOrphanBrowsers`. Only marked
 *    processes are ever candidates: nothing jevitate did not start is ever signalled.
 *
 * Linux (and WSL) reads `/proc`; macOS one `ps` call; Windows has no supported reader — every
 * function there reports `unsupported`, never a guess (the memory ceiling is then not enforced and
 * the result says so).
 */

/** The owner-marker switch every jevitate-launched Chromium carries. */
export const OWNER_MARKER_SWITCH = "--jevitate-owner";

export interface ProcessInfo {
  readonly pid: number;
  readonly ppid: number;
  /** The command line, one argument per entry (macOS: split on spaces, enough for the marker). */
  readonly argv: readonly string[];
}

export interface OwnerMarker {
  readonly pid: number;
  /** The owner's start time token (`0` = unknown on this platform). */
  readonly start: string;
}

export interface MarkedBrowser {
  readonly pid: number;
  readonly owner: OwnerMarker;
}

/** Process-table access, injectable so tests restrict what is read (and so what may be signalled). */
export interface ProcessTable {
  /** Every process, or `undefined` where the platform has no supported reader. */
  list(): ProcessInfo[] | undefined;
  /** A process's start token (`0` = unknown), or undefined when it is not running. */
  startOf(pid: number): string | undefined;
  /** Memory of one process (bytes) and what the number is, or undefined (gone / unsupported). */
  memoryOf(pid: number): { readonly bytes: number; readonly metric: MemoryMetric } | undefined;
  /** Direct children of `pid`, when the platform lists them cheaply (Linux `/proc/<pid>/task/<tid>/children`). */
  childrenOf?(pid: number): number[] | undefined;
}

/** `pss` (Linux proportional set size — shared pages split between their users) or `rss`. */
export type MemoryMetric = "pss" | "rss";

/** Is `pid` running? `EPERM` (another user's live process) counts as running. */
export function processAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

function readText(path: string): string | undefined {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return undefined;
  }
}

/** Fields of `/proc/<pid>/stat` after the `(comm)` field: index 0 is field 3 (state). */
function statFields(pid: number): string[] | undefined {
  const text = readText(`/proc/${pid}/stat`);
  if (text === undefined) return undefined;
  const close = text.lastIndexOf(")");
  if (close < 0) return undefined;
  return text.slice(close + 2).trim().split(/\s+/);
}

const linuxTable: ProcessTable = {
  list() {
    let names: string[];
    try {
      names = readdirSync("/proc");
    } catch {
      return undefined;
    }
    const out: ProcessInfo[] = [];
    for (const name of names) {
      if (!/^\d+$/.test(name)) continue;
      const pid = Number(name);
      const fields = statFields(pid);
      const cmdline = readText(`/proc/${pid}/cmdline`);
      if (fields === undefined || cmdline === undefined) continue; // exited while listing
      out.push({ pid, ppid: Number(fields[1]), argv: cmdline.split("\0").filter((a) => a !== "") });
    }
    return out;
  },
  startOf(pid) {
    if (!processAlive(pid)) return undefined;
    return statFields(pid)?.[19] ?? "0";
  },
  memoryOf(pid) {
    const rollup = readText(`/proc/${pid}/smaps_rollup`);
    const pss = rollup === undefined ? undefined : /^Pss:\s+(\d+)\s+kB/m.exec(rollup)?.[1];
    if (pss !== undefined) return { bytes: Number(pss) * 1024, metric: "pss" };
    const status = readText(`/proc/${pid}/status`);
    const rss = status === undefined ? undefined : /^VmRSS:\s+(\d+)\s+kB/m.exec(status)?.[1];
    return rss === undefined ? undefined : { bytes: Number(rss) * 1024, metric: "rss" };
  },
  childrenOf(pid) {
    let tids: string[];
    try {
      tids = readdirSync(`/proc/${pid}/task`);
    } catch {
      return undefined;
    }
    const kids: number[] = [];
    for (const tid of tids) {
      const text = readText(`/proc/${pid}/task/${tid}/children`);
      if (text === undefined) return undefined; // kernel without CONFIG_PROC_CHILDREN: caller scans instead
      for (const k of text.trim().split(/\s+/)) if (k !== "") kids.push(Number(k));
    }
    return kids;
  },
};

function psRows(): { pid: number; ppid: number; rssKiB: number; command: string }[] | undefined {
  let text: string;
  try {
    text = execFileSync("ps", ["-A", "-o", "pid=,ppid=,rss=,command="], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  } catch {
    return undefined;
  }
  const rows: { pid: number; ppid: number; rssKiB: number; command: string }[] = [];
  for (const line of text.split("\n")) {
    const m = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(.*)$/.exec(line);
    if (m !== null) rows.push({ pid: Number(m[1]), ppid: Number(m[2]), rssKiB: Number(m[3]), command: m[4]! });
  }
  return rows;
}

/** One `ps` listing reused for the memory reads of one measurement (they happen within milliseconds). */
let psCache: { at: number; rows: ReturnType<typeof psRows> } | undefined;
function cachedPsRows(): ReturnType<typeof psRows> {
  if (psCache === undefined || clock.now() - psCache.at > 500) psCache = { at: clock.now(), rows: psRows() };
  return psCache.rows;
}

const darwinTable: ProcessTable = {
  list() {
    return psRows()?.map((r) => ({ pid: r.pid, ppid: r.ppid, argv: r.command.split(" ").filter((a) => a !== "") }));
  },
  startOf(pid) {
    return processAlive(pid) ? "0" : undefined;
  },
  memoryOf(pid) {
    const row = cachedPsRows()?.find((r) => r.pid === pid);
    return row === undefined ? undefined : { bytes: row.rssKiB * 1024, metric: "rss" };
  },
};

const unsupportedTable: ProcessTable = {
  list: () => undefined,
  startOf: (pid) => (processAlive(pid) ? "0" : undefined),
  memoryOf: () => undefined,
};

/** This platform's process table (`unsupported` on Windows). */
export function systemProcessTable(platform: NodeJS.Platform = process.platform): ProcessTable {
  if (platform === "linux") return linuxTable;
  if (platform === "darwin") return darwinTable;
  return unsupportedTable;
}

/** The marker switch for a browser launched by `pid` (default: this process). */
export function ownerMarkerArg(pid: number = process.pid, table: ProcessTable = systemProcessTable()): string {
  return `${OWNER_MARKER_SWITCH}=${pid}@${table.startOf(pid) ?? "0"}`;
}

/**
 * The owner a command line's marker names, or undefined for an unmarked process. Matched as a
 * whitespace-delimited token anywhere in an argument: Chromium rewrites its own process title into
 * ONE space-joined `argv[0]`, so `/proc/<pid>/cmdline` of a running browser has no separators.
 */
export function parseOwnerMarker(argv: readonly string[]): OwnerMarker | undefined {
  for (const a of argv) {
    const m = /(?:^|\s)--jevitate-owner=(\d+)@(\w+)(?=\s|$)/.exec(a);
    if (m !== null) return { pid: Number(m[1]), start: m[2]! };
  }
  return undefined;
}

/** Every marked (jevitate-launched) browser process in `procs`. */
export function markedBrowsers(procs: readonly ProcessInfo[]): MarkedBrowser[] {
  const out: MarkedBrowser[] = [];
  for (const p of procs) {
    const owner = parseOwnerMarker(p.argv);
    if (owner !== undefined) out.push({ pid: p.pid, owner });
  }
  return out;
}

/** Why a marked browser's owner is gone, or null when its owner is still the process that launched it. */
export function orphanReason(browser: MarkedBrowser, table: ProcessTable): string | null {
  const start = table.startOf(browser.owner.pid);
  if (start === undefined) return `its jevitate process (pid ${browser.owner.pid}) is no longer running`;
  if (browser.owner.start !== "0" && start !== "0" && start !== browser.owner.start) {
    return `pid ${browser.owner.pid} now belongs to another process (its jevitate process exited)`;
  }
  return null;
}

export interface BrowserProcessReport extends MarkedBrowser {
  /** Why it is an orphan; null while its owner runs. */
  readonly orphan: string | null;
}

/** Every jevitate-launched browser on this machine and whether it is orphaned; undefined = unsupported platform. */
export function jevitateBrowsers(table: ProcessTable = systemProcessTable()): BrowserProcessReport[] | undefined {
  const procs = table.list();
  if (procs === undefined) return undefined;
  return markedBrowsers(procs).map((b) => ({ ...b, orphan: orphanReason(b, table) }));
}

/** The orphaned jevitate browsers (never an unmarked process). */
export function findOrphanBrowsers(table: ProcessTable = systemProcessTable()): BrowserProcessReport[] {
  return (jevitateBrowsers(table) ?? []).filter((b) => b.orphan !== null);
}

export interface OrphanCleanup {
  /** Orphans found, each with what happened to it. */
  readonly orphans: ReadonlyArray<BrowserProcessReport & { readonly result: "terminated" | "killed" | "gone" | "failed"; readonly error?: string }>;
  /** False on a platform with no supported process reader (nothing was looked at). */
  readonly supported: boolean;
}

/**
 * Closes every orphaned jevitate browser: SIGTERM, then SIGKILL for one still running after
 * `graceMs`. Each candidate is re-checked as an orphan (same pid still marked, owner still gone)
 * immediately before it is signalled, so a pid reused between the scan and the kill is never hit.
 */
export async function cleanupOrphanBrowsers(opts: { readonly table?: ProcessTable; readonly graceMs?: number } = {}): Promise<OrphanCleanup> {
  const table = opts.table ?? systemProcessTable();
  const all = jevitateBrowsers(table);
  if (all === undefined) return { orphans: [], supported: false };
  const graceMs = opts.graceMs ?? 2_000;
  const stillOrphan = (b: MarkedBrowser): boolean => {
    const now = table.list()?.find((p) => p.pid === b.pid);
    const owner = now === undefined ? undefined : parseOwnerMarker(now.argv);
    return owner !== undefined && owner.pid === b.owner.pid && owner.start === b.owner.start && orphanReason(b, table) !== null;
  };
  const out: Array<BrowserProcessReport & { result: "terminated" | "killed" | "gone" | "failed"; error?: string }> = [];
  const signalled: BrowserProcessReport[] = [];
  for (const b of all.filter((x) => x.orphan !== null)) {
    if (!stillOrphan(b)) {
      out.push({ ...b, result: "gone" });
      continue;
    }
    try {
      process.kill(b.pid, "SIGTERM");
      signalled.push(b);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      out.push(code === "ESRCH" ? { ...b, result: "gone" } : { ...b, result: "failed", error: String(err) });
    }
  }
  if (signalled.length > 0) {
    const deadline = clock.now() + graceMs;
    while (clock.now() < deadline && signalled.some((b) => processAlive(b.pid))) await clock.sleep(50);
  }
  for (const b of signalled) {
    if (!processAlive(b.pid)) {
      out.push({ ...b, result: "terminated" });
      continue;
    }
    try {
      process.kill(b.pid, "SIGKILL");
      out.push({ ...b, result: "killed" });
    } catch (err) {
      out.push((err as NodeJS.ErrnoException).code === "ESRCH" ? { ...b, result: "terminated" } : { ...b, result: "failed", error: String(err) });
    }
  }
  return { orphans: out, supported: true };
}

export interface BrowserMemoryReading {
  /** Total memory of this process's browser trees (bytes). */
  readonly bytes: number;
  readonly metric: MemoryMetric;
  /** Processes summed (browser + renderers + helpers). */
  readonly processes: number;
}

/** `root` and every descendant, via `childrenOf` when available, else from a full listing. */
function descendants(roots: readonly number[], table: ProcessTable, listing: () => readonly ProcessInfo[] | undefined): number[] {
  const seen = new Set<number>();
  let byParent: Map<number, number[]> | undefined;
  const kidsOf = (pid: number): number[] => {
    const direct = table.childrenOf?.(pid);
    if (direct !== undefined) return direct;
    if (byParent === undefined) {
      byParent = new Map();
      for (const p of listing() ?? []) {
        const list = byParent.get(p.ppid) ?? [];
        list.push(p.pid);
        byParent.set(p.ppid, list);
      }
    }
    return byParent.get(pid) ?? [];
  };
  const stack = [...roots];
  while (stack.length > 0) {
    const pid = stack.pop()!;
    if (seen.has(pid)) continue;
    seen.add(pid);
    stack.push(...kidsOf(pid));
  }
  return [...seen];
}

/**
 * Memory of the browsers THIS process launched (marked with its pid and start): every marked root
 * and its descendants, summed. `roots` short-circuits the marker scan (the governor caches them);
 * undefined when the platform has no reader or no such browser runs.
 */
export function measureOwnBrowserMemory(opts: { readonly table?: ProcessTable; readonly ownerPid?: number; readonly roots?: readonly number[] } = {}): (BrowserMemoryReading & { readonly roots: number[] }) | undefined {
  const table = opts.table ?? systemProcessTable();
  const ownerPid = opts.ownerPid ?? process.pid;
  let listed: ProcessInfo[] | undefined;
  const listing = (): ProcessInfo[] | undefined => (listed ??= table.list());
  let roots = opts.roots?.filter((pid) => processAlive(pid));
  if (roots === undefined || roots.length === 0) {
    const procs = listing();
    if (procs === undefined) return undefined;
    const start = table.startOf(ownerPid) ?? "0";
    roots = markedBrowsers(procs)
      .filter((b) => b.owner.pid === ownerPid && (b.owner.start === "0" || start === "0" || b.owner.start === start))
      .map((b) => b.pid);
  }
  if (roots.length === 0) return undefined;
  let bytes = 0;
  let processes = 0;
  let metric: MemoryMetric = "pss";
  for (const pid of descendants(roots, table, listing)) {
    const m = table.memoryOf(pid);
    if (m === undefined) continue;
    bytes += m.bytes;
    processes += 1;
    if (m.metric === "rss") metric = "rss";
  }
  return processes === 0 ? undefined : { bytes, metric, processes, roots };
}
