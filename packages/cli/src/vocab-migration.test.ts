import { createHmac } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FakeClock, installClock, resetClock } from "@jevitate/domain";
import { journeyProofHash, type Journey } from "@jevitate/journey";
import { journeyReviewHash, type JourneyVerifyRecord } from "./journey-review.js";
import { canonicalJson, readVerifyProgress, verifyProgressLine } from "./journey-verify-checkpoint.js";
import { proofVerdictFields, readProofVerdict, verifyExitCode } from "./journey-verify-report.js";
import { DEFAULT_MUTATION_PROOF_POLICY, evaluateMutationProofPolicy, normalizeMutationProofPolicy, resetMutationProofPolicyWarningForTests } from "./mutation-proof-policy.js";
import { loadProjectConfig } from "./project-config.js";

/** d-vocab-migration (0.30.0 §6.1): `sensitive` replaces `proven`; the old word still reads, and the old policy name is an alias that warns once. */

const LEGACY = "proven";

function journey(): Journey {
  return {
    metadata: { id: "save", name: "Save", params: [], promoted: false, createdAtIso: "2026-11-01T00:00:00Z", endState: [{ kind: "page", assertion: { kind: "textIncludes", target: { testId: "status" }, text: "Saved" } }] },
    recording: { version: "1", site: "https://example.test", pages: [{ url: "/", steps: [] }] },
  } as Journey;
}
function record(over: Partial<JourneyVerifyRecord> = {}): JourneyVerifyRecord {
  const j = journey();
  return { journeyId: "save", contentHash: journeyReviewHash(j), proofHash: journeyProofHash(j), verdict: "sensitive", countsForGate: true, engine: { version: "0.30.0", commit: "abc1234" }, target: { origin: new URL(j.recording.site).origin }, summary: { sensitive: 1 }, at: "2026-11-01T00:00:00Z", ...over };
}

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "jev-vocab-"));
  installClock(new FakeClock({ startMs: Date.parse("2026-11-09T12:00:00Z") }));
  resetMutationProofPolicyWarningForTests();
});
afterEach(() => {
  resetClock();
  vi.restoreAllMocks();
  resetMutationProofPolicyWarningForTests();
  rmSync(root, { recursive: true, force: true });
});

describe("mutationProofPolicy: require-proven is an alias for require-sensitive", () => {
  it("project.json {mutationProofPolicy:'require-proven'} behaves as require-sensitive and stderr has exactly one deprecation line naming 0.32.0", () => {
    writeFileSync(join(root, "project.json"), JSON.stringify({ mutationProofPolicy: `require-${LEGACY}` }));
    const stderr: string[] = [];
    vi.spyOn(process.stderr, "write").mockImplementation((chunk: string | Uint8Array) => (stderr.push(String(chunk)), true));
    const first = loadProjectConfig(root);
    const second = loadProjectConfig(root);
    expect(first.mutationProofPolicy).toBe("require-sensitive");
    expect(second.mutationProofPolicy).toBe("require-sensitive");
    const lines = stderr.join("").split("\n").filter((l) => l !== "");
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/deprecated/);
    expect(lines[0]).toContain("0.32.0");
    expect(lines[0]).toContain("require-sensitive");
    // It gates as require-sensitive: a waiver cannot override it, and an uncounted sensitive proof does not satisfy it.
    const j = journey();
    const policy = evaluateMutationProofPolicy({ journey: j, contentHash: journeyReviewHash(j), record: record({ countsForGate: false }), mode: first.mutationProofPolicy });
    expect(policy).toMatchObject({ mode: "require-sensitive", verdict: "sensitive", passed: false });
  });

  it("require-sensitive itself loads silently", () => {
    writeFileSync(join(root, "project.json"), JSON.stringify({ mutationProofPolicy: "require-sensitive" }));
    const write = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    expect(loadProjectConfig(root).mutationProofPolicy).toBe("require-sensitive");
    expect(write).not.toHaveBeenCalled();
  });

  it("an unknown policy is still refused, naming the new word", () => {
    writeFileSync(join(root, "project.json"), JSON.stringify({ mutationProofPolicy: "require-perfect" }));
    expect(() => loadProjectConfig(root)).toThrow(/advisory, require-attempt or require-sensitive/);
  });

  it("the default is advisory (owner decision: job gates, proof advisory)", () => {
    expect(DEFAULT_MUTATION_PROOF_POLICY).toBe("advisory");
    expect(normalizeMutationProofPolicy(undefined)).toBe("advisory");
    const j = journey();
    expect(evaluateMutationProofPolicy({ journey: j, contentHash: journeyReviewHash(j), record: null })).toMatchObject({ mode: "advisory", passed: true });
  });

  it("the alias passed straight to the policy evaluates as require-sensitive and warns once", () => {
    const warn = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const j = journey();
    const input = { journey: j, contentHash: journeyReviewHash(j), record: record(), mode: `require-${LEGACY}` as const };
    expect(evaluateMutationProofPolicy(input)).toMatchObject({ mode: "require-sensitive", passed: true, reason: "fresh sensitive mutation evidence" });
    expect(evaluateMutationProofPolicy(input).mode).toBe("require-sensitive");
    expect(warn).toHaveBeenCalledTimes(1);
  });
});

describe("receipts written before 0.30.0 still read", () => {
  it("a 0.29.0 verify receipt with verdict 'proven' satisfies the policy as 'sensitive'", () => {
    const j = journey();
    const policy = evaluateMutationProofPolicy({ journey: j, contentHash: journeyReviewHash(j), record: record({ verdict: LEGACY, countsForGate: true, engine: { version: "0.29.0", commit: "abc1234" } }), mode: "require-sensitive" });
    expect(policy).toMatchObject({ verdict: "sensitive", passed: true });
    // #816: one that does not say which engine recorded it never counts for require-sensitive.
    expect(evaluateMutationProofPolicy({ journey: j, contentHash: journeyReviewHash(j), record: record({ verdict: LEGACY, countsForGate: true, engine: undefined }), mode: "require-sensitive" })).toMatchObject({ verdict: "sensitive", passed: false });
  });

  it("a 0.29.0 checkpoint receipt with verdict 'proven' is read as 'sensitive', and its mac still matches", () => {
    const keyFile = join(root, "home", "verify-checkpoint.key");
    mkdirSync(join(root, "home"), { recursive: true });
    const keyHex = "ab".repeat(32);
    writeFileSync(keyFile, keyHex, { mode: 0o600 });
    const d = "0".repeat(64);
    const body = {
      schema: 2,
      journeyId: "save",
      journeyHash: "h",
      planDigest: d,
      bindings: { params: d, hook: d, origin: d, browser: d },
      build: { version: "0.29.0", commit: "c", builtAt: "2026-11-01T00:00:00.000Z", tree: "t" },
      total: 0,
      completed: [],
      phase: "closing",
      independence: "passed",
      currentPair: null,
      replay: 3,
      startedAt: "2026-11-09T11:00:00.000Z",
      updatedAt: "2026-11-09T11:05:00.000Z",
      state: "finished",
      verdict: LEGACY,
      reusedPairs: 0,
      taint: { restoreFailed: false, notIsolatedBy: null, isolation: null },
      verifier: { pid: 1, startToken: "s", host: hostname() },
    };
    const mac = createHmac("sha256", Buffer.from(keyHex, "hex")).update("jevitate-verify-checkpoint/1\0file\0").update(canonicalJson(body)).digest("hex");
    const path = join(root, "progress.json");
    writeFileSync(path, JSON.stringify({ body, mac }));
    const status = readVerifyProgress(path, keyFile, "save");
    expect(status.receipt).toBe("valid");
    expect(status.progress?.verdict).toBe("sensitive");
    expect(verifyProgressLine(status)).toContain("finished sensitive");
    expect(verifyProgressLine(status)).not.toContain(LEGACY);
  });
});

describe("the report words", () => {
  it("verdictLegacy is 'proven' for sensitive and equal otherwise", () => {
    expect(proofVerdictFields("sensitive")).toEqual({ verdict: "sensitive", verdictLegacy: LEGACY });
    expect(proofVerdictFields("insensitive")).toEqual({ verdict: "insensitive", verdictLegacy: "insensitive" });
    expect(proofVerdictFields("inconclusive")).toEqual({ verdict: "inconclusive", verdictLegacy: "inconclusive" });
  });

  it("exit codes are unchanged: 0 sensitive, 1 insensitive, 2 inconclusive", () => {
    expect([verifyExitCode("sensitive"), verifyExitCode("insensitive"), verifyExitCode("inconclusive")]).toEqual([0, 1, 2]);
  });

  it("a stored legacy word reads as sensitive; every other word as written", () => {
    expect(readProofVerdict(LEGACY)).toBe("sensitive");
    expect(readProofVerdict("insensitive")).toBe("insensitive");
    expect(readProofVerdict("not-verified")).toBe("not-verified");
  });
});
