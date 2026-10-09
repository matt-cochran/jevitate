import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FakeClock, installClock, resetClock } from "@jevitate/domain";
import { FsJourneyStore, type Journey } from "@jevitate/journey";
import type { Step } from "@jevitate/recording";
import { draftOnStored, promoteJourney } from "./journey-api.js";
import { JourneyProposalProofError } from "./journey-proposal-store.js";
import { journeyReviewHash } from "./journey-review.js";

/** #467: promote mints a stable id for every step lacking one, and binds its approval to the ids it stores. */

const ASSERT: Step = { kind: "assert", check: { kind: "textIncludes", target: { testId: "ok" }, text: "OK" } };
const CLICK: Step = { kind: "click", target: { testId: "go" }, expect: { kind: "textIncludes", target: { testId: "ok" }, text: "OK" } };

const legacy = (stepIds: (string | undefined)[] = [undefined, undefined]): Journey => ({
  metadata: { id: "draft", name: "draft", promoted: false, params: [], createdAtIso: "2026-10-09T00:00:00Z" },
  recording: {
    version: "1",
    site: "https://example.test",
    pages: [{ url: "/", steps: [CLICK, ASSERT].map((step, i) => (stepIds[i] === undefined ? { step } : { step, stepId: stepIds[i] })) }],
  },
});
const ids = (j: Journey | null): (string | undefined)[] => (j?.recording.pages ?? []).flatMap((p) => p.steps.map((s) => s.stepId));

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "jev-467-promote-"));
  installClock(new FakeClock({ startMs: Date.parse("2026-10-09T10:00:00.000Z") }));
});
afterEach(() => resetClock());

/** A Journey file written before step ids existed (bypassing the store, which would mint). */
const seedLegacy = async (j: Journey = legacy()): Promise<void> => writeFile(join(dir, "draft.json"), JSON.stringify(j));

describe("#467 promoteJourney step ids", () => {
  it("mints an id for every step that lacks one", async () => {
    await seedLegacy();
    expect(ids(await promoteJourney(dir, "draft", { catalogDir: null })).every((id) => id !== undefined)).toBe(true);
  });

  it("binds the approval to the stored Journey, ids included", async () => {
    await seedLegacy();
    await promoteJourney(dir, "draft", { catalogDir: null });
    const stored = (await new FsJourneyStore(dir).get("draft"))!;
    expect(stored.metadata.approval?.contentHash).toBe(journeyReviewHash(stored));
  });

  it("accepts a review of the Journey before its ids were minted", async () => {
    await seedLegacy();
    const reviewedHash = journeyReviewHash((await new FsJourneyStore(dir).get("draft"))!);
    expect((await promoteJourney(dir, "draft", { catalogDir: null, reviewedHash })).metadata.promoted).toBe(true);
  });

  it("keeps the ids a Journey already has", async () => {
    await seedLegacy(legacy(["s-click1", "s-assrt1"]));
    expect(ids(await promoteJourney(dir, "draft", { catalogDir: null }))).toEqual(["s-click1", "s-assrt1"]);
  });
});

describe("#467 draftOnStored", () => {
  const env = { name: "staging", baseUrl: "https://staging.example.test" } as Parameters<typeof draftOnStored>[2];
  const draftNaming = (stepId: string) => {
    const stored = legacy(["s-click1", "s-assrt1"]);
    return draftOnStored(stored, { recording: stored.recording, steps: [{ index: 0, stepId, before: CLICK, after: CLICK, attempt: 1, hypothesis: "h", evidence: [] }] }, env);
  };

  it("keeps the healed step's id on the stored Journey's revision", () => {
    expect(draftNaming("s-click1").recording.pages[0]!.steps[0]!.stepId).toBe("s-click1");
  });

  it("refuses a change whose step id is not the stored step's at that index", () => {
    expect(() => draftNaming("s-assrt1")).toThrow(JourneyProposalProofError);
  });
});
