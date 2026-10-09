import { beforeAll, describe, expect, it } from "vitest";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Journey } from "@jevitate/journey";
import type { Step } from "@jevitate/recording";
import { journeyReviewHash } from "./journey-review.js";
import { listStaleJourneys, renderStaleJourneys, type StaleJourneysResult } from "./journey-stale-api.js";

/** #467 — `journey review --stale`: promoted Journeys whose approval no longer matches. */

const CLICK: Step = { kind: "click", target: { testId: "go" }, expect: { kind: "urlIncludes", text: "/done" } };
const make = (id: string, stepId: string | undefined, promoted = true): Journey => ({
  metadata: { id, name: id, promoted, params: [], createdAtIso: "2026-10-09T00:00:00Z" },
  recording: { version: "1", site: "https://example.test", pages: [{ url: "https://example.test/", steps: [stepId === undefined ? { step: CLICK } : { step: CLICK, stepId }] }] },
});
const approved = (j: Journey, hash: string): Journey => ({ ...j, metadata: { ...j.metadata, approval: { contentHash: hash, at: "2026-10-09T00:00:00Z" } } });

let dir: string;
let result: StaleJourneysResult;
beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "jev-467-stale-"));
  const put = (j: Journey) => writeFile(join(dir, `${j.metadata.id}.json`), JSON.stringify(j));
  const legacy = make("ids-only", undefined);
  await put(approved(make("ids-only", "s-click1"), journeyReviewHash(legacy)));
  await put(approved(make("edited", "s-click1"), "c".repeat(64)));
  const fresh = make("fresh", "s-click1");
  await put(approved(fresh, journeyReviewHash(fresh)));
  await put(make("draft", "s-click1", false));
  result = await listStaleJourneys({ journeysDir: dir, catalogDir: null });
});
const byId = (id: string) => result.journeys.find((j) => j.id === id);

describe("listStaleJourneys", () => {
  it("lists a Journey changed beyond its ids", () => {
    expect(byId("edited")).toMatchObject({ stepIdOnly: false, approvedHash: "c".repeat(64) });
  });
  it("labels a Journey that only gained step ids", () => {
    expect(byId("ids-only")).toMatchObject({ stepIdOnly: true, reason: "ids added only (warn path)" });
  });
  it("leaves out a Journey whose approval still matches", () => {
    expect(byId("fresh")).toBeUndefined();
  });
  it("leaves out an unpromoted Journey", () => {
    expect(byId("draft")).toBeUndefined();
  });
  it("counts the step-id-only ones", () => {
    expect([result.total, result.stepIdOnly]).toEqual([2, 1]);
  });
  it("names the command that re-approves it, bound to the current hash", () => {
    expect(byId("edited")?.approveCommand).toBe(`jevitate journey promote edited --reviewed-hash ${byId("edited")?.contentHash}`);
  });
  it("renders the review command for a human", () => {
    expect(renderStaleJourneys(result)).toContain("review: jevitate journey review ids-only");
  });
});
