import { describe, expect, it } from "vitest";
import type { RecordedStep, Step } from "@jevitate/recording";
import { RecordingSchema } from "@jevitate/recording";
import { mutationReplay, planJourneyMutations, type Journey } from "./index.js";

// #720: a Journey authored with two descriptor-bound uploads (before/after photos). `journey verify
// --mutate` must prove each upload: skipping either one has to break that upload's own checked outcome.

function journey(steps: RecordedStep[]): Journey {
  return {
    metadata: { id: "uploads", name: "Uploads", promoted: false, params: [], createdAtIso: "2026-11-16T00:00:00Z", endState: [] },
    recording: { version: "1", site: "http://localhost:3000", pages: [{ url: "/showcase", steps }] },
  };
}

const upload = (label: string, file: string, expect?: Extract<Step, { kind: "upload" }>["expect"]): RecordedStep => ({
  step: { kind: "upload", target: { label }, file: { redacted: false, value: file }, expect: expect ?? { kind: "textIncludes", target: { testId: `${label}-name` }, text: file } },
});

const publish: RecordedStep = {
  step: { kind: "click", target: { role: "button", name: "Publish" }, expect: { kind: "visible", target: { role: "status", name: "Published" } } },
  delta: { verdict: "relevant-change", why: "saved", changes: ["status"], requests: ["POST /api/showcase → 201"], overheadMs: 0 },
};

describe("#720 mutation proof covers each upload", () => {
  it("skips each checked upload separately and pairs the skip with that upload's own claim", () => {
    const plan = planJourneyMutations(journey([upload("Before photo", "fixtures/before.png"), upload("After photo", "fixtures/after.png"), publish]));
    expect(plan.mutations.map((m) => m.id)).toEqual(["skip:1", "skip:2", "skip:3", "block-write:3"]);
    expect(plan.pairs).toEqual(expect.arrayContaining([{ site: "step:1", mutation: "skip:1" }, { site: "step:2", mutation: "skip:2" }]));
  });

  it("proves both uploads when they attach the same fixture", () => {
    const plan = planJourneyMutations(journey([upload("Before photo", "fixtures/same.png"), upload("After photo", "fixtures/same.png"), publish]));
    expect(plan.mutations.map((m) => m.id)).toEqual(expect.arrayContaining(["skip:1", "skip:2"]));
  });

  it("replays a skipped upload as its own claim only, leaving the other upload and the schema intact", () => {
    const j = journey([upload("Before photo", "fixtures/before.png"), upload("After photo", "fixtures/after.png"), publish]);
    const before = structuredClone(j);
    const replay = mutationReplay(j, { kind: "skip", step: 2, id: "skip:2" });
    const steps = replay.journey.recording.pages[0]!.steps;
    expect(steps[0]).toEqual(before.recording.pages[0]!.steps[0]);
    expect(steps[1]!.step).toEqual({ kind: "assert", check: { kind: "textIncludes", target: { testId: "After photo-name" }, text: "fixtures/after.png" } });
    expect(RecordingSchema.safeParse(replay.journey.recording).success).toBe(true);
    expect(j).toEqual(before);
  });

  it("does not invent a skip for an upload that only restates its own target or makes no claim", () => {
    const own = upload("Before photo", "fixtures/before.png", { kind: "visible", target: { label: "Before photo" } });
    const none = upload("After photo", "fixtures/after.png", { kind: "urlIncludes", text: "" });
    expect(planJourneyMutations(journey([own, none])).mutations).toEqual([]);
  });
});
