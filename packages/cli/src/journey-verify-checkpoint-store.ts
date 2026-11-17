import { createHash, randomBytes } from "node:crypto";
import { closeSync, constants, fstatSync, fsyncSync, linkSync, lstatSync, mkdirSync, openSync, readSync, renameSync, rmdirSync, unlinkSync, writeSync } from "node:fs";
import { dirname, join } from "node:path";
import { clock } from "@jevitate/domain";
import { homeDataRoot } from "./project-dir.js";
import { keyed, ownerUid, fileSchema, type CheckpointBody } from "./journey-verify-checkpoint-binding.js";

/**
 * Where a checkpoint lives, the `~/.jevitate` key that binds and signs it, and the locking and
 * atomic-write helpers (split out of `journey-verify-checkpoint.ts`, which re-exports every name here).
 */
/** Far above any real checkpoint. A larger file is not one. */
const MAX_CHECKPOINT_BYTES = 8 * 1024 * 1024;
const LOCK_STALE_MS = 10_000;
const LOCK_WAIT_MS = 5_000;
const LOCK_POLL_MS = 50;

/** Opening what `lstat` just called a file must not block or follow a link, if it was swapped since. */
const READ_FLAGS = constants.O_RDONLY | (constants.O_NONBLOCK ?? 0) | (constants.O_NOFOLLOW ?? 0);
const WRITE_FLAGS = constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0);

/** `<project or home>/logs/verify-progress/<id>.<store>.json`. The store's digest keeps two stores' same-named Journeys apart. */
export function verifyCheckpointPath(dataRoot: string, journeysDir: string, id: string): string {
  const store = createHash("sha256").update(journeysDir).digest("hex").slice(0, 12);
  return join(dataRoot, "logs", "verify-progress", `${encodeURIComponent(id)}.${store}.json`);
}

/** `~/.jevitate/verify-checkpoint.key`: outside every project, so no repo or artifact can carry it. */
export function checkpointKeyPath(): string {
  return join(homeDataRoot(), "verify-checkpoint.key");
}

const KEY_TEXT = /^[0-9a-f]{64}$/;

/** The key, or why it cannot be trusted. A key anyone else can read or write binds nothing. */
export function readCheckpointKey(keyFile: string): { readonly key: Buffer } | { readonly missing: true } | { readonly problem: string } {
  let fd: number | undefined;
  try {
    if (!lstatSync(keyFile).isFile()) return { problem: "it is not a regular file" };
    fd = openSync(keyFile, READ_FLAGS);
    const opened = fstatSync(fd);
    if (!opened.isFile() || opened.size !== 64) return { problem: "it is not a key this version wrote" };
    if (process.platform !== "win32" && (opened.mode & 0o077) !== 0) return { problem: "group or others can reach it (it must be mode 0600)" };
    const uid = ownerUid();
    if (uid !== undefined && opened.uid !== uid) return { problem: "another user owns it" };
    const bytes = Buffer.alloc(64);
    readSync(fd, bytes, 0, 64, 0);
    const text = bytes.toString("utf8");
    return KEY_TEXT.test(text) ? { key: Buffer.from(text, "hex") } : { problem: "it is not a key this version wrote" };
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return { missing: true };
    return { problem: `it could not be read (${(err as NodeJS.ErrnoException).code ?? "error"})` };
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

/** Publishes a new key whole, by a hard link that fails if another process got there first. */
export function createCheckpointKey(keyFile: string): void {
  mkdirSync(dirname(keyFile), { recursive: true, mode: 0o700 });
  const tmp = `${keyFile}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
  const fd = openSync(tmp, WRITE_FLAGS, 0o600);
  try {
    writeSync(fd, randomBytes(32).toString("hex"));
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  try {
    linkSync(tmp, keyFile);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
  } finally {
    unlinkSync(tmp);
  }
}

type FileRead = { readonly kind: "none" } | { readonly kind: "not-regular" } | { readonly kind: "corrupt"; readonly detail: string } | { readonly kind: "read"; readonly body: CheckpointBody; readonly mac: string };

/** Never blocks and never follows a link: a FIFO, device or symlink at the path reads as not a checkpoint. */
export function readCheckpointFile(path: string): FileRead {
  let fd: number | undefined;
  let text: string;
  try {
    if (!lstatSync(path).isFile()) return { kind: "not-regular" };
    fd = openSync(path, READ_FLAGS);
    const opened = fstatSync(fd);
    if (!opened.isFile()) return { kind: "not-regular" };
    if (opened.size > MAX_CHECKPOINT_BYTES) return { kind: "corrupt", detail: `it is larger than ${MAX_CHECKPOINT_BYTES} bytes` };
    const bytes = Buffer.alloc(opened.size);
    let read = 0;
    while (read < opened.size) {
      const got = readSync(fd, bytes, read, opened.size - read, read);
      if (got === 0) break;
      read += got;
    }
    text = bytes.toString("utf8", 0, read);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return { kind: "none" };
    if (code === "ELOOP" || code === "ENXIO") return { kind: "not-regular" };
    return { kind: "corrupt", detail: `it could not be read (${code ?? "error"})` };
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return { kind: "corrupt", detail: "it is not whole JSON (truncated or damaged)" };
  }
  const parsed = fileSchema.safeParse(raw);
  if (!parsed.success) return { kind: "corrupt", detail: "it does not have the checkpoint's shape" };
  return { kind: "read", body: parsed.data.body, mac: parsed.data.mac };
}

/** tmp, fsync, rename, then the directory: a reader sees the old file or the new one, whole. Refuses to replace what this code did not write. */
export function writeCheckpointFile(path: string, key: Buffer, body: CheckpointBody): void {
  const dir = dirname(path);
  mkdirSync(dir, { recursive: true });
  if (!lstatSync(dir).isDirectory()) throw new Error("the progress directory is a link or a file");
  try {
    if (!lstatSync(path).isFile()) throw new Error("something other than a regular file is at the checkpoint's path");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }
  const tmp = `${path}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
  const fd = openSync(tmp, WRITE_FLAGS, 0o600);
  try {
    try {
      writeSync(fd, JSON.stringify({ body, mac: keyed(key, "file", body) }));
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(tmp, path);
  } catch (err) {
    try {
      unlinkSync(tmp);
    } catch {
      // The write's own error is the one to report; a leftover tmp is never read.
    }
    throw err;
  }
  const dirFd = openSync(dir, constants.O_RDONLY);
  try {
    fsyncSync(dirFd);
  } catch (err) {
    // Some filesystems refuse fsync on a directory; the rename has still happened.
    if (!["EINVAL", "EPERM", "EISDIR", "ENOTSUP"].includes((err as NodeJS.ErrnoException).code ?? "")) throw err;
  } finally {
    closeSync(dirFd);
  }
}

/** A short critical section so two starters cannot both claim one checkpoint. A dead holder's lock ages out. */
export async function withCheckpointLock<T>(path: string, body: () => T): Promise<T | "busy"> {
  const lock = `${path}.lock`;
  mkdirSync(dirname(path), { recursive: true });
  const giveUpAt = clock.monotonicMs() + LOCK_WAIT_MS;
  for (;;) {
    try {
      mkdirSync(lock);
      break;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
      try {
        if (clock.now() - lstatSync(lock).mtimeMs > LOCK_STALE_MS) rmdirSync(lock);
      } catch {
        // Released while it was looked at, or not a directory: the next mkdir says which.
      }
      if (clock.monotonicMs() >= giveUpAt) return "busy";
      await clock.sleep(LOCK_POLL_MS);
    }
  }
  try {
    return body();
  } finally {
    try {
      rmdirSync(lock);
    } catch {
      // Already reclaimed as stale: the critical section is over either way.
    }
  }
}
