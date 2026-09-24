import { spawn, type ChildProcessByStdio } from "node:child_process";
import { createReadStream, statSync } from "node:fs";
import type { Readable } from "node:stream";

type LogChildProcess = ChildProcessByStdio<null, Readable, Readable>;

/**
 * Backend log sources (#142): operator-declared, read-only, bounded. `file:<path>` tails from the
 * CURRENT end (never a file's history); `docker:<container>` spawns `docker logs -f --since 0s
 * <container>`; `cmd:<command>` streams an arbitrary command's stdout/stderr, refused unless the
 * caller opted in (`--allow-log-cmd`) — a bigger trust step than reading a file or a container's
 * own logs, since it runs a process. A source is NEVER chosen by the model: every spec comes from
 * the CLI invocation only (never MissionRequest/MCP — see `packages/missions/src/schema.ts`).
 *
 * Bounded and non-blocking: a source never gates a mission's own progress (lines are delivered via
 * callback, not awaited), and each source stops accepting lines past `maxLines` (`truncated: true`)
 * rather than growing without bound on a noisy log.
 */

export type LogSourceSpec =
  | { readonly kind: "file"; readonly path: string; readonly raw: string }
  | { readonly kind: "docker"; readonly container: string; readonly raw: string }
  | { readonly kind: "cmd"; readonly command: string; readonly raw: string };

export class LogSourceSpecError extends Error {
  readonly code = "E_LOG_SOURCE_SPEC" as const;
  constructor(message: string) {
    super(message);
    this.name = "LogSourceSpecError";
  }
}

/** Parses one `--log-source` value. Throws `LogSourceSpecError` on an unrecognized/empty spec. */
export function parseLogSourceSpec(raw: string): LogSourceSpec {
  const i = raw.indexOf(":");
  if (i < 0) throw new LogSourceSpecError(`--log-source must be file:<path>, docker:<container> or cmd:<command>: got ${JSON.stringify(raw)}`);
  const kind = raw.slice(0, i);
  const rest = raw.slice(i + 1);
  if (rest.trim() === "") throw new LogSourceSpecError(`--log-source ${kind}: missing value`);
  if (kind === "file") return { kind: "file", path: rest, raw };
  if (kind === "docker") return { kind: "docker", container: rest, raw };
  if (kind === "cmd") return { kind: "cmd", command: rest, raw };
  throw new LogSourceSpecError(`--log-source: unknown source kind ${JSON.stringify(kind)} (want file:, docker: or cmd:)`);
}

/**
 * Validates every spec up front, INCLUDING the `cmd:` + `--allow-log-cmd` gate — so a run refuses
 * before any browser opens, the same fail-closed discipline as `--invariants`.
 */
export function parseLogSourceSpecs(raw: readonly string[], allowLogCmd: boolean): LogSourceSpec[] {
  const specs = raw.map(parseLogSourceSpec);
  for (const s of specs) {
    if (s.kind === "cmd" && !allowLogCmd) {
      throw new LogSourceSpecError(`--log-source ${s.raw} needs --allow-log-cmd (an operator-declared command is run as a subprocess)`);
    }
  }
  return specs;
}

export interface LogSourceOpenOptions {
  /** Called for every raw line, in arrival order. Must not throw; never awaited. */
  readonly onLine: (raw: string, arrivalEpochMs: number) => void;
  /** File tail poll interval (ms). Default 250. */
  readonly filePollMs?: number;
  /** Max lines delivered per source before later ones are dropped (`truncated` becomes true). */
  readonly maxLines?: number;
}

export interface LogSourceHandle {
  readonly spec: LogSourceSpec;
  /** True once the source is confirmed open (file exists / process spawned without an immediate error). */
  opened: boolean;
  /** Lines delivered so far. */
  linesRead: number;
  /** Set once `maxLines` was hit: later lines are dropped, not delivered. */
  truncated: boolean;
  /** The open/spawn error, when the source never became readable. */
  error?: string;
  /** Stops tailing / kills the child process group. Idempotent; never throws. */
  close(): Promise<void>;
  /**
   * Synchronous best-effort kill (a `docker`/`cmd:` child only; a no-op for `file:`) — for use from
   * a `process.on("exit", …)` handler, where async work is not possible. Idempotent.
   */
  killSync(): void;
}

const DEFAULT_MAX_LINES = 20_000;
const DEFAULT_FILE_POLL_MS = 250;

function lineSplitter(onLine: (raw: string, epochMs: number) => void): (chunk: Buffer | string) => void {
  let carry = "";
  return (chunk) => {
    carry += chunk.toString("utf8");
    const lines = carry.split(/\r?\n/);
    carry = lines.pop() ?? "";
    for (const line of lines) if (line !== "") onLine(line, Date.now());
  };
}

function boundedOnLine(handle: LogSourceHandle, opts: LogSourceOpenOptions): (raw: string, epochMs: number) => void {
  const max = opts.maxLines ?? DEFAULT_MAX_LINES;
  return (raw, epochMs) => {
    if (handle.linesRead >= max) {
      handle.truncated = true;
      return;
    }
    handle.linesRead += 1;
    opts.onLine(raw, epochMs);
  };
}

/**
 * `file:` — tails from the CURRENT end by polling the file's size (no `fs.watch`: flaky across
 * filesystems, notably over WSL's `/mnt/c` drvfs — AGENTS.md). Handles truncation/rotation, AND a
 * file that does not exist yet at open time (a backend that has not logged anything until later in
 * the run is the common case, not an error): if the file already exists, its EXISTING content is
 * history and skipped (`position` starts at its current size); if it does not exist yet, nothing
 * can predate this run, so `position` starts at 0 and the first line written after the source
 * opened is the first one delivered, however long the file takes to appear.
 */
function openFileSource(spec: Extract<LogSourceSpec, { kind: "file" }>, opts: LogSourceOpenOptions): LogSourceHandle {
  let closed = false;
  let timer: ReturnType<typeof setInterval> | undefined;
  let position = 0;
  const handle: LogSourceHandle = {
    spec,
    opened: false,
    linesRead: 0,
    truncated: false,
    close: async () => {
      closed = true;
      if (timer !== undefined) clearInterval(timer);
      if (!handle.opened) handle.error = `${spec.path}: never appeared during the run`;
    },
    killSync: () => {
      closed = true;
      if (timer !== undefined) clearInterval(timer);
    },
  };
  const deliver = lineSplitter(boundedOnLine(handle, opts));
  try {
    // The file already exists: its content predates this source and is skipped (never replayed).
    position = statSync(spec.path).size;
    handle.opened = true;
  } catch {
    // Does not exist yet: `position` stays 0, so whatever is written once it appears is ALL new.
  }
  const poll = (): void => {
    if (closed) return;
    let size: number;
    try {
      size = statSync(spec.path).size;
    } catch {
      return; // still not there, or a transient stat failure — the next poll tries again
    }
    handle.opened = true; // confirmed readable now, even if it appeared after the initial check
    if (size <= position) {
      if (size < position) position = 0; // truncated/rotated: resume from the new start
      return;
    }
    const stream = createReadStream(spec.path, { start: position, end: size - 1 });
    stream.on("data", (chunk) => deliver(chunk));
    stream.on("error", () => undefined);
    position = size;
  };
  timer = setInterval(poll, opts.filePollMs ?? DEFAULT_FILE_POLL_MS);
  timer.unref?.();
  return handle;
}

/** Kills a spawned child's whole process GROUP (POSIX): `docker logs`/`cmd:`'s own children die
 *  too, not just the immediate process. Falls back to killing just the child if the group send fails. */
function killGroup(child: LogChildProcess): void {
  const pid = child.pid;
  if (pid === undefined) return;
  try {
    process.kill(-pid, "SIGTERM");
  } catch {
    try {
      child.kill("SIGTERM");
    } catch {
      // Already gone.
    }
  }
}

function openProcessSource(spec: LogSourceSpec, command: string, args: readonly string[], opts: LogSourceOpenOptions, useShell: boolean): LogSourceHandle {
  let child: LogChildProcess | undefined;
  const handle: LogSourceHandle = {
    spec,
    opened: false,
    linesRead: 0,
    truncated: false,
    close: async () => {
      if (child === undefined) return;
      killGroup(child);
      await new Promise<void>((resolve) => {
        if (child === undefined || child.exitCode !== null || child.signalCode !== null) {
          resolve();
          return;
        }
        const done = (): void => resolve();
        child.once("exit", done);
        const t = setTimeout(done, 2000);
        t.unref?.();
      });
    },
    killSync: () => {
      if (child !== undefined) killGroup(child);
    },
  };
  try {
    child = spawn(command, args, { detached: true, shell: useShell, stdio: ["ignore", "pipe", "pipe"] });
  } catch (e) {
    handle.error = `cannot start ${spec.raw}: ${e instanceof Error ? e.message : String(e)}`;
    return handle;
  }
  handle.opened = true;
  const deliver = lineSplitter(boundedOnLine(handle, opts));
  child.stdout.on("data", deliver);
  child.stderr.on("data", deliver); // most backends interleave logs on stderr too (docker logs does)
  child.on("error", (e) => {
    handle.error = `${spec.raw}: ${e.message}`;
  });
  child.unref();
  return handle;
}

/**
 * Opens one already-validated `--log-source`. Never throws: an unreadable/unspawnable source comes
 * back with `.error` set rather than aborting a run that has other sources (the caller decides
 * whether that's fatal — a `--log-defect` oracle must not count an unreadable source as "held").
 */
export function openLogSource(spec: LogSourceSpec, opts: LogSourceOpenOptions): LogSourceHandle {
  if (spec.kind === "file") return openFileSource(spec, opts);
  if (spec.kind === "docker") return openProcessSource(spec, "docker", ["logs", "-f", "--since", "0s", spec.container], opts, false);
  return openProcessSource(spec, spec.command, [], opts, true);
}

export function openLogSources(specs: readonly LogSourceSpec[], opts: LogSourceOpenOptions): LogSourceHandle[] {
  return specs.map((spec) => openLogSource(spec, opts));
}

/** Closes every handle, best-effort, in parallel. Never throws. */
export async function closeLogSources(handles: readonly LogSourceHandle[]): Promise<void> {
  await Promise.all(handles.map((h) => h.close().catch(() => undefined)));
}
