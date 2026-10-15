import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { assertInsideRoot, assertSafeName, isNodeError } from "@jevitate/domain";
import { resolveDataDir } from "./data-dir.js";

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
export const DEFAULT_TRUST_DIR = resolveDataDir(["trust"]);

/** A source id is a user-chosen source NAME not otherwise constrained, so it keeps the old rule
 * (no `/`, `\\`, `..`) PLUS non-empty, no NUL and no `:` (drive prefix) — never looser (#520). */
function assertSafeSourceId(id: string): void {
  if (typeof id !== "string" || id.length === 0 || id.includes("/") || id.includes("\\") || id.includes("..") || id.includes("\u0000") || id.includes(":")) {
    throw new Error(`Invalid sourceId (path traversal risk): ${JSON.stringify(id)}`);
  }
}

/** Filesystem-backed, content-hash-bound trust store (spec §5, FMECA #2).
 * One JSON file per `<sourceId>__<journeyId>` pair under `dir`. */
export class FsTrustStore implements TrustStore {
  constructor(private readonly dir: string) {}

  private keyFor(sourceId: string, journeyId: string): string {
    assertSafeSourceId(sourceId);
    assertSafeName(journeyId, "journeyId");
    return assertInsideRoot(this.dir, `${sourceId}__${journeyId}.json`, "trust key");
  }

  async get(sourceId: string, journeyId: string): Promise<TrustRecord | null> {
    const path = this.keyFor(sourceId, journeyId);
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
    const path = this.keyFor(record.sourceId, record.journeyId);
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
