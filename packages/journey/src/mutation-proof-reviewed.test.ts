import { describe, it, expect } from "vitest";
import type { RecordedStep } from "@jevitate/recording";
import { mutationReplay, planJourneyMutations, type Journey } from "./index.js";

// #579: a parameter's reviewed `mutationValues` are the swap-param's wrong value before any live
// option or generated alteration, and the plan names where the value comes from (never the value).
const heading = { kind: "visible" as const, target: { role: "heading" as const, name: "Form" } };

function journey(step: RecordedStep["step"], mutationValues?: string[]): Journey {
  return {
    metadata: {
      id: "reviewed",
      name: "Reviewed",
      promoted: false,
      params: ["who"],
      parameters: [{ name: "who", ...(mutationValues === undefined ? {} : { mutationValues }) }],
      createdAtIso: "2026-10-18T00:00:00Z",
    },
    recording: { version: "1", site: "http://127.0.0.1", pages: [{ url: "/form", steps: [{ step: { kind: "navigate", url: "/form", expect: heading } }, { step }] }] },
  };
}

const select: RecordedStep["step"] = { kind: "select", target: { label: "Who" }, value: { var: "who" }, expect: { kind: "valueEquals", target: { label: "Who" }, value: { var: "who" } } };
const fill: RecordedStep["step"] = { kind: "fill", target: { label: "Who" }, value: { var: "who" }, expect: { kind: "valueEquals", target: { label: "Who" }, value: { var: "who" } } };
const params = { who: "mcpl" };
const swapOf = (j: Journey) => planJourneyMutations(j, { params }).mutations.find((m) => m.kind === "swap-param")!;

describe("#579 reviewed mutationValues", () => {
  it("swaps a select-fed parameter to the first reviewed value that differs from the supplied one", () => {
    const j = journey(select, ["mcpl", "personal"]);
    expect(mutationReplay(j, swapOf(j), { params }).params).toEqual({ who: "personal" });
  });

  it("does not pick a live option when a reviewed value exists", () => {
    const j = journey(select, ["personal"]);
    expect(mutationReplay(j, swapOf(j), { params }).swapSelectAtStep).toBeUndefined();
  });

  it("swaps a fill-fed parameter to its reviewed value", () => {
    const j = journey(fill, ["personal"]);
    expect(mutationReplay(j, swapOf(j), { params }).params).toEqual({ who: "personal" });
  });

  it("keeps assertions expecting the supplied value", () => {
    const j = journey(fill, ["personal"]);
    const replayed = mutationReplay(j, swapOf(j), { params }).journey.recording.pages[0]!.steps[1]!.step;
    expect(replayed.kind === "fill" && replayed.expect).toEqual({ kind: "valueEquals", target: { label: "Who" }, value: "mcpl" });
  });

  it("falls back to a live option when every reviewed value equals the supplied one", () => {
    const j = journey(select, ["mcpl"]);
    expect(mutationReplay(j, swapOf(j), { params }).swapSelectAtStep).toEqual({ index: 1, avoid: "mcpl" });
  });

  it("names a reviewed source", () => {
    expect(swapOf(journey(fill, ["personal"])).source).toBe("reviewed");
  });

  it("names an option source for a select-fed parameter without reviewed values", () => {
    expect(swapOf(journey(select)).source).toBe("option");
  });

  it("names a generated source for a fill-fed parameter without reviewed values", () => {
    expect(swapOf(journey(fill)).source).toBe("generated");
  });
});
