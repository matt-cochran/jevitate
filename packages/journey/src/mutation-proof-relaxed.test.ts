import { describe, it, expect } from "vitest";
import type { RecordedStep, Step } from "@jevitate/recording";
import { RecordingSchema } from "@jevitate/recording";
import {
  journeyAssertions,
  relaxedMutationReplay,
  targetedMutationReplay,
  targetedControlReplay,
  classifyMutation,
  judgeAssertions,
  mutationProofVerdict,
  assertionSiteKey,
  type Journey,
  type MutationRunResult,
} from "./index.js";

// #567 — a relaxed mutated step must stay schema-valid: `expect` is REQUIRED by the Recording schema
// for fill/click/etc, so instead of deleting it the relaxed step gets a weak postcondition that does
// makes no new assertion about the value or target survival: the explicit no-claim `urlIncludes ""`.

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
  const postcondition = { kind: "textIncludes" as const, target: { testId: "result" }, text: "Applied" };
  const actions: Step[] = [
    { kind: "fill", target: { label: "Text" }, value: { redacted: false, value: "hello" }, expect: postcondition },
    { kind: "click", target: { role: "button", name: "Apply" }, expect: postcondition },
    { kind: "select", target: { label: "Option" }, value: { redacted: false, value: "one" }, expect: postcondition },
    { kind: "upload", target: { label: "File" }, file: { redacted: false, value: "fixture.txt" }, expect: postcondition },
    { kind: "press", key: "Enter", expect: postcondition },
    { kind: "navigate", url: "/editor", expect: postcondition },
    { kind: "reload", expect: postcondition },
  ];
  it.each(actions)("waives $kind without inventing target survival or changing the action", (action) => {
    const journey = issueJourney();
    journey.recording.pages[0]!.steps[2]!.step = { ...action, waitFor: { maxMs: 30_000 } } as Step;
    const before = structuredClone(journey);
    const relaxed = relaxedMutationReplay(journey, blockClick);
    expect(RecordingSchema.safeParse(relaxed.journey.recording).success).toBe(true);
    expect(relaxed.journey.recording.pages[0]!.steps[2]!.step).toEqual({ ...action, expect: { kind: "urlIncludes", text: "" } });
    expect(journey).toEqual(before);
  });

  it("uses identical waived DOM checks in targeted/control clones while retaining requests and the final exact oracle", () => {
    const journey = issueJourney();
    const steps = journey.recording.pages[0]!.steps;
    steps[0]!.step = { ...steps[0]!.step, waitFor: { maxMs: 4_000 } } as Step;
    steps[1]!.step = { ...steps[1]!.step, waitFor: { maxMs: 5_000 } } as Step;
    steps[2]!.step = { ...steps[2]!.step, waitFor: { maxMs: 6_000 } } as Step;
    steps[2]!.expectRequests = [
      { kind: "responseStatus", method: "POST", pathGlob: "/api/save", status: { class: 2 } },
      { kind: "requestMade", method: "GET", pathGlob: "/api/status" },
    ];
    const before = structuredClone(journey);
    for (const replay of [
      targetedMutationReplay(journey, staleFill, "end-state:0", ["step:3"], { params: { text: "hello" } }),
      targetedControlReplay(journey, staleFill, ["step:3"]),
    ]) {
      const copied = replay.journey.recording.pages[0]!.steps;
      expect(RecordingSchema.safeParse(replay.journey.recording).success).toBe(true);
      expect(copied[0]).toEqual(before.recording.pages[0]!.steps[0]);
      for (const index of [1, 2]) {
        const original = before.recording.pages[0]!.steps[index]!.step;
        const generated = copied[index]!.step;
        expect("expect" in generated && generated.expect).toEqual({ kind: "urlIncludes", text: "" });
        expect("waitFor" in generated).toBe(false);
        expect(generated.kind).toBe(original.kind);
        if ("target" in original) expect("target" in generated && generated.target).toEqual(original.target);
      }
      expect(copied[2]!.expectRequests).toEqual(steps[2]!.expectRequests);
      expect(journeyAssertions(replay.journey).filter((site) => site.where === "step-request").map(assertionSiteKey)).toEqual(["step-request:3:0", "step-request:3:1"]);
      expect(replay.relaxedStepRequests).toBeUndefined();
      expect(replay.journey.metadata.endState).toEqual(before.metadata.endState);
    }
    expect(journey).toEqual(before);
  });

  it("a stale-value relaxed replay of a fill passes Recording schema validation", () => {
    const relaxed = relaxedMutationReplay(issueJourney(), staleFill);
    expect(() => RecordingSchema.parse(relaxed.journey.recording)).not.toThrow();
  });

  it("a stale-value relaxed fill's expect makes no replacement claim", () => {
    const relaxed = relaxedMutationReplay(issueJourney(), staleFill);
    expect(relaxed.journey.recording.pages[0]!.steps[1]!.step).toMatchObject({ expect: { kind: "urlIncludes", text: "" } });
  });

  it("a block-write relaxed replay of a click passes Recording schema validation", () => {
    const relaxed = relaxedMutationReplay(issueJourney(), blockClick);
    expect(() => RecordingSchema.parse(relaxed.journey.recording)).not.toThrow();
  });

  it("a block-write relaxed replay of a target-less navigate uses the same no-claim urlIncludes", () => {
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
