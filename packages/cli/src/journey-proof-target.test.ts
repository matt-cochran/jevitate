import { describe, expect, it } from "vitest";
import type { Journey } from "@jevitate/journey";
import { JourneyReviewSchema } from "@jevitate/journey";
import { currentJourneyProof, journeyProofHashForContext, journeyProofStaleCause, proofTargetNow } from "./journey-proof-context.js";
import { buildJourneyReview, journeyReviewHash, type JourneyVerifyRecord } from "./journey-review.js";
import { evaluateMutationProofPolicy } from "./mutation-proof-policy.js";
import { verifyExitCode } from "./journey-verify-report.js";

/**
 * Independent check M5: a receipt is fresh only for the target origin and app version it ran on. A receipt
 * that does not name them (written before 0.30.0) reads as unknown: it shows (advisory), never counts for
 * require-sensitive.
 */
function journey(): Journey {
  return { metadata: { id: "target-bound", name: "Target bound", promoted: false, params: [], createdAtIso: "2026-11-06T00:00:00Z" }, recording: { version: "1", site: "http://localhost:3000", pages: [{ url: "/", steps: [{ step: { kind: "navigate", url: "/", expect: { kind: "urlIncludes", text: "/" } } }] }] } };
}
const engine = { version: "0.30.0", commit: "abc1234" };
function receipt(over: Partial<JourneyVerifyRecord> = {}): JourneyVerifyRecord {
  const j = journey();
  return { journeyId: j.metadata.id, contentHash: journeyReviewHash(j), proofHash: journeyProofHashForContext(j, undefined), verdict: "sensitive", countsForGate: true, engine, target: { origin: "http://localhost:3000" }, summary: {}, at: "2026-11-09T00:00:00Z", ...over };
}
const policy = (record: JourneyVerifyRecord, mode: "advisory" | "require-sensitive", now?: { origin?: string; appVersion?: string }) =>
  evaluateMutationProofPolicy({ journey: journey(), contentHash: journeyReviewHash(journey()), record, mode, ...(now === undefined ? {} : { now }) });

describe("receipt freshness binds the target origin and the app version", () => {
  it("a receipt from the same target and app version is fresh and counts for require-sensitive", () => {
    const r = receipt({ appVersion: "1.4.0" });
    expect(currentJourneyProof(journey(), r, undefined, { origin: "http://localhost:3000", appVersion: "1.4.0" })).toBe(true);
    expect(policy(r, "require-sensitive", { origin: "http://localhost:3000", appVersion: "1.4.0" })).toMatchObject({ freshness: "fresh", passed: true });
  });

  it("a receipt from another target origin is stale with cause target", () => {
    const r = receipt({ target: { origin: "https://staging.example.test" } });
    expect(currentJourneyProof(journey(), r, undefined)).toBe(false);
    expect(journeyProofStaleCause(journey(), r, undefined)).toBe("target");
    expect(policy(r, "require-sensitive")).toMatchObject({ freshness: "stale", passed: false });
    const verify = buildJourneyReview(journey(), { lastVerify: r }).proof.verify;
    expect(verify).toMatchObject({ stale: true, staleCause: "target" });
    expect(JourneyReviewSchema.safeParse(buildJourneyReview(journey(), { lastVerify: r })).success).toBe(true);
  });

  it("a receipt from another app version is stale with cause app-version", () => {
    const r = receipt({ appVersion: "1.4.0" });
    const now = { origin: "http://localhost:3000", appVersion: "1.5.0" };
    expect(currentJourneyProof(journey(), r, undefined, now)).toBe(false);
    expect(journeyProofStaleCause(journey(), r, undefined, now)).toBe("app-version");
    expect(policy(r, "require-sensitive", now)).toMatchObject({ freshness: "stale", passed: false });
    expect(buildJourneyReview(journey(), { lastVerify: r, proofTarget: now }).proof.verify).toMatchObject({ stale: true, staleCause: "app-version" });
  });

  it("an old receipt naming no target reads as unknown: shown under advisory, never counted under require-sensitive", () => {
    const { target: _t, ...old } = receipt();
    expect(policy(old, "advisory")).toMatchObject({ freshness: "fresh", passed: true });
    const strict = policy(old, "require-sensitive");
    expect(strict).toMatchObject({ freshness: "fresh", passed: false });
    expect(strict.reason).toMatch(/target/);
  });

  it("a receipt naming no app version, read where one is known, never counts under require-sensitive", () => {
    const now = { origin: "http://localhost:3000", appVersion: "1.5.0" };
    expect(policy(receipt(), "advisory", now)).toMatchObject({ passed: true });
    expect(policy(receipt(), "require-sensitive", now)).toMatchObject({ passed: false });
  });

  it("the reader's default target is the Journey's recorded site, and its app version JEVITATE_APP_VERSION when valid", () => {
    expect(proofTargetNow(journey(), {})).toEqual({ origin: "http://localhost:3000" });
    expect(proofTargetNow(journey(), { JEVITATE_APP_VERSION: "2.0.1" })).toEqual({ origin: "http://localhost:3000", appVersion: "2.0.1" });
    expect(proofTargetNow(journey(), { JEVITATE_APP_VERSION: "not a version!" })).toEqual({ origin: "http://localhost:3000" });
  });
});

describe("journey verify's exit code follows the proof policy (independent check, Low)", () => {
  it("under require-sensitive, a sensitive proof that does not count for the gate does not exit 0", () => {
    expect(verifyExitCode("sensitive", { countsForGate: false, mode: "require-sensitive" })).toBe(2);
    expect(verifyExitCode("sensitive", { countsForGate: true, mode: "require-sensitive" })).toBe(0);
  });

  it("under advisory (the default), a sensitive proof exits 0 whatever its target trust", () => {
    expect(verifyExitCode("sensitive", { countsForGate: false, mode: "advisory" })).toBe(0);
    expect(verifyExitCode("sensitive")).toBe(0);
    expect(verifyExitCode("insensitive", { countsForGate: false, mode: "require-sensitive" })).toBe(1);
    expect(verifyExitCode("inconclusive")).toBe(2);
  });
});
