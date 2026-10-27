import { lstat, mkdir, open, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import { JourneySchema, type Journey } from "@jevitate/journey";
import type { JourneyVerifyRecord } from "./journey-review.js";
import { JourneyProofContextSchema } from "./journey-proof-context.js";
import { ProofWaiverSchema, type ProofWaiver } from "./mutation-proof-policy.js";

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

export function proofWaiverPath(journeysDir: string, id: string): string {
  return sidecarPath(journeysDir, ".proof-waivers", id);
}

export async function readProofWaiver(journeysDir: string, id: string): Promise<ProofWaiver | null> {
  const path = proofWaiverPath(journeysDir, id);
  const raw = await readJson(path);
  if (raw === null) return null;
  const parsed = ProofWaiverSchema.safeParse(raw);
  if (!parsed.success || parsed.data.journeyId !== id) throw new ReviewSidecarError(`${path} is not a valid human mutation-proof waiver`);
  return parsed.data;
}

export async function writeProofWaiver(journeysDir: string, waiver: ProofWaiver): Promise<void> {
  await writeJson(proofWaiverPath(journeysDir, waiver.journeyId), ProofWaiverSchema.parse(waiver));
}

/** A sidecar that exists but cannot be read as what it should be — refused, never silently ignored. */
export class ReviewSidecarError extends Error {
  readonly code = "E_JOURNEY_REVIEW";
}

/** A receipt destination proven writable before a mutation proof spends browser/model work. */
export interface VerifyReceiptDestination {
  readonly path: string;
  readonly parent: string;
  readonly parentDevice: number | bigint;
  readonly parentInode: number | bigint;
  readonly existing?: { readonly device: number | bigint; readonly inode: number | bigint };
}

/** #711: a receipt path that cannot be safely created/replaced fails before proof execution. */
export class VerifyReceiptPreflightError extends Error {
  readonly code = "E_VERIFY_RECEIPT_PREFLIGHT";
}

function mode(stat: { mode: number | bigint }): string {
  return `0${(Number(stat.mode) & 0o777).toString(8).padStart(3, "0")}`;
}

function owner(stat: { uid: number | bigint; gid: number | bigint }): string {
  return `${stat.uid}:${stat.gid}`;
}

function receiptError(path: string, detail: string): VerifyReceiptPreflightError {
  return new VerifyReceiptPreflightError(`cannot safely replace verify receipt ${path}: ${detail}. Preserve it, then restore workspace ownership (for example: sudo chown "$(id -u):$(id -g)" ${path}) before retrying`);
}

/**
 * #711: establish that the exact `.verify` receipt can be atomically created/replaced before a
 * mutation matrix opens a browser. Symlinks, non-files, foreign-owned receipts and unwritable
 * destinations are refused without reading receipt contents.
 */
export async function preflightVerifyRecord(journeysDir: string, id: string): Promise<VerifyReceiptDestination> {
  const path = verifyRecordPath(journeysDir, id);
  const parent = dirname(path);
  await mkdir(parent, { recursive: true, mode: 0o700 });
  const parentStat = await lstat(parent);
  if (!parentStat.isDirectory() || parentStat.isSymbolicLink()) throw receiptError(path, `parent ${parent} is not a real directory`);
  let existing: Awaited<ReturnType<typeof lstat>> | undefined;
  try {
    existing = await lstat(path);
  } catch (error) {
    if (!(typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT")) throw receiptError(path, error instanceof Error ? error.message : String(error));
  }
  if (existing !== undefined) {
    if (!existing.isFile() || existing.isSymbolicLink()) throw receiptError(path, `existing destination is not a regular file (owner ${owner(existing)}, mode ${mode(existing)})`);
    const uid = process.getuid?.();
    if (uid !== undefined && existing.uid !== uid) throw receiptError(path, `existing receipt is owned by ${owner(existing)} with mode ${mode(existing)}`);
    try {
      const handle = await open(path, "r+");
      await handle.close();
    } catch (error) {
      throw receiptError(path, `existing receipt is not writable (owner ${owner(existing)}, mode ${mode(existing)}; ${error instanceof Error ? error.message : String(error)})`);
    }
  }
  return { path, parent, parentDevice: parentStat.dev, parentInode: parentStat.ino, ...(existing === undefined ? {} : { existing: { device: existing.dev, inode: existing.ino } }) };
}

/** Write a verified receipt through a same-directory, fsynced temporary file and atomic rename. */
async function assertReceiptUnchanged(destination: VerifyReceiptDestination): Promise<void> {
  const parent = await lstat(destination.parent);
  if (!parent.isDirectory() || parent.isSymbolicLink() || parent.dev !== destination.parentDevice || parent.ino !== destination.parentInode) {
    throw receiptError(destination.path, "receipt directory changed while the proof was running");
  }
  let current: Awaited<ReturnType<typeof lstat>> | undefined;
  try {
    current = await lstat(destination.path);
  } catch (error) {
    if (!(typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT")) throw receiptError(destination.path, error instanceof Error ? error.message : String(error));
  }
  if (destination.existing === undefined ? current !== undefined : current === undefined || !current.isFile() || current.isSymbolicLink() || current.dev !== destination.existing.device || current.ino !== destination.existing.inode) {
    throw receiptError(destination.path, "destination changed while the proof was running (concurrent writer refused)");
  }
}

export async function writePreflightedVerifyRecord(destination: VerifyReceiptDestination, record: JourneyVerifyRecord): Promise<void> {
  await assertReceiptUnchanged(destination);
  const temporary = join(destination.parent, `.${basename(destination.path)}.${randomUUID()}.tmp`);
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(temporary, "wx", 0o600);
    await handle.writeFile(`${JSON.stringify(record, null, 2)}\n`, "utf8");
    await handle.sync();
    await handle.close();
    handle = undefined;
    // A second check closes the race between preflight and rename: another writer wins neither
    // silently nor partially; this proof fails closed and leaves its receipt intact.
    await assertReceiptUnchanged(destination);
    await rename(temporary, destination.path);
  } finally {
    await handle?.close().catch(() => undefined);
    await unlink(temporary).catch(() => undefined);
  }
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
  await writePreflightedVerifyRecord(await preflightVerifyRecord(journeysDir, record.journeyId), record);
}

function isVerifyRecord(v: unknown): v is JourneyVerifyRecord {
  if (v === null || typeof v !== "object") return false;
  const o = v as Record<string, unknown>;
  return (
    typeof o.journeyId === "string" &&
    typeof o.contentHash === "string" &&
    (o.proofHash === undefined || typeof o.proofHash === "string") &&
    (o.proofContext === undefined || JourneyProofContextSchema.safeParse(o.proofContext).success) &&
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
