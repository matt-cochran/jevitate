import { contentHash } from "@jevitate/domain";
import { describe, expect, it } from "vitest";
import type { Journey } from "@jevitate/journey";
import { journeyProofContext, journeyProofHashForContext } from "./journey-proof-context.js";
import { buildJourneyReview, journeyReviewHash, type JourneyVerifyRecord } from "./journey-review.js";
import { evaluateMutationProofPolicy } from "./mutation-proof-policy.js";

function fixtureJourney(): Journey {
  return { metadata: { id: "proof-policy", name: "Proof policy", promoted: false, params: [], createdAtIso: "2026-11-06T00:00:00Z" }, recording: { version: "1", site: "http://localhost:3000", pages: [{ url: "/", steps: [{ step: { kind: "navigate", url: "/", expect: { kind: "urlIncludes", text: "/" } } }] }] } };
}

describe("mutation proof read-policy identity", () => {
  it("records a canonical effective read policy without credential material", () => {
    expect(journeyProofContext(undefined, undefined, ["/b", "/a", "/b"])).toEqual({ readRequests: ["/a", "/b"] });
  });

  it("does not reuse a proof after its effective read policy changes", () => {
    const journey = fixtureJourney();
    const proofContext = journeyProofContext(undefined, undefined, ["/api/orders"]);
    const record: JourneyVerifyRecord = { journeyId: journey.metadata.id, contentHash: journeyReviewHash(journey), proofHash: journeyProofHashForContext(journey, proofContext), proofContext, verdict: "proven", summary: {}, at: "2026-11-06T00:00:00Z" };
    expect(buildJourneyReview(journey, { lastVerify: record }).proof.verify).toMatchObject({ stale: true });
  });

  it("keeps a current proof fresh under the same effective read policy", () => {
    const journey = fixtureJourney();
    const proofContext = journeyProofContext(undefined, undefined, ["/api/orders"]);
    const record: JourneyVerifyRecord = { journeyId: journey.metadata.id, contentHash: journeyReviewHash(journey), proofHash: journeyProofHashForContext(journey, proofContext), proofContext, verdict: "proven", summary: {}, at: "2026-11-06T00:00:00Z" };
    expect(buildJourneyReview(journey, { lastVerify: record, safety: { readRequests: ["/api/orders"] } }).proof.verify).toMatchObject({ stale: false });
  });

  it("rejects legacy evidence without a planner-bound proof hash in the shared enforcement policy", () => {
    const journey = fixtureJourney();
    const record: JourneyVerifyRecord = { journeyId: journey.metadata.id, contentHash: journeyReviewHash(journey), verdict: "proven", summary: {}, at: "2026-11-06T00:00:00Z" };
    expect(evaluateMutationProofPolicy({ journey, contentHash: journeyReviewHash(journey), record, mode: "require-proven" })).toMatchObject({ freshness: "stale", passed: false });
  });

  it("rejects a different read policy at enforcement as well as on the review sheet", () => {
    const journey = fixtureJourney();
    const proofContext = journeyProofContext(undefined, undefined, ["/api/orders"]);
    const record: JourneyVerifyRecord = { journeyId: journey.metadata.id, contentHash: journeyReviewHash(journey), proofHash: journeyProofHashForContext(journey, proofContext), proofContext, verdict: "proven", summary: {}, at: "2026-11-06T00:00:00Z" };
    expect(evaluateMutationProofPolicy({ journey, contentHash: journeyReviewHash(journey), record, mode: "require-proven" })).toMatchObject({ freshness: "stale", passed: false });
  });
});

it("canonical policy order/duplicates stay fresh while added and removed patterns fail enforcement", () => {
  const journey = fixtureJourney();
  const proofContext = journeyProofContext(undefined, undefined, ["/b", "/a", "/b"]);
  const record: JourneyVerifyRecord = { journeyId: journey.metadata.id, contentHash: journeyReviewHash(journey), proofHash: journeyProofHashForContext(journey, proofContext), proofContext, verdict: "proven", summary: {}, at: "2026-11-06T00:00:00Z" };
  expect(buildJourneyReview(journey, { lastVerify: record, safety: { readRequests: ["/b", "/a"] } }).proof.verify).toMatchObject({ stale: false });
  for (const readRequests of [["/a"], ["/a", "/b", "/c"], ["/x", "/b"]]) {
    expect(buildJourneyReview(journey, { lastVerify: record, safety: { readRequests } }).proof.verify).toMatchObject({ stale: true });
    expect(evaluateMutationProofPolicy({ journey, contentHash: journeyReviewHash(journey), record, mode: "require-proven", readRequests })).toMatchObject({ passed: false, freshness: "stale" });
  }
});

it("empty-policy proof remains fresh only for empty policy", () => {
  const journey = fixtureJourney();
  expect(journeyProofContext(undefined, undefined, [])).toBeUndefined();
  const record: JourneyVerifyRecord = { journeyId: journey.metadata.id, contentHash: journeyReviewHash(journey), proofHash: journeyProofHashForContext(journey, undefined), verdict: "proven", summary: {}, at: "2026-11-06T00:00:00Z" };
  expect(buildJourneyReview(journey, { lastVerify: record }).proof.verify).toMatchObject({ stale: false });
  expect(buildJourneyReview(journey, { lastVerify: record, safety: { readRequests: ["/api/query"] } }).proof.verify).toMatchObject({ stale: true });
});

it("native observation version stales159 final-network receipts while preserving UI/step-only receipts", () => {
  const cases = [
    { kind: "page", old: "b1326cb75b488dab9be16e4acc5ad71efe7ba76425655c6dee971f9e7d9d6775", affected: false },
    { kind: "step", old: "d8f59ea4a154b4246b308e072a8ca950d529cb32aea54421c6bda487ed42e739", affected: false },
    { kind: "requestMade", old: "d15ef54d65fe02fba7ba6377b1b33733ec2c589b3bd842e27c160bdb99905e42", affected: true },
    { kind: "responseStatus", old: "27409d8e9d32f43a5711fece56762c12a1d590cbb5b561065d490ad7dc754c93", affected: true },
    { kind: "legacy", old: "f23b06a16762046c53f6e599f02e07a96c3feeebbe7ca838e41a76bd10dface0", affected: true },
  ] as const;
  for (const item of cases) {
    const journey = fixtureJourney();
    if (item.kind === "step") journey.recording.pages[0]!.steps[0]!.expectRequests = [{ kind: "requestMade", method: "POST", pathGlob: "/sync" }];
    if (item.kind === "requestMade") journey.metadata.endState = [{ kind: "requestMade", method: "POST", pathGlob: "/sync" }];
    if (item.kind === "responseStatus") journey.metadata.endState = [{ kind: "responseStatus", method: "POST", pathGlob: "/sync", status: { class: 2 } }];
    if (item.kind === "legacy") journey.metadata.networkChecks = [{ kind: "requestMade", method: "POST", pathGlob: "/sync" }];
    const record: JourneyVerifyRecord = { journeyId: journey.metadata.id, contentHash: journeyReviewHash(journey), proofHash: item.old, verdict: "proven", summary: {}, at: "2026-11-06T00:00:00Z" };
    expect(buildJourneyReview(journey, { lastVerify: record }).proof.verify).toMatchObject({ stale: item.affected });
    expect(evaluateMutationProofPolicy({ journey, contentHash: record.contentHash, record, mode: "require-proven" }).freshness).toBe(item.affected ? "stale" : "fresh");
    const current = { ...record, proofHash: journeyProofHashForContext(journey, undefined) };
    expect(buildJourneyReview(journey, { lastVerify: current }).proof.verify).toMatchObject({ stale: false });
    for (const readRequests of [[], ["/api/query"]]) {
      const proofContext = journeyProofContext(undefined, undefined, readRequests);
      const previous = { ...record, proofContext, proofHash: proofContext === undefined ? item.old : contentHash({ v: 1, executableHash: item.old, context: proofContext }) };
      expect(buildJourneyReview(journey, { lastVerify: previous, safety: { readRequests } }).proof.verify).toMatchObject({ stale: item.affected });
      expect(evaluateMutationProofPolicy({ journey, contentHash: record.contentHash, record: previous, mode: "require-proven", readRequests }).freshness).toBe(item.affected ? "stale" : "fresh");
      const fresh = { ...record, proofContext, proofHash: journeyProofHashForContext(journey, proofContext) };
      expect(buildJourneyReview(journey, { lastVerify: fresh, safety: { readRequests } }).proof.verify).toMatchObject({ stale: false });
      expect(evaluateMutationProofPolicy({ journey, contentHash: record.contentHash, record: fresh, mode: "require-proven", readRequests }).freshness).toBe("fresh");
      journey.metadata.endState = [{ kind: "requestMade", method: "POST", pathGlob: "/changed" }];
      expect(buildJourneyReview(journey, { lastVerify: fresh, safety: { readRequests } }).proof.verify).toMatchObject({ stale: true });
      if (item.kind === "legacy") delete journey.metadata.endState;
      else if (item.kind === "requestMade") journey.metadata.endState = [{ kind: "requestMade", method: "POST", pathGlob: "/sync" }];
      else if (item.kind === "responseStatus") journey.metadata.endState = [{ kind: "responseStatus", method: "POST", pathGlob: "/sync", status: { class: 2 } }];
      else delete journey.metadata.endState;
    }
  }
});
