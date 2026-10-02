import { describe, expect, it } from "vitest";
import {
  JourneySchema,
  JourneyStepError,
  deriveParamSchema,
  journeyBranchPoint,
  journeyPrefix,
  journeyStepCount,
  listJourneyAnchors,
  prefixLandingPath,
  resolveJourneyStep,
  type Journey,
} from "./index.js";

/** #293: anchors (schema + validation), `--at-step` resolution, the prefix cut and its landing page. */

function wizard(anchors?: Journey["metadata"]["anchors"]): Journey {
  return {
    metadata: {
      id: "order",
      name: "Place an order",
      promoted: true,
      params: ["name", "card"],
      createdAtIso: "2026-10-01T00:00:00.000Z",
      ...(anchors === undefined ? {} : { anchors }),
    },
    recording: {
      version: "1",
      site: "http://127.0.0.1:1",
      pages: [
        {
          url: "/wizard",
          steps: [
            { step: { kind: "navigate", url: "/wizard", expect: { kind: "urlIncludes", text: "/wizard" } }, objective: "Open the order wizard" },
            { step: { kind: "fill", target: { label: "Name" }, value: { var: "name" }, expect: { kind: "visible", target: { label: "Name" } } }, variableName: "name" },
            { step: { kind: "click", target: { role: "button", name: "Next" }, expect: { kind: "urlIncludes", text: "/pay" } } },
          ],
        },
        {
          url: "/pay",
          steps: [{ step: { kind: "fill", target: { label: "Card" }, value: { var: "card" }, expect: { kind: "visible", target: { label: "Card" } } }, variableName: "card" }],
        },
      ],
    },
  };
}

describe("Journey anchors (#293)", () => {
  it("are additive: a Journey with valid anchors parses, one without still does", () => {
    expect(JourneySchema.safeParse(wizard()).success).toBe(true);
    const j = wizard([{ name: "review", step: 3, description: "the order summary", probes: ["double submit", "edit the name after Next"] }]);
    expect(JourneySchema.parse(j).metadata.anchors).toEqual(j.metadata.anchors);
  });

  it("refuses a duplicate name, an all-digit name, an unknown key and a step past the end", () => {
    expect(JourneySchema.safeParse(wizard([{ name: "a", step: 1 }, { name: "a", step: 2 }])).success).toBe(false);
    expect(JourneySchema.safeParse(wizard([{ name: "3", step: 3 }])).success).toBe(false);
    expect(JourneySchema.safeParse(wizard([{ name: "a", step: 1, attack: "x" } as never])).success).toBe(false);
    expect(JourneySchema.safeParse(wizard([{ name: "a", step: 0 }])).success).toBe(false);
    const past = JourneySchema.safeParse(wizard([{ name: "late", step: 5 }]));
    expect(past.success).toBe(false);
    expect(past.error?.issues[0]?.message).toMatch(/past the Journey's last step \(4\)/);
  });

  it("are listed with the step they follow (values never shown)", () => {
    const j = wizard([{ name: "filled", step: 2, probes: ["paste 10k chars"] }, { name: "review", step: 3 }]);
    expect(listJourneyAnchors(j)).toEqual([
      { name: "filled", step: 2, afterStep: "fill field \"Name\" with <param name>", probes: ["paste 10k chars"] },
      { name: "review", step: 3, afterStep: "click button \"Next\"", probes: [] },
    ]);
  });

  it("--at-step resolves a step number or an anchor name, and refuses anything else naming the choices", () => {
    const j = wizard([{ name: "review", step: 3 }]);
    expect(resolveJourneyStep(j, "2")).toEqual({ step: 2 });
    expect(resolveJourneyStep(j, "3").anchor?.name).toBe("review");
    expect(resolveJourneyStep(j, "review")).toEqual({ step: 3, anchor: { name: "review", step: 3 } });
    expect(() => resolveJourneyStep(j, "0")).toThrow(JourneyStepError);
    expect(() => resolveJourneyStep(j, "5")).toThrow(/steps 1\.\.4 or an anchor: review/);
    expect(() => resolveJourneyStep(j, "nope")).toThrow(/names no anchor/);
    expect(() => resolveJourneyStep(wizard(), "nope")).toThrow(/declares no anchors/);
  });

  it("records the branch point by journey, step and anchor", () => {
    const j = wizard([{ name: "review", step: 3 }]);
    expect(journeyBranchPoint(j, resolveJourneyStep(j, "review"))).toEqual({ journeyId: "order", step: 3, anchor: "review", stepLabel: "click button \"Next\"" });
    expect(journeyBranchPoint(j, resolveJourneyStep(j, "1"))).toEqual({ journeyId: "order", step: 1, stepLabel: "Open the order wizard" });
  });

  it("cuts the prefix: only the steps up to the anchor, and only the params those need", () => {
    const j = wizard();
    expect(journeyStepCount(j)).toBe(4);
    const p = journeyPrefix(j, 3);
    expect(p.recording.pages.map((s) => [s.url, s.steps.length])).toEqual([["/wizard", 3]]);
    expect(deriveParamSchema(p.recording).required).toEqual(["name"]);
    expect(journeyPrefix(j, 4).recording.pages).toHaveLength(2);
    expect(() => journeyPrefix(j, 0)).toThrow(JourneyStepError);
  });

  it("predicts where the prefix lands from the Recording alone", () => {
    const j = wizard();
    expect(prefixLandingPath(j, 2)).toBe("/wizard");
    expect(prefixLandingPath(j, 3)).toBe("/pay"); // the segment's last step opened the next one
    expect(prefixLandingPath(j, 4)).toBe("/pay");
  });
});
