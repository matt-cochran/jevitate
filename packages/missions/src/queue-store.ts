import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { QueuedMission } from "./schema.js";
import { QueuedMissionSchema } from "./schema.js";

/** Structural shape `enqueueMission` needs from its backing store. */
export interface MissionQueueStore {
  enqueue(m: QueuedMission): Promise<void>;
  get(id: string): Promise<QueuedMission | null>;
  list(): Promise<QueuedMission[]>;
}

/**
 * Rejects an `id` containing a path separator or `..` segment, since `id`
 * is used to build a filesystem path. Mirrors `FsJourneyStore`'s
 * `assertSafeId`.
 */
function assertSafeId(id: string): void {
  if (id.includes("/") || id.includes("\\") || id.includes("..")) {
    throw new Error(`Invalid mission id (path traversal risk): ${id}`);
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
 * Filesystem-backed mission queue. Same shape as `FsMissionTargetStore`/
 * `FsJourneyStore` — validates fully-resolved records BEFORE any disk I/O
 * (fail-closed, no partial writes).
 */
export class FsMissionQueueStore implements MissionQueueStore {
  constructor(private readonly dir: string) {}

  private pathFor(id: string): string {
    return join(this.dir, `${id}.json`);
  }

  async enqueue(m: QueuedMission): Promise<void> {
    const validated = QueuedMissionSchema.parse(m);
    assertSafeId(validated.id);

    const serialized = JSON.stringify(validated);
    await mkdir(this.dir, { recursive: true, mode: 0o700 });
    await writeFile(this.pathFor(validated.id), serialized, { mode: 0o600 });
  }

  async get(id: string): Promise<QueuedMission | null> {
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
    const parsed = JSON.parse(raw) as QueuedMission;
    return QueuedMissionSchema.parse(parsed);
  }

  async list(): Promise<QueuedMission[]> {
    let entries: string[];
    try {
      entries = await readdir(this.dir);
    } catch (err) {
      if (isNodeError(err, "ENOENT")) {
        return [];
      }
      throw err;
    }

    const results: QueuedMission[] = [];
    for (const entry of entries) {
      if (!entry.endsWith(".json")) {
        continue;
      }
      try {
        const raw = await readFile(join(this.dir, entry), "utf8");
        const parsed = QueuedMissionSchema.parse(JSON.parse(raw));
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
