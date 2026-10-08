import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { JourneySchema, type Journey } from "@jevitate/journey";
import type { JourneyVerifyRecord } from "./journey-review.js";

/**
 * #432 — the review sheet's sidecars beside a journeys directory (dot-folders: never listed as a
 * Journey, never discovered as a namespace):
 *  - `.approved/<id>.json` — the Journey exactly as last approved (`journey promote`, `demo approve`),
 *    what "change since last approval" diffs against;
 *  - `.verify/<id>.json` — the last `journey verify --mutate` verdict, bound to the review hash.
 * `<ns>/<id>` for a shared Journey. Neither ever holds a secret value: a Journey never carries one.
 */

function sidecarPath(journeysDir: string, folder: string, id: string): string {
  const parts = id.split("/");
  return join(journeysDir, folder, ...parts.slice(0, -1), `${parts[parts.length - 1] ?? id}.json`);
}

export function approvedSnapshotPath(journeysDir: string, id: string): string {
  return sidecarPath(journeysDir, ".approved", id);
}

export function verifyRecordPath(journeysDir: string, id: string): string {
  return sidecarPath(journeysDir, ".verify", id);
}

/** A sidecar that exists but cannot be read as what it should be — refused, never silently ignored. */
export class ReviewSidecarError extends Error {
  readonly code = "E_JOURNEY_REVIEW";
}

async function readJson(path: string): Promise<unknown | null> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (err) {
    if (typeof err === "object" && err !== null && "code" in err && err.code === "ENOENT") return null;
    throw err;
  }
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    throw new ReviewSidecarError(`${path} is not valid JSON`);
  }
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
}

/** The file's own (plain) id, as `FsJourneyStore` writes a namespaced Journey. */
function baseId(id: string): string {
  const parts = id.split("/");
  return parts[parts.length - 1] ?? id;
}

/** #432: keeps the Journey as approved — the next review's "change since last approval" diffs against it. */
export async function writeApprovedSnapshot(journeysDir: string, journey: Journey): Promise<void> {
  const id = journey.metadata.id;
  await writeJson(approvedSnapshotPath(journeysDir, id), JourneySchema.parse({ ...journey, metadata: { ...journey.metadata, id: baseId(id) } }));
}

/** #432: the Journey as last approved, or null when none was kept. */
export async function readApprovedSnapshot(journeysDir: string, id: string): Promise<Journey | null> {
  const path = approvedSnapshotPath(journeysDir, id);
  const raw = await readJson(path);
  if (raw === null) return null;
  const parsed = JourneySchema.safeParse(raw);
  if (!parsed.success) throw new ReviewSidecarError(`${path} is not a valid Journey snapshot`);
  return { ...parsed.data, metadata: { ...parsed.data.metadata, id } };
}

/** #432: records the last mutation-proof verdict beside the Journey. */
export async function writeVerifyRecord(journeysDir: string, record: JourneyVerifyRecord): Promise<void> {
  await writeJson(verifyRecordPath(journeysDir, record.journeyId), record);
}

function isVerifyRecord(v: unknown): v is JourneyVerifyRecord {
  if (v === null || typeof v !== "object") return false;
  const o = v as Record<string, unknown>;
  return (
    typeof o.journeyId === "string" &&
    typeof o.contentHash === "string" &&
    typeof o.verdict === "string" &&
    typeof o.at === "string" &&
    (o.reason === undefined || typeof o.reason === "string") &&
    o.summary !== null &&
    typeof o.summary === "object" &&
    Object.values(o.summary as object).every((n) => typeof n === "number")
  );
}

/** #432: the last recorded mutation-proof verdict, or null when `journey verify --mutate` never ran. */
export async function readVerifyRecord(journeysDir: string, id: string): Promise<JourneyVerifyRecord | null> {
  const path = verifyRecordPath(journeysDir, id);
  const raw = await readJson(path);
  if (raw === null) return null;
  if (!isVerifyRecord(raw)) throw new ReviewSidecarError(`${path} is not a valid verify record`);
  return raw;
}
