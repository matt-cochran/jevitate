import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Recording } from "./schema.js";
import { RecordingSchema } from "./schema.js";

export interface RecordingStore {
  put(id: string, rec: Recording): Promise<void>;
  get(id: string): Promise<Recording | null>;
  prune(id: string): Promise<void>;
  list(): Promise<{ id: string; savedAtIso: string }[]>;
  /** Returns the count of entries removed. */
  gcOlderThan(iso: string): Promise<number>;
}

export interface FsRecordingStoreOptions {
  /** Cap on the serialized JSON size, in bytes. Default: 5 MiB. */
  maxBytes?: number;
}

const DEFAULT_MAX_BYTES = 5 * 1024 * 1024;

/**
 * On-disk wrapper persisted per recording. `savedAtIso` is stored alongside
 * the recording (rather than relied upon from filesystem mtime, which is
 * fragile — copies, backups, and some filesystems don't preserve it
 * reliably) so `list()`/`gcOlderThan()` have a trustworthy timestamp.
 */
interface StoredEnvelope {
  savedAtIso: string;
  recording: Recording;
}

/**
 * Rejects an `id` containing a path separator or `..` segment, since `id`
 * may originate from external/less-trusted callers and is used to build a
 * filesystem path.
 */
function assertSafeId(id: string): void {
  if (id.includes("/") || id.includes("\\") || id.includes("..")) {
    throw new Error(`Invalid recording id (path traversal risk): ${id}`);
  }
}

function isNodeError(err: unknown, code: string): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    "code" in err &&
    (err as { code?: unknown }).code === code
  );
}

/**
 * Filesystem-backed `RecordingStore`. Keeps `@doit/recording` a leaf package
 * (Node's built-in `fs`/`path` only, no sqlite or other new dependency).
 *
 * This store does NOT perform redaction — it trusts the caller to hand it an
 * already-redacted `Recording` (per `@doit/recorder`'s guarantees). Its own
 * job is: schema-validate (fail-closed), enforce the size cap, and write
 * with restrictive (user-only) permissions.
 */
export class FsRecordingStore implements RecordingStore {
  private readonly maxBytes: number;

  constructor(
    private readonly dir: string,
    options: FsRecordingStoreOptions = {},
  ) {
    this.maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
  }

  private pathFor(id: string): string {
    return join(this.dir, `${id}.json`);
  }

  async put(id: string, rec: Recording): Promise<void> {
    // Fail-closed: validate BEFORE any I/O, so an invalid Recording is never
    // written to disk.
    const validated = RecordingSchema.parse(rec);
    assertSafeId(id);

    const envelope: StoredEnvelope = {
      savedAtIso: new Date().toISOString(),
      recording: validated,
    };
    const serialized = JSON.stringify(envelope);
    const byteLength = Buffer.byteLength(serialized, "utf8");
    if (byteLength > this.maxBytes) {
      throw new Error(
        `Recording ${id} exceeds size cap: ${byteLength} bytes > ${this.maxBytes} bytes`,
      );
    }

    await mkdir(this.dir, { recursive: true, mode: 0o700 });
    await writeFile(this.pathFor(id), serialized, { mode: 0o600 });
  }

  async get(id: string): Promise<Recording | null> {
    assertSafeId(id);
    let raw: string;
    try {
      raw = await readFile(this.pathFor(id), "utf8");
    } catch (err) {
      if (isNodeError(err, "ENOENT")) {
        return null;
      }
      throw err;
    }
    const envelope = JSON.parse(raw) as StoredEnvelope;
    // Defense-in-depth: re-validate on read too, in case the file was
    // hand-edited or otherwise corrupted on disk.
    return RecordingSchema.parse(envelope.recording);
  }

  async prune(id: string): Promise<void> {
    assertSafeId(id);
    try {
      await rm(this.pathFor(id));
    } catch (err) {
      if (isNodeError(err, "ENOENT")) {
        return;
      }
      throw err;
    }
  }

  async list(): Promise<{ id: string; savedAtIso: string }[]> {
    let entries: string[];
    try {
      entries = await readdir(this.dir);
    } catch (err) {
      if (isNodeError(err, "ENOENT")) {
        return [];
      }
      throw err;
    }

    const results: { id: string; savedAtIso: string }[] = [];
    for (const entry of entries) {
      if (!entry.endsWith(".json")) {
        continue;
      }
      const id = entry.slice(0, -".json".length);
      try {
        const raw = await readFile(join(this.dir, entry), "utf8");
        const envelope = JSON.parse(raw) as StoredEnvelope;
        if (typeof envelope.savedAtIso !== "string") {
          continue;
        }
        results.push({ id, savedAtIso: envelope.savedAtIso });
      } catch {
        // Defensive skip: list()/gc are lifecycle operations, not a hard
        // read path — one corrupt/unparseable file shouldn't break listing
        // everything else.
        continue;
      }
    }
    return results;
  }

  async gcOlderThan(iso: string): Promise<number> {
    const entries = await this.list();
    let removed = 0;
    for (const entry of entries) {
      // ISO-8601 timestamps compare correctly as strings (lexicographic
      // order matches chronological order).
      if (entry.savedAtIso < iso) {
        await this.prune(entry.id);
        removed += 1;
      }
    }
    return removed;
  }
}
