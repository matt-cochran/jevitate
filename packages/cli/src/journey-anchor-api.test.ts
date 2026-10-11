import { beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FsJourneyStore, type Journey } from "@jevitate/journey";
import type { Step } from "@jevitate/recording";
import { UnknownJourneyError } from "./journey-api.js";
import { AnchorEditError, PromotedJourneyEditError, addJourneyAnchor, fixJourneyAnchors, removeJourneyAnchor, suggestJourneyAnchors } from "./journey-anchor-api.js";

/** #487: adding/removing anchors and `lint --fix` write the step id at once and refuse to touch a promoted Journey. */

const CLICK: Step = { kind: "click", target: { testId: "go" }, expect: { kind: "textIncludes", target: { testId: "ok" }, text: "OK" } };
const ASSERT: Step = { kind: "assert", check: { kind: "textIncludes", target: { testId: "ok" }, text: "OK" } };

function journey(metadata: Partial<Journey["metadata"]> = {}): Journey {
  return {
    metadata: { id: "draft", name: "draft", promoted: false, params: [], createdAtIso: "2026-10-09T00:00:00Z", ...metadata },
    recording: { version: "1", site: "https://example.test", pages: [{ url: "/", steps: [{ step: CLICK, stepId: "s-click1" }, { step: ASSERT, stepId: "s-assrt1" }] }] },
  };
}

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "jev-487-"));
});
const seed = (j: Journey): Promise<void> => writeFile(join(dir, "draft.json"), JSON.stringify(j));
const stored = async (): Promise<Journey> => (await new FsJourneyStore(dir).get("draft"))!;

describe("addJourneyAnchor", () => {
  it("persists the anchor with its step id", async () => {
    await seed(journey());
    await addJourneyAnchor(dir, "draft", { name: "review", step: "2" });
    expect((await stored()).metadata.anchors?.[0]).toEqual({ name: "review", step: 2, stepId: "s-assrt1" });
  });

  it("reports no anchor issue for the anchor it wrote", async () => {
    await seed(journey());
    expect((await addJourneyAnchor(dir, "draft", { name: "review", step: "2" })).issues).toEqual([]);
  });

  it("reports the issues of an anchor already there", async () => {
    await seed(journey({ anchors: [{ name: "old", step: 1 }] }));
    expect((await addJourneyAnchor(dir, "draft", { name: "review", step: "2" })).issues.map((i) => i.code)).toEqual(["anchor-unstamped"]);
  });

  it("refuses a duplicate name", async () => {
    await seed(journey({ anchors: [{ name: "review", step: 1, stepId: "s-click1" }] }));
    await expect(addJourneyAnchor(dir, "draft", { name: "review", step: "2" })).rejects.toBeInstanceOf(AnchorEditError);
  });

  it("refuses an unknown Journey", async () => {
    await expect(addJourneyAnchor(dir, "nope", { name: "review", step: "2" })).rejects.toBeInstanceOf(UnknownJourneyError);
  });

  it("refuses a promoted Journey", async () => {
    await seed(journey({ promoted: true }));
    await expect(addJourneyAnchor(dir, "draft", { name: "review", step: "2" })).rejects.toBeInstanceOf(PromotedJourneyEditError);
  });

  it("leaves a promoted Journey's anchors untouched", async () => {
    await seed(journey({ promoted: true }));
    await addJourneyAnchor(dir, "draft", { name: "review", step: "2" }).catch(() => undefined);
    expect((await stored()).metadata.anchors).toBeUndefined();
  });

  it("tells the reader to re-promote", async () => {
    await seed(journey({ promoted: true }));
    await expect(addJourneyAnchor(dir, "draft", { name: "review", step: "2" })).rejects.toThrow(/journey promote draft/);
  });
});

describe("removeJourneyAnchor", () => {
  it("persists the removal", async () => {
    await seed(journey({ anchors: [{ name: "review", step: 1, stepId: "s-click1" }] }));
    await removeJourneyAnchor(dir, "draft", "review");
    expect((await stored()).metadata.anchors).toBeUndefined();
  });

  it("refuses an unknown anchor", async () => {
    await seed(journey());
    await expect(removeJourneyAnchor(dir, "draft", "review")).rejects.toBeInstanceOf(AnchorEditError);
  });
});

describe("fixJourneyAnchors", () => {
  it("stamps a number-only anchor and persists it", async () => {
    await seed(journey({ anchors: [{ name: "review", step: 2 }] }));
    await fixJourneyAnchors(dir, "draft");
    expect((await stored()).metadata.anchors?.[0]?.stepId).toBe("s-assrt1");
  });

  it("reports what it stamped", async () => {
    await seed(journey({ anchors: [{ name: "review", step: 2 }] }));
    expect((await fixJourneyAnchors(dir, "draft")).stamped).toEqual([{ name: "review", step: 2, stepId: "s-assrt1" }]);
  });

  it("leaves no anchor issue after stamping", async () => {
    await seed(journey({ anchors: [{ name: "review", step: 2 }] }));
    expect((await fixJourneyAnchors(dir, "draft")).issues).toEqual([]);
  });

  it("refuses to stamp a promoted Journey", async () => {
    await seed(journey({ promoted: true, anchors: [{ name: "review", step: 2 }] }));
    await expect(fixJourneyAnchors(dir, "draft")).rejects.toBeInstanceOf(PromotedJourneyEditError);
  });

  it("does nothing to a promoted Journey that needs no stamping", async () => {
    await seed(journey({ promoted: true, anchors: [{ name: "review", step: 2, stepId: "s-assrt1" }] }));
    expect((await fixJourneyAnchors(dir, "draft")).stamped).toEqual([]);
  });
});

describe("suggestJourneyAnchors", () => {
  const writing = (): Journey => {
    const j = journey();
    j.recording.pages[0]!.steps[0] = { step: CLICK, stepId: "s-click1", delta: { verdict: "relevant-change", why: "w", changes: [], requests: ["POST /api/orders \u2192 201"], overheadMs: 1 } };
    return j;
  };

  it("proposes the accepting command for a recorded write", async () => {
    await seed(writing());
    expect((await suggestJourneyAnchors(dir, "draft")).suggestions[0]?.command).toMatch(/^jevitate journey anchor add draft --name orders-written --step s-click1 /);
  });

  it("writes nothing to the stored Journey", async () => {
    await seed(writing());
    const before = await stored();
    await suggestJourneyAnchors(dir, "draft");
    expect(await stored()).toEqual(before);
  });

  it("refuses an unknown Journey", async () => {
    await expect(suggestJourneyAnchors(dir, "nope")).rejects.toBeInstanceOf(UnknownJourneyError);
  });
});
