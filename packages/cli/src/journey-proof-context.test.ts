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
