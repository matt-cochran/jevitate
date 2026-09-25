import { existsSync, writeFileSync } from "node:fs";
import { mkdir, open, readFile, readdir, writeFile } from "node:fs/promises";
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
 * What a queue drain (`jevitate mission run`) additionally needs (#117): an exclusive claim, so two
 * drains never run the same mission, and status updates (running → done/failed).
 */
/** Which drain claimed a mission: its process and host, and when. */
export interface ClaimOwner {
  readonly pid: number;
  readonly host: string;
  readonly claimedAtIso: string;
}

export interface DrainableMissionQueueStore extends MissionQueueStore {
  /** Atomically claims `id` for one drain; false when another drain already holds it. */
  claim(id: string, owner: ClaimOwner): Promise<boolean>;
  /** Who claimed `id`, or null (never claimed, or claimed before owners were recorded). */
  claimOwner(id: string): Promise<ClaimOwner | null>;
  /** Rewrites an existing mission's record (re-validated; the id must already be queued). */
  update(m: QueuedMission): Promise<void>;
  /**
   * `update`, synchronously — for a process about to exit on a kill signal, which cannot await
   * (the killed mission's record must not be left `running` forever).
   */
  updateSync(m: QueuedMission): void;
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
export class FsMissionQueueStore implements DrainableMissionQueueStore {
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

  /**
   * `<id>.claim`, created exclusively (`wx`): the first drain to create it owns the mission. Never
   * removed — a claimed mission is never run twice, even by a drain started after this one ends. It
   * records its owner, so a later drain can tell a mission whose drain died from one still running.
   */
  async claim(id: string, owner: ClaimOwner): Promise<boolean> {
    assertSafeId(id);
    await mkdir(this.dir, { recursive: true, mode: 0o700 });
    try {
      const fh = await open(join(this.dir, `${id}.claim`), "wx", 0o600);
      try {
        await fh.writeFile(JSON.stringify(owner));
      } finally {
        await fh.close();
      }
      return true;
    } catch (err) {
      if (isNodeError(err, "EEXIST")) return false;
      throw err;
    }
  }

  async claimOwner(id: string): Promise<ClaimOwner | null> {
    assertSafeId(id);
    let raw: string;
    try {
      raw = await readFile(join(this.dir, `${id}.claim`), "utf8");
    } catch (err) {
      if (isNodeError(err, "ENOENT")) return null;
      throw err;
    }
    try {
      const o = JSON.parse(raw) as Partial<ClaimOwner>;
      return typeof o.pid === "number" && typeof o.host === "string" && typeof o.claimedAtIso === "string"
        ? { pid: o.pid, host: o.host, claimedAtIso: o.claimedAtIso }
        : null;
    } catch {
      return null; // an empty claim from before owners were recorded
    }
  }

  async update(m: QueuedMission): Promise<void> {
    const validated = QueuedMissionSchema.parse(m);
    assertSafeId(validated.id);
    if ((await this.get(validated.id)) === null) {
      throw new Error(`cannot update unknown mission '${validated.id}'`);
    }
    await writeFile(this.pathFor(validated.id), JSON.stringify(validated), { mode: 0o600 });
  }

  updateSync(m: QueuedMission): void {
    const validated = QueuedMissionSchema.parse(m);
    assertSafeId(validated.id);
    if (!existsSync(this.pathFor(validated.id))) {
      throw new Error(`cannot update unknown mission '${validated.id}'`);
    }
    writeFileSync(this.pathFor(validated.id), JSON.stringify(validated), { mode: 0o600 });
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
