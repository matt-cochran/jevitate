import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FsJourneyStore, JourneySchema, type AnnotationDraft, type Journey } from "@jevitate/journey";
import { annotationDraftPath, approveJourneyAnnotations, journeyContentHash, StaleAnnotationDraftError } from "./journey-annotate-api.js";
import { reviewJourneyById } from "./journey-review-api.js";
import { buildJourneyReview, renderReviewText } from "./journey-review.js";

/**
 * #765 — `journey review` surfaces a pending annotation draft: current (approve it) or stale
 * (re-draft it), and a no-draft sheet is byte-identical to the committed golden.
 */

const ID = "buy-pro";

function journey(overrides: Partial<Journey["metadata"]> = {}): Journey {
  return {
    metadata: { id: ID, name: "Buy the Pro plan", promoted: false, params: [], createdAtIso: "2026-10-01T00:00:00.000Z", ...overrides },
    recording: { version: "1", site: "https://shop.example.test", pages: [{ url: "/plans", steps: [] }] },
  };
}

function draft(journeyHash: string): AnnotationDraft {
  return {
    kind: "jevitate.journey-annotations.draft",
    version: 1,
    journeyId: ID,
    journeyHash,
    createdAtIso: "2026-10-04T00:00:00.000Z",
    provenance: { adapter: "human", model: "-", promptVersion: "1" },
    replay: { outcome: "completed", reachedSteps: 0, totalSteps: 0 },
    goal: "Buy the Pro plan",
    successCriteria: ["The order is confirmed"],
    steps: [],
  };
}

let dir: string;
let catalogDir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "jev-765-"));
  catalogDir = join(dir, "project");
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

async function writeDraftFile(content: string): Promise<void> {
  const path = annotationDraftPath(dir, ID);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, content);
}

async function putJourney(j: Journey): Promise<void> {
  await new FsJourneyStore(dir).put(j);
}

describe("#765 journey review surfaces a pending annotation draft", () => {
  it("reports a draft made against the unchanged Journey as current", async () => {
    const j = journey();
    await putJourney(j);
    await writeDraftFile(JSON.stringify(draft(journeyContentHash(j))));
    const { review } = await reviewJourneyById(dir, ID, { catalogDir });
    expect(review.annotationDraft).toEqual({ status: "current", path: annotationDraftPath(dir, ID), next: `jevitate journey annotate ${ID} --approve` });
  });

  it("reports a draft as stale after the Journey changed", async () => {
    const j = journey();
    await putJourney(j);
    await writeDraftFile(JSON.stringify(draft(journeyContentHash(j))));
    await putJourney({ ...j, metadata: { ...j.metadata, name: "Buy the Pro plan (renamed)" } });
    const { review } = await reviewJourneyById(dir, ID, { catalogDir });
    expect(review.annotationDraft).toEqual({ status: "stale", path: annotationDraftPath(dir, ID), next: `jevitate journey annotate ${ID}` });
  });

  it("reports an invalid draft file as stale without failing review", async () => {
    await putJourney(journey());
    await writeDraftFile("this is not a draft");
    const { review } = await reviewJourneyById(dir, ID, { catalogDir });
    expect(review.annotationDraft?.status).toBe("stale");
  });

  it("reports no draft when the sidecar does not exist", async () => {
    await putJourney(journey());
    const { review } = await reviewJourneyById(dir, ID, { catalogDir });
    expect(review.annotationDraft).toBeUndefined();
  });

  it("points the missing-goal hint at approval while a draft is current", async () => {
    const j = journey();
    await putJourney(j);
    await writeDraftFile(JSON.stringify(draft(journeyContentHash(j))));
    const { review } = await reviewJourneyById(dir, ID, { catalogDir });
    expect(renderReviewText(review)).toContain(`No goal or success criteria written → jevitate journey annotate ${ID} --approve`);
  });

  it("does not offer the approve command once the draft is stale", async () => {
    const j = journey();
    await putJourney(j);
    await writeDraftFile(JSON.stringify(draft(journeyContentHash(j))));
    await putJourney({ ...j, metadata: { ...j.metadata, name: "Buy the Pro plan (renamed)" } });
    const { review } = await reviewJourneyById(dir, ID, { catalogDir });
    expect(renderReviewText(review)).not.toContain("--approve");
  });

  it("still refuses to approve a draft made against a changed Journey", async () => {
    const j = journey();
    await putJourney(j);
    await writeDraftFile(JSON.stringify(draft(journeyContentHash(j))));
    await putJourney({ ...j, metadata: { ...j.metadata, name: "Buy the Pro plan (renamed)" } });
    await expect(approveJourneyAnnotations(dir, ID)).rejects.toBeInstanceOf(StaleAnnotationDraftError);
  });

  it("renders a Journey with no draft exactly as the committed golden", () => {
    const crm = JourneySchema.parse(JSON.parse(readFileSync(new URL("../test-fixtures/journeys/crm-contacts-import-happy.json", import.meta.url), "utf8")));
    const golden = readFileSync(new URL("./journey-review/render.golden.txt", import.meta.url), "utf8");
    expect(renderReviewText(buildJourneyReview(crm, { approvedSnapshot: crm }), { width: 100 })).toBe(golden);
  });
});
