import { describe, expect, it } from "vitest";
import { JobSchema, JourneySchema } from "@jevitate/journey";
import { jobContentHash } from "./catalog.js";
import { journeyReviewHash } from "./journey-review.js";

/**
 * 0.10 shared contracts (#465 #466 #467 #468 #469): every new field is optional, so a legacy
 * Journey or job that uses none of them parses to the same value and keeps its content hash
 * (the pinned digests below were computed before the fields existed).
 */

const legacyJourney = {
  metadata: {
    id: "order",
    name: "Place an order",
    promoted: true,
    params: ["name"],
    createdAtIso: "2026-10-01T00:00:00.000Z",
    job: "place-order",
    persona: "buyer",
    anchors: [{ name: "filled", step: 2, description: "the form is filled", probes: ["double submit"] }],
  },
  recording: {
    version: "1",
    site: "http://127.0.0.1:1",
    pages: [
      {
        url: "/wizard",
        steps: [
          { step: { kind: "navigate", url: "/wizard", expect: { kind: "urlIncludes", text: "/wizard" } } },
          {
            step: { kind: "fill", target: { testId: "name" }, value: { var: "name" }, expect: { kind: "visible", target: { testId: "name" } } },
            variableName: "name",
          },
        ],
      },
    ],
  },
};

const legacyJob = {
  id: "place-order",
  trigger: "I have picked what I want",
  motivation: "pay for it",
  outcome: "get it delivered",
  personas: ["buyer"],
  priority: "high",
};

describe("0.10 contracts: legacy content hashes", () => {
  it("a legacy Journey keeps its review hash after parsing", () => {
    expect(journeyReviewHash(JourneySchema.parse(legacyJourney))).toBe(LEGACY_JOURNEY_HASH);
  });

  it("a legacy job keeps its content hash after parsing", () => {
    expect(jobContentHash(JobSchema.parse(legacyJob))).toBe(LEGACY_JOB_HASH);
  });
});

const LEGACY_JOURNEY_HASH = "7da4f88efb1451abff374a620a11d064b50986cad2aa11b91a417fd9cafbe253";
const LEGACY_JOB_HASH = "ed9e7cef1ae21e910230d77ca9fda9aa362583b82814022f89b98806ae32784b";
