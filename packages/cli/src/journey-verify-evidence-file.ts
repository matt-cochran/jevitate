import { randomBytes } from "node:crypto";
import { mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
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
