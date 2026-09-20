import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Journey, JourneyMetadata } from "./journey.js";
import { JourneySchema } from "./journey.js";

/**
 * Rejects an `id` containing a path separator or `..` segment, since `id`
 * may originate from external/less-trusted callers and is used to build a
 * filesystem path. Mirrors `FsRecordingStore`'s `assertSafeId`.
 */
function assertSafeId(id: string): void {
  if (id.includes("/") || id.includes("\\") || id.includes("..")) {
    throw new Error(`Invalid journey id (path traversal risk): ${id}`);
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
 * Filesystem-backed Journey store. Keeps `@doit/journey` a leaf package
 * (Node's built-in `fs`/`path` plus `@doit/recording` only, no new
 * dependency). JSON files are keyed by `metadata.id`.
 */
export class FsJourneyStore {
  constructor(private readonly dir: string) {}

  private pathFor(id: string): string {
    return join(this.dir, `${id}.json`);
  }

  async put(j: Journey): Promise<void> {
    // Fail-closed: validate BEFORE any I/O, so an invalid Journey is never
    // written to disk.
    const validated = JourneySchema.parse(j);
    assertSafeId(validated.metadata.id);

    const serialized = JSON.stringify(validated);
    await mkdir(this.dir, { recursive: true, mode: 0o700 });
    await writeFile(this.pathFor(validated.metadata.id), serialized, {
      mode: 0o600,
    });
  }

  async get(id: string): Promise<Journey | null> {
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
    const parsed = JSON.parse(raw) as Journey;
    // Defense-in-depth: re-validate on read too, in case the file was
    // hand-edited or otherwise corrupted on disk.
    return JourneySchema.parse(parsed);
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
    for (const entry of entries) {
      if (!entry.endsWith(".json")) {
        continue;
      }
      try {
        const raw = await readFile(join(this.dir, entry), "utf8");
        const parsed = JourneySchema.parse(JSON.parse(raw));
        results.push(parsed.metadata);
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
