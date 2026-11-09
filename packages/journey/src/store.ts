import { lstat, mkdir, open, readFile, readdir, rename, stat, unlink, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { contentHash, isNodeError } from "@jevitate/domain";
import { constants } from "node:fs";
import { randomUUID } from "node:crypto";
import { ensureStepIds } from "@jevitate/recording";
import type { Journey, JourneyMetadata } from "./journey.js";
import { JourneySchema } from "./journey.js";
import { journeyRunParams } from "./param-schema.js";

/**
 * Structural shape `JourneyRegistry` needs from its backing store.
 * `FsJourneyStore` already satisfies this; exported so other packages
 * (e.g. `@jevitate/sources`, federating external Journey sources) can hand a
 * `JourneyRegistry` a different backing store without `@jevitate/journey`
 * importing anything from them (dependency direction stays inward).
 */
export interface JourneyStore {
  get(id: string): Promise<Journey | null>;
  put(j: Journey): Promise<void>;
  list(): Promise<JourneyMetadata[]>;
}

const SAFE_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/**
 * A Journey id: `<id>`, or `<namespace>/<id>` for a shared Journey in a namespace folder
 * (`journeys/<namespace>/<id>.json`, typically a git submodule of shared Journeys). Each segment is
 * a safe name — no path separator beyond the one, no `..`, no dot-folder — since an id may come
 * from a less-trusted caller (MCP) and builds a filesystem path.
 */
function parseId(id: string): { readonly ns: string | null; readonly base: string } {
  const parts = id.split("/");
  if (parts.length > 2 || id.includes("\\") || id.includes("..") || !parts.every((p) => SAFE_SEGMENT.test(p))) {
    throw new Error(`Invalid journey id (path traversal risk): ${id}`);
  }
  return parts.length === 2 ? { ns: parts[0] as string, base: parts[1] as string } : { ns: null, base: parts[0] as string };
}

/** A namespaced Journey is reported under `<namespace>/<file id>`; its file keeps its own plain id. */
function withNamespace(j: Journey, ns: string | null, base: string): Journey {
  return ns === null ? j : { ...j, metadata: { ...j.metadata, id: `${ns}/${base}` } };
}


/**
 * Filesystem-backed Journey store. Keeps `@jevitate/journey` a leaf package
 * (Node's built-in `fs`/`path` plus `@jevitate/recording` only, no new
 * dependency). JSON files are keyed by `metadata.id`.
 */
export class FsJourneyStore {
  constructor(private readonly dir: string) {}

  private pathFor(id: string): string {
    const { ns, base } = parseId(id);
    return ns === null ? join(this.dir, `${base}.json`) : join(this.dir, ns, `${base}.json`);
  }

  /**
   * Writes the Journey. #467: the one choke point where a Journey is written, so every step without
   * a stable `stepId` gets one here (`ensureStepIds`: deterministic for the same recording, and a
   * no-op when every step has an id — an id-complete Journey round-trips byte-identical). `get` and
   * `list` never mint.
   */
  async put(j: Journey): Promise<void> {
    const { ns, base } = parseId(j.metadata.id);
    const normalized = this.normalizeForWrite(j);
    const validated = ns === null ? normalized : { ...normalized, metadata: { ...normalized.metadata, id: base } };

    const serialized = JSON.stringify(validated);
    await mkdir(ns === null ? this.dir : join(this.dir, ns), { recursive: true, mode: 0o700 });
    await writeFile(this.pathFor(j.metadata.id), serialized, {
      mode: 0o600,
    });
  }

  /** The same schema and stable-ID normalization used by put, without filesystem writes. */
  normalizeForWrite(j: Journey): Journey {
    const { ns, base } = parseId(j.metadata.id);
    const recording = ensureStepIds(j.recording);
    const minted = recording === j.recording ? j : { ...j, recording };
    const validated = JourneySchema.parse(ns === null ? minted : { ...minted, metadata: { ...minted.metadata, id: base } });
    return withNamespace(validated, ns, base);
  }

  private async guardedParents(id: string): Promise<string> {
    const { ns } = parseId(id);
    const paths = [resolve(this.dir), ...(ns === null ? [] : [resolve(this.dir, ns)])];
    const identities: string[] = [];
    for (const path of paths) {
      const st = await lstat(path);
      if (!st.isDirectory() || st.isSymbolicLink()) throw new Error("Unsafe Journey transaction directory");
      identities.push(`${st.dev}:${st.ino}`);
    }
    return identities.join("/");
  }

  /** Read-only transaction boundary: rejects links, replacement during read and mismatched IDs. */
  async getGuarded(id: string): Promise<Journey | null> {
    const { ns, base } = parseId(id);
    let parents: string;
    try { parents = await this.guardedParents(id); }
    catch (err) { if (isNodeError(err, "ENOENT")) return null; throw err; }
    let expected;
    try { expected = await lstat(this.pathFor(id)); }
    catch (err) { if (isNodeError(err, "ENOENT")) return null; throw err; }
    if (!expected.isFile() || expected.isSymbolicLink() || (process.getuid !== undefined && expected.uid !== process.getuid()) || typeof constants.O_NOFOLLOW !== "number") throw new Error("Unsafe Journey transaction file");
    let handle;
    try { handle = await open(this.pathFor(id), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); }
    catch (err) { if (isNodeError(err, "ENOENT")) return null; throw err; }
    try {
      const st = await handle.stat();
      if (!st.isFile() || st.dev !== expected.dev || st.ino !== expected.ino || (process.getuid !== undefined && st.uid !== process.getuid())) throw new Error("Unsafe Journey transaction file");
      const raw = await handle.readFile("utf8");
      const now = await lstat(this.pathFor(id));
      if (!now.isFile() || now.dev !== st.dev || now.ino !== st.ino || now.size !== st.size || now.mtimeMs !== st.mtimeMs || parents !== await this.guardedParents(id)) throw new Error("Journey changed during transaction read");
      const parsed = JourneySchema.parse(JSON.parse(raw));
      if (parsed.metadata.id !== base) throw new Error("Journey transaction ID mismatch");
      return withNamespace(parsed, ns, base);
    } finally { await handle.close(); }
  }

  /** Atomic sibling replacement for an already-reviewed native transaction; default put is unchanged. */
  async putGuarded(j: Journey, expectedContentHash: string): Promise<Journey> {
    const normalized = this.normalizeForWrite(j);
    const { ns, base } = parseId(j.metadata.id);
    const parents = await this.guardedParents(j.metadata.id);
    const initial = await lstat(this.pathFor(j.metadata.id));
    const current = await this.getGuarded(j.metadata.id);
    if (current === null || contentHash(current) !== expectedContentHash) throw new Error("Journey transaction preimage changed");
    const path = this.pathFor(j.metadata.id);
    const temp = `${path}.${randomUUID()}.tmp`;
    const portable = ns === null ? normalized : { ...normalized, metadata: { ...normalized.metadata, id: base } };
    try {
      const handle = await open(temp, "wx", 0o600);
      try { await handle.writeFile(JSON.stringify(portable)); await handle.sync(); }
      finally { await handle.close(); }
      const beforeCommit = await this.getGuarded(j.metadata.id);
      const latest = await lstat(path);
      if (beforeCommit === null || contentHash(beforeCommit) !== expectedContentHash || initial.dev !== latest.dev || initial.ino !== latest.ino || parents !== await this.guardedParents(j.metadata.id)) throw new Error("Journey transaction preimage changed");
      await rename(temp, path);
      const directory = await open(dirname(path), "r");
      try { await directory.sync(); } finally { await directory.close(); }
      const written = await this.getGuarded(j.metadata.id);
      if (written === null || contentHash(written) !== contentHash(normalized)) throw new Error("Journey transaction result changed");
      return written;
    } finally { await unlink(temp).catch((err: unknown) => { if (!isNodeError(err, "ENOENT")) throw err; }); }
  }

  async get(id: string): Promise<Journey | null> {
    const { ns, base } = parseId(id);
    let raw: string;
    try {
      raw = await readFile(this.pathFor(id), "utf8");
    } catch (err) {
      if (isNodeError(err, "ENOENT")) {
        return null;
      }
      throw err;
    }
    const parsed = JSON.parse(raw) as Journey;
    // Defense-in-depth: re-validate on read too, in case the file was
    // hand-edited or otherwise corrupted on disk.
    return withNamespace(JourneySchema.parse(parsed), ns, base);
  }

  async list(): Promise<JourneyMetadata[]> {
    let entries: string[];
    try {
      entries = await readdir(this.dir);
    } catch (err) {
      if (isNodeError(err, "ENOENT")) {
        return [];
      }
      throw err;
    }

    const results: JourneyMetadata[] = [];
    const readAll = async (dir: string, ns: string | null, names: readonly string[]): Promise<void> => {
      for (const entry of names) {
        if (!entry.endsWith(".json")) continue;
        try {
          const raw = await readFile(join(dir, entry), "utf8");
          const parsed = JourneySchema.parse(JSON.parse(raw));
          // #399: a listing names every param the Journey takes (a navigate placeholder too).
          const listed = withNamespace(parsed, ns, entry.slice(0, -".json".length));
          results.push({ ...listed.metadata, params: journeyRunParams(listed) });
        } catch {
          // Defensive skip: list() is a lifecycle operation, not a hard read
          // path — one corrupt/unparseable file shouldn't break listing
          // everything else.
          continue;
        }
      }
    };
    await readAll(this.dir, null, entries);
    // Namespace folders one level down (shared Journeys, e.g. git submodules): `<ns>/<id>`.
    for (const ns of entries) {
      if (!SAFE_SEGMENT.test(ns)) continue;
      let inner: string[];
      try {
        const st = await stat(join(this.dir, ns));
        if (!st.isDirectory()) continue;
        inner = await readdir(join(this.dir, ns));
      } catch {
        continue;
      }
      await readAll(join(this.dir, ns), ns, inner);
    }
    return results;
  }
}
