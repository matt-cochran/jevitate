import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { MissionTarget } from "./schema.js";
import { MissionTargetSchema } from "./schema.js";

/**
 * Structural shape `MissionTargetRegistry` needs from its backing store.
 * Mirrors `@jevitate/journey`'s `JourneyStore` shape exactly.
 */
export interface MissionTargetStore {
  get(id: string): Promise<MissionTarget | null>;
  put(t: MissionTarget): Promise<void>;
  list(): Promise<MissionTarget[]>;
}

/**
 * Rejects an `id` containing a path separator or `..` segment, since `id`
 * is used to build a filesystem path. Mirrors `FsJourneyStore`'s
 * `assertSafeId`.
 */
function assertSafeId(id: string): void {
  if (id.includes("/") || id.includes("\\") || id.includes("..")) {
    throw new Error(`Invalid mission target id (path traversal risk): ${id}`);
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
 * Filesystem-backed MissionTarget store. Copies `FsJourneyStore`'s shape
 * verbatim (same `assertSafeId`, same `isNodeError` ENOENT handling, same
 * `mode: 0o600`/`0o700`), keeping `@jevitate/missions` a leaf package.
 */
export class FsMissionTargetStore implements MissionTargetStore {
  constructor(private readonly dir: string) {}

  private pathFor(id: string): string {
    return join(this.dir, `${id}.json`);
  }

  async put(t: MissionTarget): Promise<void> {
    // Fail-closed: validate BEFORE any I/O, so an invalid target is never
    // written to disk.
    const validated = MissionTargetSchema.parse(t);
    assertSafeId(validated.id);

    const serialized = JSON.stringify(validated);
    await mkdir(this.dir, { recursive: true, mode: 0o700 });
    await writeFile(this.pathFor(validated.id), serialized, { mode: 0o600 });
  }

  async get(id: string): Promise<MissionTarget | null> {
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
    const parsed = JSON.parse(raw) as MissionTarget;
    // Defense-in-depth: re-validate on read too, in case the file was
    // hand-edited or otherwise corrupted on disk.
    return MissionTargetSchema.parse(parsed);
  }

  async list(): Promise<MissionTarget[]> {
    let entries: string[];
    try {
      entries = await readdir(this.dir);
    } catch (err) {
      if (isNodeError(err, "ENOENT")) {
        return [];
      }
      throw err;
    }

    const results: MissionTarget[] = [];
    for (const entry of entries) {
      if (!entry.endsWith(".json")) {
        continue;
      }
      try {
        const raw = await readFile(join(this.dir, entry), "utf8");
        const parsed = MissionTargetSchema.parse(JSON.parse(raw));
        results.push(parsed);
      } catch {
        // Defensive skip: list() is a lifecycle operation, not a hard read
        // path — one corrupt/unparseable file shouldn't break listing
        // everything else.
        continue;
      }
    }
    return results;
  }
}
