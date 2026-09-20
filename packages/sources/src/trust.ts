import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

export interface TrustRecord {
  sourceId: string;
  journeyId: string;
  contentHash: string;
  approvedBy: string;
  approvedAtIso: string;
}

export interface TrustStore {
  get(sourceId: string, journeyId: string): Promise<TrustRecord | null>;
  put(record: TrustRecord): Promise<void>;
  list(): Promise<TrustRecord[]>;
}

/** §14.1 — TrustStore is LOCAL/per-user, never written into the shared
 * `jevitate.lock`: trust is a human judgment made on this machine, not
 * something a teammate's lock can grant (FMECA #2/#5; §9.9 flat sources). */
export const DEFAULT_TRUST_DIR = join(homedir(), ".doit", "trust");

/** Rejects a `sourceId`/`journeyId` containing a path separator or `..`
 * segment — mirrors `@jevitate/journey`'s `assertSafeId` — since both are used
 * to build the on-disk key filename. */
function assertSafeId(id: string, label: string): void {
  if (id.includes("/") || id.includes("\\") || id.includes("..") || id.length === 0) {
    throw new Error(`Invalid ${label} (path traversal risk): ${id}`);
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

/** Filesystem-backed, content-hash-bound trust store (spec §5, FMECA #2).
 * One JSON file per `<sourceId>__<journeyId>` pair under `dir`. */
export class FsTrustStore implements TrustStore {
  constructor(private readonly dir: string) {}

  private keyFor(sourceId: string, journeyId: string): string {
    assertSafeId(sourceId, "sourceId");
    assertSafeId(journeyId, "journeyId");
    return `${sourceId}__${journeyId}.json`;
  }

  async get(sourceId: string, journeyId: string): Promise<TrustRecord | null> {
    const path = join(this.dir, this.keyFor(sourceId, journeyId));
    let raw: string;
    try {
      raw = await readFile(path, "utf8");
    } catch (err) {
      if (isNodeError(err, "ENOENT")) return null;
      throw err;
    }
    return JSON.parse(raw) as TrustRecord;
  }

  async put(record: TrustRecord): Promise<void> {
    const path = join(this.dir, this.keyFor(record.sourceId, record.journeyId));
    await mkdir(this.dir, { recursive: true, mode: 0o700 });
    await writeFile(path, JSON.stringify(record), { mode: 0o600 });
  }

  async list(): Promise<TrustRecord[]> {
    let entries: string[];
    try {
      entries = await readdir(this.dir);
    } catch (err) {
      if (isNodeError(err, "ENOENT")) return [];
      throw err;
    }
    const out: TrustRecord[] = [];
    for (const entry of entries) {
      if (!entry.endsWith(".json")) continue;
      const raw = await readFile(join(this.dir, entry), "utf8");
      out.push(JSON.parse(raw) as TrustRecord);
    }
    return out;
  }
}

/**
 * True ONLY if a `TrustRecord` exists for `(sourceId, journeyId)` AND its
 * recorded `contentHash` equals the CURRENT `contentHash` passed in. This is
 * the TOCTOU close (FMECA #2, spec §5): a source update that changed the
 * Journey's bytes invalidates a prior review — trust never silently carries
 * forward across a content change.
 */
export async function isTrusted(
  store: TrustStore,
  sourceId: string,
  journeyId: string,
  contentHash: string,
): Promise<boolean> {
  const record = await store.get(sourceId, journeyId);
  return record !== null && record.contentHash === contentHash;
}
