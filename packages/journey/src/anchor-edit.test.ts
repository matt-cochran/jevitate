import { describe, expect, it } from "vitest";
import { AnchorEditError, JourneySchema, addAnchor, anchorLintIssues, removeAnchor, resolveAnchorStep, stampUnstampedAnchors, type Journey } from "./index.js";

/** #487: editing anchors writes the step id at once; lint --fix stamps number-only anchors. */

function draft(anchors?: Journey["metadata"]["anchors"]): Journey {
  return JourneySchema.parse({
    metadata: { id: "order", name: "Order", promoted: false, params: [], createdAtIso: "2026-10-01T00:00:00.000Z", ...(anchors === undefined ? {} : { anchors }) },
    recording: {
      version: "1",
      site: "http://127.0.0.1:1",
      pages: [
        {
          url: "/a",
          steps: [
            { stepId: "s-one", step: { kind: "navigate", url: "/a", expect: { kind: "urlIncludes", text: "/a" } } },
            { stepId: "s-two", step: { kind: "click", target: { role: "button", name: "Next" }, expect: { kind: "urlIncludes", text: "/b" } } },
          ],
        },
      ],
    },
  });
}

describe("addAnchor", () => {
  it("writes the step id when the step is given by number", () => {
    expect(addAnchor(draft(), { name: "cart", step: 2 }).metadata.anchors?.[0]?.stepId).toBe("s-two");
  });

  it("fills the step number when the step is given by id", () => {
    expect(addAnchor(draft(), { name: "cart", step: "s-two" }).metadata.anchors?.[0]?.step).toBe(2);
  });

  it("leaves no anchor lint issue behind", () => {
    expect(anchorLintIssues(addAnchor(draft(), { name: "cart", step: 1 }))).toEqual([]);
  });

  it("keeps the description and probes", () => {
    expect(addAnchor(draft(), { name: "cart", step: 1, description: "  cart open ", probes: ["double submit", " "] }).metadata.anchors).toEqual([
      { name: "cart", step: 1, stepId: "s-one", description: "cart open", probes: ["double submit"] },
    ]);
  });

  it("writes the region when one is given", () => {
    expect(addAnchor(draft(), { name: "cart", step: 1, region: "testId=import-view" }).metadata.anchors?.[0]?.region).toBe("testId=import-view");
  });

  it("leaves the region key off the anchor when none is given", () => {
    expect(Object.prototype.hasOwnProperty.call(addAnchor(draft(), { name: "cart", step: 1 }).metadata.anchors?.[0], "region")).toBe(false);
  });

  it("refuses a name outside the anchor name rule", () => {
    expect(() => addAnchor(draft(), { name: "Cart Open", step: 1 })).toThrow(/cart-open/);
  });

  it("refuses a duplicate name", () => {
    expect(() => addAnchor(draft([{ name: "cart", step: 1 }]), { name: "cart", step: 2 })).toThrow(/already has an anchor named 'cart'/);
  });

  it("refuses a step number past the last step", () => {
    expect(() => addAnchor(draft(), { name: "cart", step: 3 })).toThrow(/steps 1\.\.2/);
  });

  it("refuses an unknown step id", () => {
    expect(() => addAnchor(draft(), { name: "cart", step: "nope" })).toThrow(AnchorEditError);
  });

  it("refuses an all-digit name", () => {
    expect(() => addAnchor(draft(), { name: "12", step: 1 })).toThrow(/all digits/);
  });
});

describe("resolveAnchorStep", () => {
  it("resolves a step id to its number", () => {
    expect(resolveAnchorStep(draft(), "s-one")).toEqual({ step: 1, stepId: "s-one" });
  });
});

describe("removeAnchor", () => {
  it("drops the named anchor", () => {
    expect(removeAnchor(draft([{ name: "a", step: 1 }, { name: "b", step: 2 }]), "a").metadata.anchors?.map((a) => a.name)).toEqual(["b"]);
  });

  it("drops the anchors list when the last one goes", () => {
    expect(removeAnchor(draft([{ name: "a", step: 1 }]), "a").metadata.anchors).toBeUndefined();
  });

  it("refuses an unknown anchor naming the existing ones", () => {
    expect(() => removeAnchor(draft([{ name: "a", step: 1 }]), "zzz")).toThrow(/its anchors: a/);
  });
});

describe("stampUnstampedAnchors", () => {
  it("stamps an anchor that references its step by number only", () => {
    expect(stampUnstampedAnchors(draft([{ name: "a", step: 2 }])).journey.metadata.anchors?.[0]?.stepId).toBe("s-two");
  });

  it("reports each anchor it stamped", () => {
    expect(stampUnstampedAnchors(draft([{ name: "a", step: 2 }])).stamped).toEqual([{ name: "a", step: 2, stepId: "s-two" }]);
  });

  it("returns the same Journey when nothing needs stamping", () => {
    const j = draft([{ name: "a", step: 1, stepId: "s-one" }]);
    expect(stampUnstampedAnchors(j).journey).toBe(j);
  });
});
