import { describe, it, expect } from "vitest";
import type { RecordedStep } from "@jevitate/recording";
import { RecordingSchema } from "@jevitate/recording";
import {
  journeyAssertions,
  relaxedMutationReplay,
  classifyMutation,
  judgeAssertions,
  mutationProofVerdict,
  assertionSiteKey,
  type Journey,
  type MutationRunResult,
} from "./index.js";

// #567 — a relaxed mutated step must stay schema-valid: `expect` is REQUIRED by the Recording schema
// for fill/click/etc, so instead of deleting it the relaxed step gets a weak postcondition that does
// not depend on the mutated value — `visible` on the step's own target, or the no-claim
// `urlIncludes ""` when the step kind has no target.

const meta = { id: "issue567", name: "Issue 567", promoted: false, params: ["text"], createdAtIso: "2026-10-07T00:00:00Z" };
const fillValueEquals = { kind: "valueEquals" as const, target: { label: "Text" }, value: "hello" };
const endStateValueEquals = { kind: "valueEquals" as const, target: { label: "Text" }, value: "hello" };
const saveWrite = { verdict: "relevant-change" as const, why: "saved", changes: ["status"], requests: ["POST /api/save → 200"], overheadMs: 1 };

/** #567: navigate, fill({var}) with a literal valueEquals expect, click Save, matching end-state valueEquals. */
function issueJourney(): Journey {
  const steps: RecordedStep[] = [
    { step: { kind: "navigate", url: "/editor", expect: { kind: "visible", target: { role: "heading", name: "Editor" } } } },
    { step: { kind: "fill", target: { label: "Text" }, value: { var: "text" }, expect: fillValueEquals } },
    { step: { kind: "click", target: { role: "button", name: "Save" }, expect: { kind: "visible", target: { role: "button", name: "Save" } } }, delta: saveWrite },
  ];
  return { metadata: { ...meta, endState: [{ kind: "reloadThen", assertion: endStateValueEquals }] }, recording: { version: "1", site: "http://localhost:3000", pages: [{ url: "/editor", steps }] } };
}

const staleFill = { kind: "stale-value" as const, step: 2, id: "stale-value:2" };
const blockClick = { kind: "block-write" as const, step: 3, id: "block-write:3" };

describe("#567 relaxed replay keeps the mutated step schema-valid", () => {
  it("a stale-value relaxed replay of a fill passes Recording schema validation", () => {
    const relaxed = relaxedMutationReplay(issueJourney(), staleFill);
    expect(() => RecordingSchema.parse(relaxed.journey.recording)).not.toThrow();
  });

  it("a stale-value relaxed fill's expect is visible on the step's own target", () => {
    const relaxed = relaxedMutationReplay(issueJourney(), staleFill);
    expect(relaxed.journey.recording.pages[0]!.steps[1]!.step).toMatchObject({ expect: { kind: "visible", target: { label: "Text" } } });
  });

  it("a block-write relaxed replay of a click passes Recording schema validation", () => {
    const relaxed = relaxedMutationReplay(issueJourney(), blockClick);
    expect(() => RecordingSchema.parse(relaxed.journey.recording)).not.toThrow();
  });

  it("a block-write relaxed replay of a target-less navigate uses the no-claim urlIncludes fallback", () => {
    const relaxed = relaxedMutationReplay(issueJourney(), { kind: "block-write", step: 1, id: "block-write:1" });
    expect(relaxed.journey.recording.pages[0]!.steps[0]!.step).toMatchObject({ expect: { kind: "urlIncludes", text: "" } });
  });

  it("the input Journey is not modified by a relaxed replay", () => {
    const journey = issueJourney();
    relaxedMutationReplay(journey, staleFill);
    expect(journey.recording.pages[0]!.steps[1]!.step).toMatchObject({ expect: fillValueEquals });
  });
});

describe("#567 the issue shape is judged on the relaxed replay", () => {
  const ownPost = { where: "step" as const, step: 2, postcondition: true };
  const relaxedFailsAtEndState: MutationRunResult = { outcome: "failed", failedSites: [ownPost], relaxed: { outcome: "failed", failedSites: [{ where: "end-state", index: 0 }] } };

  it("the end-state valueEquals is sensitive when the relaxed replay failed at that site", () => {
    const site = journeyAssertions(issueJourney()).find((s) => assertionSiteKey(s) === "end-state:0")!;
    expect(classifyMutation(site, staleFill, relaxedFailsAtEndState)).toBe("sensitive");
  });

  it("the issue shape's proof verdict is proven", () => {
    const assertions = judgeAssertions(issueJourney(), { mutations: [staleFill], pairs: [{ site: "end-state:0", mutation: staleFill.id }] }, new Map([[staleFill.id, relaxedFailsAtEndState]]));
    expect(mutationProofVerdict({ basePassed: true, mutations: [relaxedFailsAtEndState], assertions }).verdict).toBe("proven");
  });
});
