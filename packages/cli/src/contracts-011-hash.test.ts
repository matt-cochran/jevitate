import { describe, expect, it } from "vitest";
import { JourneySchema } from "@jevitate/journey";
import { journeyReviewHash } from "./journey-review.js";

/**
 * #486: `responseTimeoutMs` on a step is optional, so a Journey that does not set it parses to the
 * same value and keeps its review hash (the pinned digest was computed before the field existed).
 */
const journeyWithRequestCheck = {
  metadata: { id: "save", name: "Save", promoted: true, params: [], createdAtIso: "2026-10-01T00:00:00.000Z" },
  recording: {
    version: "1",
    site: "http://127.0.0.1:1",
    pages: [
      {
        url: "/form",
        steps: [
          {
            step: { kind: "click", target: { testId: "save" }, expect: { kind: "visible", target: { testId: "saved" } } },
            expectRequests: [{ kind: "responseStatus", method: "POST", pathGlob: "/api/save", status: { class: 2 } }],
          },
        ],
      },
    ],
  },
};

describe("0.11 contracts: legacy content hashes", () => {
  it("a Journey without responseTimeoutMs keeps its review hash", () => {
    expect(journeyReviewHash(JourneySchema.parse(journeyWithRequestCheck))).toBe("588d0183f84974276034f350e68c78368e035c327b40385e47b2eafbccf2648f");
  });
});
