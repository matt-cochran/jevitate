import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FakeClock, installClock, resetClock } from "@jevitate/domain";
import { FsJourneyStore, type Journey } from "@jevitate/journey";
import type { Step } from "@jevitate/recording";
import { lintJourneyById, promoteJourney } from "./journey-api.js";
import { AnchorRulesError, isStepIdOnlyChange } from "./journey-anchor-gate.js";
import { journeyReviewHash } from "./journey-review.js";
import { renderJourneyLintSarif } from "./journey-lint-sarif.js";

/** #466: promote enforces the anchor rules on new or changed content; an unchanged or step-id-only re-approval warns. */

const CLICK: Step = { kind: "click", target: { testId: "go" }, expect: { kind: "textIncludes", target: { testId: "ok" }, text: "OK" } };
const ASSERT: Step = { kind: "assert", check: { kind: "textIncludes", target: { testId: "ok" }, text: "OK" } };

function journey(metadata: Partial<Journey["metadata"]> = {}, ids: (string | undefined)[] = [undefined, undefined]): Journey {
  return {
    metadata: { id: "draft", name: "draft", promoted: false, params: [], createdAtIso: "2026-10-09T00:00:00Z", ...metadata },
    recording: {
      version: "1",
      site: "https://example.test",
      pages: [{ url: "/", steps: [CLICK, ASSERT].map((step, i) => (ids[i] === undefined ? { step } : { step, stepId: ids[i] })) }],
    },
  };
}

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "jev-466-"));
  installClock(new FakeClock({ startMs: Date.parse("2026-10-09T10:00:00.000Z") }));
});
afterEach(() => resetClock());

/** Written past the store, so it lands as given (no minting). */
const seed = async (j: Journey): Promise<void> => writeFile(join(dir, "draft.json"), JSON.stringify(j));
const promote = (opts: Parameters<typeof promoteJourney>[2] = {}) => promoteJourney(dir, "draft", { catalogDir: null, ...opts });
const stored = async (): Promise<Journey> => (await new FsJourneyStore(dir).get("draft"))!;

/** A Journey approved under its hash as written (the pre-0.10 approval of a non-compliant Journey). */
async function seedApproved(j: Journey): Promise<void> {
  await seed({ ...j, metadata: { ...j.metadata, promoted: true, approval: { contentHash: journeyReviewHash(j), at: "2026-10-01T00:00:00.000Z" } } });
}

describe("#466 promote: new Journeys must follow the anchor rules", () => {
  it("refuses a new Journey with a mixed-case anchor name", async () => {
    await seed(journey({ anchors: [{ name: "Review", step: 1 }] }));
    await expect(promote()).rejects.toBeInstanceOf(AnchorRulesError);
  });

  it("names the fix in the refusal", async () => {
    await seed(journey({ anchors: [{ name: "Review", step: 1 }] }));
    await expect(promote()).rejects.toThrow(/fix: rename it to 'review'/);
  });

  it("refuses with the anchor-rules code", async () => {
    await seed(journey({ anchors: [{ name: "Review", step: 1 }] }));
    await expect(promote()).rejects.toMatchObject({ code: "E_JOURNEY_ANCHOR_RULES" });
  });

  it("promotes a new Journey whose anchors comply", async () => {
    await seed(journey({ anchors: [{ name: "review", step: 1 }] }));
    expect((await promote()).metadata.promoted).toBe(true);
  });

  it("stamps the stepId of the step each anchor follows, keeping step", async () => {
    await seed(journey({ anchors: [{ name: "review", step: 2 }] }, ["s-click1", "s-assrt1"]));
    await promote();
    expect((await stored()).metadata.anchors?.[0]).toEqual({ name: "review", step: 2, stepId: "s-assrt1" });
  });

  it("binds the approval to the stamped anchors", async () => {
    await seed(journey({ anchors: [{ name: "review", step: 2 }] }, ["s-click1", "s-assrt1"]));
    await promote();
    const j = await stored();
    expect(j.metadata.approval?.contentHash).toBe(journeyReviewHash(j));
  });

  it("accepts a review of the Journey before ids were minted and anchors stamped", async () => {
    const j = journey({ anchors: [{ name: "review", step: 2 }] });
    await seed(j);
    expect((await promote({ reviewedHash: journeyReviewHash(j) })).metadata.promoted).toBe(true);
  });
});

describe("#466 promote: existing approved Journeys warn", () => {
  it("re-approves an unchanged non-compliant Journey", async () => {
    await seedApproved(journey({ anchors: [{ name: "Review", step: 1 }] }, ["s-click1", "s-assrt1"]));
    expect((await promote()).metadata.promoted).toBe(true);
  });

  it("re-approves a Journey whose only change is the #467 step-id backfill", async () => {
    await seedApproved(journey({ anchors: [{ name: "Review", step: 1 }] }));
    expect((await promote()).metadata.promoted).toBe(true);
  });

  it("refuses a re-promotion whose content changed beyond step ids", async () => {
    const approved = journey({ anchors: [{ name: "Review", step: 1 }] });
    await seed({ ...approved, metadata: { ...approved.metadata, name: "renamed", promoted: true, approval: { contentHash: journeyReviewHash(approved), at: "2026-10-01T00:00:00.000Z" } } });
    await expect(promote()).rejects.toBeInstanceOf(AnchorRulesError);
  });
});

describe("#466 isStepIdOnlyChange", () => {
  it("is true against the hash of the Journey before ids", () => {
    expect(isStepIdOnlyChange(journeyReviewHash(journey()), journey({}, ["s-a", "s-b"]))).toBe(true);
  });

  it("is true against a snapshot that differs only by anchor and step ids", () => {
    expect(isStepIdOnlyChange(journey({ anchors: [{ name: "r", step: 1 }] }), journey({ anchors: [{ name: "r", step: 1, stepId: "s-a" }] }, ["s-a", "s-b"]))).toBe(true);
  });

  it("is false when anything else changed", () => {
    expect(isStepIdOnlyChange(journey(), journey({ name: "other" }, ["s-a", "s-b"]))).toBe(false);
  });
});

describe("#466 journey lint", () => {
  it("reports the anchor rules as warnings with the fix", async () => {
    await seed(journey({ anchors: [{ name: "Review", step: 1 }] }));
    const result = await lintJourneyById(dir, "draft", { catalogDir: null });
    expect(result.findings.find((f) => f.rule === "anchor-name")).toMatchObject({ level: "warning", fix: expect.stringContaining("'review'") });
  });

  it("puts the fix in the SARIF result", async () => {
    await seed(journey({ anchors: [{ name: "Review", step: 1 }] }));
    const result = await lintJourneyById(dir, "draft", { catalogDir: null });
    const sarif = renderJourneyLintSarif({ id: "draft", findings: result.findings, version: "0" }) as unknown as { runs: [{ results: { ruleId: string; message: { text: string } }[] }] };
    expect(sarif.runs[0].results.find((r) => r.ruleId === "anchor-name")?.message.text).toContain("fix: rename it to 'review'");
  });
});
