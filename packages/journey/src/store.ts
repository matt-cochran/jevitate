import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Journey, JourneyMetadata } from "./journey.js";
import { JourneySchema } from "./journey.js";

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

function isNodeError(err: unknown, code: string): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    "code" in err &&
    (err as { code?: unknown }).code === code
  );
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

  async put(j: Journey): Promise<void> {
    // Fail-closed: validate BEFORE any I/O, so an invalid Journey is never
    // written to disk.
    const { ns, base } = parseId(j.metadata.id);
    // A namespaced Journey's file keeps its own plain id (portable across the repos that share it).
    const validated = JourneySchema.parse(ns === null ? j : { ...j, metadata: { ...j.metadata, id: base } });

    const serialized = JSON.stringify(validated);
    await mkdir(ns === null ? this.dir : join(this.dir, ns), { recursive: true, mode: 0o700 });
    await writeFile(this.pathFor(j.metadata.id), serialized, {
      mode: 0o600,
    });
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
          results.push(withNamespace(parsed, ns, entry.slice(0, -".json".length)).metadata);
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
