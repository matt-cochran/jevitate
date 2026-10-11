import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { JourneySchema, type Journey } from "@jevitate/journey";
import { buildJourneyReview, renderReviewText } from "../journey-review.js";

/**
 * #499 characterization test: splitting `renderSheet` into per-section renderers must not change a
 * single byte of the sheet. The golden file was generated from the unmodified code before the split.
 */
const crm = (): Journey => JourneySchema.parse(JSON.parse(readFileSync(new URL("../../test-fixtures/journeys/crm-contacts-import-happy.json", import.meta.url), "utf8")));
const golden = readFileSync(new URL("./render.golden.txt", import.meta.url), "utf8");

describe("#499 renderSheet split", () => {
  it("renders the crm fixture byte-for-byte as the committed golden", () => {
    const review = buildJourneyReview(crm(), { approvedSnapshot: crm() });
    expect(renderReviewText(review, { width: 100 })).toBe(golden);
  });
});
