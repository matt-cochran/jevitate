import { constants } from "node:fs";
import { lstat, mkdir, open, rename, unlink } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import { randomUUID } from "node:crypto";
import { contentHash, isNodeError } from "@jevitate/domain";
import { z } from "zod";
import { ApprovalProvenanceSchema } from "@jevitate/journey";

const digest = z.string().regex(/^[a-f0-9]{64}$/);
export const AnnotationTransactionSchema = z.object({
  hash: digest, draftHash: digest, beforeContentHash: digest, afterContentHash: digest, afterReviewHash: digest,
}).strict();
export type AnnotationTransaction = z.infer<typeof AnnotationTransactionSchema>;
export const AnnotationOriginSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("annotations") }).strict(),
  z.object({ kind: z.literal("demo"), draftHash: digest, reviewHash: digest,
    waivers: z.array(z.object({ flag: z.string(), reason: z.string(), detail: z.string().optional() }).strict()).max(50),
  }).strict(),
]);
export type AnnotationOrigin = z.infer<typeof AnnotationOriginSchema>;
const AnnotationApprovalSchema = z.object({
  kind: z.literal("journey-annotation-approval"), version: z.literal(1), id: z.string().min(1),
  transaction: AnnotationTransactionSchema,
  phase: z.enum(["approved", "applied"]), at: z.string().datetime({ offset: true }),
  provenance: ApprovalProvenanceSchema,
  origin: AnnotationOriginSchema,
}).strict().refine((record) => record.origin.kind === "demo" ? record.origin.reviewHash === record.transaction.afterReviewHash : record.provenance.channel === "tty");
export type AnnotationApproval = z.infer<typeof AnnotationApprovalSchema>;
export class AnnotationTransactionError extends Error {
  readonly code = "E_JOURNEY_ANNOTATIONS_TRANSACTION";
  constructor() { super("Annotation transaction is invalid, changed, or incomplete; inspect native annotation status before retrying."); }
}
export interface AnnotationFile { readonly raw: string; readonly identity: string }

/** The root is trusted configuration; each component beneath it must be a native directory. */
async function parents(root: string, path: string, create = false): Promise<string | null> {
  const rel = relative(resolve(root), resolve(dirname(path)));
  if (rel === ".." || rel.startsWith(`..${sep}`) || resolve(root, rel) !== resolve(dirname(path))) throw new AnnotationTransactionError();
  const parts = rel === "" ? [] : rel.split(sep);
  let current = resolve(root);
  const ids: string[] = [];
  for (let i = -1; i < parts.length; i++) {
    if (i >= 0) current = join(current, parts[i]!);
    let st;
    try { st = await lstat(current); }
    catch (err) {
      if (!isNodeError(err, "ENOENT")) throw new AnnotationTransactionError();
      if (!create || i < 0) return null;
      await mkdir(current, { mode: 0o700 });
      st = await lstat(current);
    }
    if (!st.isDirectory() || st.isSymbolicLink()) throw new AnnotationTransactionError();
    ids.push(`${st.dev}:${st.ino}`);
  }
  return ids.join("/");
}

/** No symlinks, non-files, alien ownership, or replacement during a read. Never exposes raw errors. */
export async function readAnnotationFile(root: string, path: string): Promise<AnnotationFile | null> {
  const before = await parents(root, path);
  if (before === null) return null;
  let expected;
  try { expected = await lstat(path); }
  catch (err) { if (isNodeError(err, "ENOENT")) return null; throw new AnnotationTransactionError(); }
  if (!expected.isFile() || expected.isSymbolicLink() || (process.getuid !== undefined && expected.uid !== process.getuid()) || typeof constants.O_NOFOLLOW !== "number") throw new AnnotationTransactionError();
  let handle;
  try { handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); }
  catch (err) { if (isNodeError(err, "ENOENT")) return null; throw new AnnotationTransactionError(); }
  try {
    const st = await handle.stat();
    if (!st.isFile() || st.dev !== expected.dev || st.ino !== expected.ino || (process.getuid !== undefined && st.uid !== process.getuid())) throw new AnnotationTransactionError();
    const raw = await handle.readFile("utf8");
    const now = await lstat(path);
    if (!now.isFile() || now.ino !== st.ino || now.dev !== st.dev || now.size !== st.size || now.mtimeMs !== st.mtimeMs || before !== await parents(root, path)) throw new AnnotationTransactionError();
    return { raw, identity: contentHash({ parents: before, dev: st.dev, ino: st.ino, raw }) };
  } catch { throw new AnnotationTransactionError(); }
  finally { await handle.close(); }
}

export function annotationApprovalPath(draftPath: string): string { return draftPath.replace(/\.json$/, ".approval.json"); }
export function annotationTransaction(id: string, fields: Omit<AnnotationTransaction, "hash">): AnnotationTransaction {
  return { ...fields, hash: contentHash({ domain: "jevitate.annotation-transaction.v1", id, ...fields }) };
}
export function parseAnnotationApproval(file: AnnotationFile | null, id: string): AnnotationApproval | null {
  if (file === null) return null;
  try {
    const result = AnnotationApprovalSchema.parse(JSON.parse(file.raw));
    const { hash, ...fields } = result.transaction;
    if (result.id !== id || annotationTransaction(id, fields).hash !== hash) throw new AnnotationTransactionError();
    return result;
  } catch { throw new AnnotationTransactionError(); }
}

export async function writeAnnotationApproval(root: string, path: string, value: AnnotationApproval, expected: AnnotationFile | null): Promise<void> {
  const validated = AnnotationApprovalSchema.parse(value);
  const parent = await parents(root, path, true);
  if (parent === null) throw new AnnotationTransactionError();
  const temp = `${path}.${randomUUID()}.tmp`;
  try {
    const handle = await open(temp, "wx", 0o600);
    try { await handle.writeFile(JSON.stringify(validated)); await handle.sync(); } finally { await handle.close(); }
    const current = await readAnnotationFile(root, path);
    if (current?.identity !== expected?.identity || parent !== await parents(root, path)) throw new AnnotationTransactionError();
    await rename(temp, path);
    const dir = await open(dirname(path), "r");
    try { await dir.sync(); } finally { await dir.close(); }
  } catch { throw new AnnotationTransactionError(); }
  finally { await unlink(temp).catch((err: unknown) => { if (!isNodeError(err, "ENOENT")) throw new AnnotationTransactionError(); }); }
}

export async function removeAnnotationDraft(root: string, path: string, expected: Pick<AnnotationFile, "identity">): Promise<void> {
  try {
    const current = await readAnnotationFile(root, path);
    if (current?.identity !== expected.identity) throw new AnnotationTransactionError();
    await unlink(path);
    const dir = await open(dirname(path), "r");
    try { await dir.sync(); } finally { await dir.close(); }
  } catch { throw new AnnotationTransactionError(); }
}

// Serializes native annotation writers in this process. Filesystem identities/preimages additionally
// detect conflicting external writers; this is not a hostile cross-process filesystem CAS primitive.
const transactions = new Map<string, Promise<void>>();
export async function withAnnotationTransaction<T>(root: string, id: string, action: () => Promise<T>): Promise<T> {
  const key = `${resolve(root)}\0${id}`;
  const previous = transactions.get(key) ?? Promise.resolve();
  let release!: () => void;
  const next = new Promise<void>((done) => { release = done; });
  transactions.set(key, next);
  await previous;
  try { return await action(); }
  finally { release(); if (transactions.get(key) === next) transactions.delete(key); }
}
