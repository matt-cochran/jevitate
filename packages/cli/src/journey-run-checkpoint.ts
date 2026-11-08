import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { closeSync, constants, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync, readSync, renameSync, unlinkSync, writeSync } from "node:fs";
import { dirname } from "node:path";
import { z } from "zod";
import { canonicalJson } from "./journey-verify-checkpoint.js";

/**
 * #793 (docs/design/0.30.0-evidence-and-trust.md §5.4): the resumable, value-free state of a run held
 * at a step. A held run stops before the pending action acts; what a later `jevitate inbox resume`
 * needs to continue from there without repeating the steps before it is the Journey it was (id and
 * content hash), the step it stopped at, and the page it was on. The page address is kept with every
 * parameter value (raw and URL-encoded) replaced by a `{param:<name>}` placeholder and every value the
 * run extracted by `{masked}`, so the file holds names and never a value: the resume puts the person's
 * parameters back (they are bound to the hold by its keyed `paramsDigest`), and an address that held an
 * extracted value cannot be restored and is refused.
 *
 * The file is `{ body, mac }`, the mac an HMAC-SHA-256 under the #787 key (`verify-checkpoint.key`)
 * with its own label, written as the verify checkpoint is (tmp, fsync, rename, then the directory).
 */

const WRITE_FLAGS = constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0);
const READ_FLAGS = constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0);
/** No signed file this code writes comes near this. */
const MAX_SIGNED_BYTES = 256 * 1024;
const CHECKPOINT_LABEL = "jevitate-run-checkpoint/1";

const digest = z.string().regex(/^[0-9a-f]{64}$/);

/** The masked page address: a URL whose values are placeholders (restored, it is checked again as a URL). */
const MaskedUrlSchema = z.string().min(1).max(8192);

export const RunCheckpointSchema = z.strictObject({
  version: z.literal(1),
  /** The hold this checkpoint belongs to. */
  hold: z.string().regex(/^[a-z0-9][a-z0-9_-]{0,63}$/),
  journey: z.strictObject({ id: z.string().min(1).max(256), hash: z.string().min(1).max(128) }),
  /** 1-based, as `StepEvidence.index`: the step whose action is pending. */
  step: z.number().int().min(1),
  /** The page the run was on when it was held, masked. */
  url: MaskedUrlSchema,
  createdAt: z.string().min(1).max(64),
});
export type RunCheckpoint = z.infer<typeof RunCheckpointSchema>;

const PLACEHOLDER = /\{(param|param-enc):([^{}]{1,128})\}/g;
const MASKED = "{masked}";

// --- Signed, atomic files (shared with journey-hold.ts) --------------------------------------------------

/** The HMAC of `body` under `label`: canonical JSON, so key order never changes it. */
export function signedMac(key: Buffer, label: string, body: unknown): string {
  return createHmac("sha256", key).update(`${label}\0`).update(canonicalJson(body)).digest("hex");
}

/** The exact bytes a signed file holds for `body`: what `writeSignedFile` writes. */
export function signedFileText(key: Buffer, label: string, body: unknown): string {
  return `${JSON.stringify({ body, mac: signedMac(key, label, body) }, null, 2)}\n`;
}

/** tmp, fsync, rename, then the directory: a reader sees the old file or the new one, whole. Refuses a link or a non-file at the path. */
export function writeSignedFile(path: string, key: Buffer, label: string, body: unknown): void {
  const dir = dirname(path);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (!lstatSync(dir).isDirectory()) throw new Error("the holds directory is a link or a file");
  try {
    if (!lstatSync(path).isFile()) throw new Error("something other than a regular file is at the hold's path");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }
  const tmp = `${path}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
  const fd = openSync(tmp, WRITE_FLAGS, 0o600);
  try {
    try {
      writeSync(fd, signedFileText(key, label, body));
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(tmp, path);
  } catch (err) {
    try {
      unlinkSync(tmp);
    } catch {
      // The write's own error is the one to report; a leftover tmp is never read.
    }
    throw err;
  }
  const dirFd = openSync(dir, constants.O_RDONLY);
  try {
    fsyncSync(dirFd);
  } catch (err) {
    // Some filesystems refuse fsync on a directory; the rename has still happened.
    if (!["EINVAL", "EPERM", "EISDIR", "ENOTSUP"].includes((err as NodeJS.ErrnoException).code ?? "")) throw err;
  } finally {
    closeSync(dirFd);
  }
}

export type SignedRead<T> =
  | { readonly kind: "none" }
  | { readonly kind: "bad"; readonly detail: string }
  | { readonly kind: "read"; readonly body: T };

/** Never blocks and never follows a link. A file whose mac is not this key's, or whose body does not parse, is `bad`. */
export function readSignedFile<T>(path: string, key: Buffer, label: string, schema: z.ZodType<T>): SignedRead<T> {
  let fd: number | undefined;
  let text: string;
  try {
    if (!lstatSync(path).isFile()) return { kind: "bad", detail: "it is not a regular file" };
    fd = openSync(path, READ_FLAGS);
    const opened = fstatSync(fd);
    if (!opened.isFile()) return { kind: "bad", detail: "it is not a regular file" };
    if (opened.size > MAX_SIGNED_BYTES) return { kind: "bad", detail: `it is larger than ${MAX_SIGNED_BYTES} bytes` };
    const bytes = Buffer.alloc(opened.size);
    let read = 0;
    while (read < opened.size) {
      const got = readSync(fd, bytes, read, opened.size - read, read);
      if (got === 0) break;
      read += got;
    }
    text = bytes.toString("utf8", 0, read);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return { kind: "none" };
    return { kind: "bad", detail: `it could not be read (${code ?? "error"})` };
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return { kind: "bad", detail: "it is not whole JSON (truncated or damaged)" };
  }
  const outer = z.strictObject({ body: z.unknown(), mac: digest }).safeParse(raw);
  if (!outer.success) return { kind: "bad", detail: "it does not have a signed file's shape" };
  const expected = Buffer.from(signedMac(key, label, outer.data.body), "hex");
  if (!timingSafeEqual(expected, Buffer.from(outer.data.mac, "hex"))) return { kind: "bad", detail: "it does not carry this user's key: it was changed outside jevitate, or the key was replaced" };
  const body = schema.safeParse(outer.data.body);
  if (!body.success) return { kind: "bad", detail: "its content does not have the expected shape" };
  return { kind: "read", body: body.data };
}

// --- The page address, value-free ---------------------------------------------------------------------

/**
 * The page address with every parameter value replaced by its name and every extracted value by
 * `{masked}`. Longer values first, so a value inside another is not split. Values under 3 characters
 * are masked too: a short value may be a common substring, and a wrong placeholder only makes the
 * address unrestorable, never leaks.
 */
export function maskCheckpointUrl(url: string, params: Readonly<Record<string, string>>, extracted: readonly string[] = []): string {
  const swaps: { readonly value: string; readonly by: string }[] = [];
  for (const [name, value] of Object.entries(params)) {
    if (value === "") continue;
    swaps.push({ value, by: `{param:${name}}` });
    const enc = encodeURIComponent(value);
    if (enc !== value) swaps.push({ value: enc, by: `{param-enc:${name}}` });
    const form = new URLSearchParams({ v: value }).toString().slice(2);
    if (form !== value && form !== enc) swaps.push({ value: form, by: MASKED });
  }
  for (const value of extracted) {
    if (value === "") continue;
    swaps.push({ value, by: MASKED });
    const enc = encodeURIComponent(value);
    if (enc !== value) swaps.push({ value: enc, by: MASKED });
  }
  if (swaps.length === 0) return url;
  // One pass over the address: a placeholder put in is never matched again (a value `param` would
  // otherwise hit the text of `{param:x}`). At each position the longest value wins.
  swaps.sort((a, b) => b.value.length - a.value.length);
  const by = new Map<string, string>();
  for (const s of swaps) if (!by.has(s.value)) by.set(s.value, s.by);
  const pattern = new RegExp([...by.keys()].map((v) => v.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|"), "g");
  return url.replace(pattern, (m) => by.get(m) ?? MASKED);
}

/** The address with the person's parameters put back, or why it cannot be restored. */
export function restoreCheckpointUrl(masked: string, params: Readonly<Record<string, string>>): { readonly url: string } | { readonly problem: string } {
  if (masked.includes(MASKED)) return { problem: "the page it was held on had a value the run extracted in its address; it cannot be restored without repeating the steps before it" };
  const missing = new Set<string>();
  const url = masked.replace(PLACEHOLDER, (_m, form: string, name: string) => {
    const value = params[name];
    if (value === undefined) {
      missing.add(name);
      return "";
    }
    return form === "param-enc" ? encodeURIComponent(value) : value;
  });
  if (missing.size > 0) return { problem: `the page address needs the parameter(s) ${[...missing].sort().join(", ")}` };
  return { url };
}

// --- The checkpoint file ------------------------------------------------------------------------------

export function writeRunCheckpoint(path: string, key: Buffer, checkpoint: RunCheckpoint): void {
  writeSignedFile(path, key, CHECKPOINT_LABEL, RunCheckpointSchema.parse(checkpoint));
}

export function readRunCheckpoint(path: string, key: Buffer): SignedRead<RunCheckpoint> {
  return readSignedFile(path, key, CHECKPOINT_LABEL, RunCheckpointSchema);
}
