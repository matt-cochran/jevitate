import { randomBytes } from "node:crypto";
import { existsSync, writeFileSync } from "node:fs";
import { link, mkdir, readFile, readdir, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { isNodeError, safeChildPath } from "@jevitate/domain";
import type { QueuedJourneyRecord, QueuedMission } from "./schema.js";
import { QueuedJourneyRecordSchema, QueuedMissionSchema } from "./schema.js";

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
  /** The claimant's process start time (Linux `/proc` starttime): a reused PID has another one. */
  readonly startKey?: string;
  /** A per-drain nonce: tells this drain's claims from an earlier drain's that had the same PID. */
  readonly nonce?: string;
}

/**
 * Creates `path` holding `owner`, whole or not at all, and fails (false) if it exists: the content is
 * written to a private temp file and hard-linked into place, so a crash never leaves an empty claim
 * and the claimant is on disk the moment the claim exists.
 */
async function writeClaimExclusively(path: string, owner: ClaimOwner): Promise<boolean> {
  const tmp = `${path}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
  await writeFile(tmp, JSON.stringify(owner), { mode: 0o600, flag: "wx" });
  try {
    await link(tmp, path);
    return true;
  } catch (err) {
    if (isNodeError(err, "EEXIST")) return false;
    throw err;
  } finally {
    await unlink(tmp).catch(() => undefined);
  }
}

function parseClaimOwner(raw: string): ClaimOwner | null {
  try {
    const o = JSON.parse(raw) as Partial<ClaimOwner>;
    if (typeof o.pid !== "number" || typeof o.host !== "string" || typeof o.claimedAtIso !== "string") return null;
    return {
      pid: o.pid,
      host: o.host,
      claimedAtIso: o.claimedAtIso,
      ...(typeof o.startKey === "string" ? { startKey: o.startKey } : {}),
      ...(typeof o.nonce === "string" ? { nonce: o.nonce } : {}),
    };
  } catch {
    return null; // an empty claim from before owners were recorded
  }
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
 * Filesystem-backed mission queue. Same shape as `FsMissionTargetStore`/
 * `FsJourneyStore` — validates fully-resolved records BEFORE any disk I/O
 * (fail-closed, no partial writes).
 */
export class FsMissionQueueStore implements DrainableMissionQueueStore {
  constructor(private readonly dir: string) {}

  private pathFor(id: string): string {
    return safeChildPath(this.dir, id, { what: "mission id", suffix: ".json" });
  }

  async enqueue(m: QueuedMission): Promise<void> {
    const validated = QueuedMissionSchema.parse(m);

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
    await mkdir(this.dir, { recursive: true, mode: 0o700 });
    return writeClaimExclusively(safeChildPath(this.dir, id, { what: "mission id", suffix: ".claim" }), owner);
  }

  async claimOwner(id: string): Promise<ClaimOwner | null> {
    let raw: string;
    try {
      raw = await readFile(safeChildPath(this.dir, id, { what: "mission id", suffix: ".claim" }), "utf8");
    } catch (err) {
      if (isNodeError(err, "ENOENT")) return null;
      throw err;
    }
    return parseClaimOwner(raw);
  }

  async update(m: QueuedMission): Promise<void> {
    const validated = QueuedMissionSchema.parse(m);
    if ((await this.get(validated.id)) === null) {
      throw new Error(`cannot update unknown mission '${validated.id}'`);
    }
    await writeFile(this.pathFor(validated.id), JSON.stringify(validated), { mode: 0o600 });
  }

  updateSync(m: QueuedMission): void {
    const validated = QueuedMissionSchema.parse(m);
    if (!existsSync(this.pathFor(validated.id))) {
      throw new Error(`cannot update unknown mission '${validated.id}'`);
    }
    writeFileSync(this.pathFor(validated.id), JSON.stringify(validated), { mode: 0o600 });
  }

  async get(id: string): Promise<QueuedMission | null> {
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

/** #797: the subdirectory of a mission queue directory that holds queued Journey calls. */
export const JOURNEY_CALLS_SUBDIR = "journeys";

/** What `queue_journey` / `journey queue` write and `jevitate mission run` drains (#797). */
export interface JourneyCallQueueStore {
  enqueue(r: QueuedJourneyRecord): Promise<void>;
  get(id: string): Promise<QueuedJourneyRecord | null>;
  list(): Promise<QueuedJourneyRecord[]>;
  /** Atomically claims `id` for one drain; false when another drain already holds it (never removed). */
  claim(id: string, owner: ClaimOwner): Promise<boolean>;
  /** Who claimed `id`, or null (GAPS 20: a drain tells a call whose drain died from one still running). */
  claimOwner(id: string): Promise<ClaimOwner | null>;
  update(r: QueuedJourneyRecord): Promise<void>;
}

/**
 * #797: queued Journey calls, filesystem-backed, in `<queue dir>/journeys/` (so `FsMissionQueueStore`
 * over the same queue dir never reads one as a mission). Each record is validated BEFORE any disk I/O,
 * so a call carrying a secret-named param is refused with nothing written (not even the directory).
 */
export class FsJourneyCallQueueStore implements JourneyCallQueueStore {
  private readonly dir: string;
  constructor(queueDir: string) {
    this.dir = join(queueDir, JOURNEY_CALLS_SUBDIR);
  }

  private pathFor(id: string, suffix = ".json"): string {
    return safeChildPath(this.dir, id, { what: "journey call id", suffix });
  }

  async enqueue(r: QueuedJourneyRecord): Promise<void> {
    const validated = QueuedJourneyRecordSchema.parse(r);
    const path = this.pathFor(validated.id);
    await mkdir(this.dir, { recursive: true, mode: 0o700 });
    await writeFile(path, JSON.stringify(validated), { mode: 0o600, flag: "wx" });
  }

  async claim(id: string, owner: ClaimOwner): Promise<boolean> {
    await mkdir(this.dir, { recursive: true, mode: 0o700 });
    return writeClaimExclusively(this.pathFor(id, ".claim"), owner);
  }

  async claimOwner(id: string): Promise<ClaimOwner | null> {
    let raw: string;
    try {
      raw = await readFile(this.pathFor(id, ".claim"), "utf8");
    } catch (err) {
      if (isNodeError(err, "ENOENT")) return null;
      throw err;
    }
    return parseClaimOwner(raw);
  }

  async update(r: QueuedJourneyRecord): Promise<void> {
    const validated = QueuedJourneyRecordSchema.parse(r);
    if ((await this.get(validated.id)) === null) throw new Error(`cannot update unknown journey call '${validated.id}'`);
    await writeFile(this.pathFor(validated.id), JSON.stringify(validated), { mode: 0o600 });
  }

  async get(id: string): Promise<QueuedJourneyRecord | null> {
    let raw: string;
    try {
      raw = await readFile(this.pathFor(id), "utf8");
    } catch (err) {
      if (isNodeError(err, "ENOENT")) return null;
      throw err;
    }
    return QueuedJourneyRecordSchema.parse(JSON.parse(raw));
  }

  async list(): Promise<QueuedJourneyRecord[]> {
    let entries: string[];
    try {
      entries = await readdir(this.dir);
    } catch (err) {
      if (isNodeError(err, "ENOENT")) return [];
      throw err;
    }
    const out: QueuedJourneyRecord[] = [];
    for (const entry of entries) {
      if (!entry.endsWith(".json")) continue;
      try {
        out.push(QueuedJourneyRecordSchema.parse(JSON.parse(await readFile(join(this.dir, entry), "utf8"))));
      } catch {
        continue; // as FsMissionQueueStore.list: one unreadable file never hides the rest
      }
    }
    return out;
  }
}
