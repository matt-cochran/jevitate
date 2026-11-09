import { createHash, randomBytes } from "node:crypto";
import { chmodSync, closeSync, fsyncSync, linkSync, lstatSync, mkdirSync, openSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync, writeSync } from "node:fs";
import { join } from "node:path";
import { RunEvidenceSchema, type RunEvidence } from "@jevitate/adjudicator";
import { EVIDENCE_FILE } from "./journey-run-evidence.js";

/**
 * #812 / design §2.3: `journey verify` writes the proof's `RunEvidence` as `<outDir>/evidence.json`
 * beside its result (`logs/<date>/journey-verify-<id>-<stamp>/`, pruned with that result). The record is
 * value-free by construction (the gatherer keys params by HMAC); it is parsed again here so nothing
 * that fails its schema is persisted. Atomic, mode 0600. Returns why it could not write and never
 * throws: a proof's verdict stands whether or not its evidence landed.
 */
export function writeVerifyEvidence(outDir: string, evidence: RunEvidence): string | undefined {
  const parsed = RunEvidenceSchema.safeParse(evidence);
  if (!parsed.success) return "the evidence record was not written: it did not pass its schema; the proof's verdict stands";
  let tmp: string | undefined;
  try {
    mkdirSync(outDir, { recursive: true });
    tmp = join(outDir, `.${EVIDENCE_FILE}.${randomBytes(4).toString("hex")}.tmp`);
    writeFileSync(tmp, `${JSON.stringify(parsed.data, null, 2)}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
    renameSync(tmp, join(outDir, EVIDENCE_FILE));
    tmp = undefined;
    return undefined;
  } catch (err) {
    if (tmp !== undefined) rmSync(tmp, { force: true });
    const code = err !== null && typeof err === "object" && "code" in err ? String(err.code) : "error";
    return `the evidence record could not be written (${code}); the proof's verdict stands`;
  }
}

/** #818: how many native reports `journey verify` keeps per Journey; the oldest beyond it are pruned. */
export const NATIVE_REPORT_RETENTION = 20;

const NATIVE_REPORT_FILE = /^[0-9A-Za-z-]+-[0-9a-f]{12}\.json$/;

/**
 * #818: persists a proof's redacted native report (`envelope`, built by the caller from the report it
 * is about to return) as `<dir>/<stamp>-<sha256[0..12]>.json`, before anything reaches stdout, so a
 * transport that dies after the proof loses none of it. Content-addressed and never replaced: the file
 * is fsynced under a temporary name and then hard-linked into place, which fails rather than overwrite;
 * an existing file there with the same bytes is the same report. Mode 0600 in a 0700 directory; the
 * oldest beyond `NATIVE_REPORT_RETENTION` are pruned. Returns the path and the SHA-256 of the exact
 * bytes, or why it could not write: it never throws, and never claims a file it did not write.
 */
export function writeVerifyNativeReport(dir: string, stamp: string, envelope: unknown): { readonly path: string; readonly sha256: string } | { readonly error: string } {
  const bytes = Buffer.from(`${JSON.stringify(envelope, null, 2)}\n`, "utf8");
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const path = join(dir, `${stamp.replace(/[^0-9A-Za-z-]/g, "-")}-${sha256.slice(0, 12)}.json`);
  let tmp: string | undefined;
  try {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const parent = lstatSync(dir);
    if (!parent.isDirectory() || parent.isSymbolicLink()) throw Object.assign(new Error("not a directory"), { code: "ENOTDIR" });
    chmodSync(dir, 0o700);
    tmp = join(dir, `.native-report.${randomBytes(4).toString("hex")}.tmp`);
    const fd = openSync(tmp, "wx", 0o600);
    try {
      writeSync(fd, bytes);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    try {
      linkSync(tmp, path);
    } catch (err) {
      if (!(err !== null && typeof err === "object" && "code" in err && err.code === "EEXIST")) throw err;
      // Same name, so the same hash prefix: only the exact same bytes count as this report.
      if (!readFileSync(path).equals(bytes)) throw Object.assign(new Error("a different report is at that path"), { code: "EEXIST" });
    }
    rmSync(tmp, { force: true });
    tmp = undefined;
  } catch (err) {
    if (tmp !== undefined) rmSync(tmp, { force: true });
    const code = err !== null && typeof err === "object" && "code" in err ? String(err.code) : "error";
    return { error: `the native report could not be written (${code}); the proof's verdict stands, but its full report exists only in this output` };
  }
  pruneNativeReports(dir, path);
  return { path, sha256 };
}

/** Keeps the newest `NATIVE_REPORT_RETENTION` (names sort by their stamp), never the one just written. Best effort. */
function pruneNativeReports(dir: string, keep: string): void {
  try {
    const files = readdirSync(dir).filter((f) => NATIVE_REPORT_FILE.test(f)).sort();
    for (const f of files.slice(0, Math.max(0, files.length - NATIVE_REPORT_RETENTION))) if (join(dir, f) !== keep) rmSync(join(dir, f), { force: true });
  } catch {
    // Retention never costs the report that was just written.
  }
}
