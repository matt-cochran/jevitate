import { expect, test, vi } from "vitest";
import type { Recording } from "@jevitate/recording";
import type { JudgmentPort, GenerationPort } from "@jevitate/ai-core";
import { authorJourney } from "./author-journey.js";

// `discoveredRecording` is referenced inside the hoisted `vi.mock` factory, so
// it must itself be hoisted (a plain top-level const would not be initialized
// when the hoisted mock factory runs).
const { discoveredRecording } = vi.hoisted(() => ({
  discoveredRecording: {
    version: "1.0",
    site: "https://example.test",
    pages: [
      {
        url: "/search",
        steps: [
          { step: { kind: "navigate", url: "/search", expect: { kind: "visible", target: { testId: "box" } } } },
          { step: { kind: "fill", target: { testId: "q" }, value: { redacted: true, length: 7 }, expect: { kind: "visible", target: { testId: "results" } } } },
        ],
      },
    ],
  } as Recording,
}));

// The real `runGoalBasedMission` drives generation for each fill/select step it
// executes; the mock simulates that so `ValueCapturingGenerationPort` (inside
// `authorJourney`) captures a value for the single fill step of the recording.
vi.mock("../missions/goal-based.js", () => ({
  runGoalBasedMission: vi.fn(async (cfg: { goal: string; gen: GenerationPort }) => {
    await cfg.gen.generate("form.value", { fieldLabel: "q", goal: cfg.goal, visibleContext: "", history: [] });
    return { outcome: "succeeded", assertionPassed: true, recording: discoveredRecording, transcript: [], finalUrl: "https://example.test/search", run: {} };
  }),
}));

const fakeJudgment: JudgmentPort = { systemOne: vi.fn(async () => ({})) } as unknown as JudgmentPort;
const fakeGeneration: GenerationPort = {
  generate: vi.fn(async () => ({ output: { text: "widgets" }, provenance: { model: "fake", tookMs: 0 } })),
} as unknown as GenerationPort;

test("single-take authoring (takes: 1) produces a fully-materialized, replayable Journey", async () => {
  const result = await authorJourney({
    goal: "search for widgets",
    successAssertion: { kind: "visible", target: { testId: "results" } },
    allowlist: ["https://example.test"],
    startUrl: "https://example.test/search",
    actor: {} as never,
    judgment: fakeJudgment,
    generation: fakeGeneration,
    takes: 1,
    journeyId: "explore-search",
    journeyName: "Explore: search",
  });

  expect(result.outcome).toBe("authored");
  if (result.outcome !== "authored") throw new Error("unreachable");
  expect(result.journey.metadata.authoredBy).toBe("jev-driven");
  expect(result.journey.metadata.promoted).toBe(false);
  const fillStep = result.journey.recording.pages[0].steps[1].step;
  expect(fillStep.kind).toBe("fill");
  if (fillStep.kind === "fill") {
    // single take, no corroboration -> materialized constant, not redacted.
    expect(fillStep.value).toEqual({ redacted: false, value: "widgets" });
  }
});

test("#118: the authored Journey's final step asserts the independent success condition", async () => {
  const result = await authorJourney({
    goal: "search for widgets",
    successAssertion: { kind: "visible", target: { testId: "results" } },
    allowlist: ["https://example.test"],
    startUrl: "https://example.test/search",
    actor: {} as never,
    judgment: fakeJudgment,
    generation: fakeGeneration,
    takes: 1,
    journeyId: "explore-search",
    journeyName: "Explore: search",
  });

  expect(result.outcome).toBe("authored");
  if (result.outcome !== "authored") throw new Error("unreachable");
  const pages = result.journey.recording.pages;
  const lastPage = pages[pages.length - 1];
  const lastStep = lastPage.steps[lastPage.steps.length - 1].step;
  expect(lastStep).toEqual({ kind: "assert", check: { kind: "visible", target: { testId: "results" } } });
});

test("returns not-reached when the discovery mission does not succeed", async () => {
  const { runGoalBasedMission } = await import("../missions/goal-based.js");
  (runGoalBasedMission as unknown as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
    outcome: "blocked",
    assertionPassed: false,
    recording: discoveredRecording,
    transcript: [],
    finalUrl: "https://example.test/search",
    run: {},
  });

  const result = await authorJourney({
    goal: "search for widgets",
    successAssertion: { kind: "visible", target: { testId: "results" } },
    allowlist: ["https://example.test"],
    startUrl: "https://example.test/search",
    actor: {} as never,
    judgment: fakeJudgment,
    generation: fakeGeneration,
    takes: 1,
    journeyId: "explore-search",
    journeyName: "Explore: search",
  });

  expect(result).toEqual({ outcome: "not-reached", reason: "discovery mission blocked" });
});

test("multi-take authoring (takes: 2) promotes a value that differs across takes to a variable", async () => {
  // Uses the default mock (which drives cfg.gen once per mission call); the
  // generation port yields a different value on each of the two takes, so the
  // single fill step varies across takes and is promoted to a variable.
  const generation: GenerationPort = {
    generate: vi
      .fn()
      .mockResolvedValueOnce({ output: { text: "widgets" }, provenance: { model: "fake", tookMs: 0 } })
      .mockResolvedValueOnce({ output: { text: "gadgets" }, provenance: { model: "fake", tookMs: 0 } }),
  } as unknown as GenerationPort;

  const result = await authorJourney({
    goal: "search for something",
    successAssertion: { kind: "visible", target: { testId: "results" } },
    allowlist: ["https://example.test"],
    startUrl: "https://example.test/search",
    actor: {} as never,
    judgment: fakeJudgment,
    generation,
    takes: 2,
    journeyId: "explore-search",
    journeyName: "Explore: search",
  });

  expect(result.outcome).toBe("authored");
  if (result.outcome !== "authored") throw new Error("unreachable");
  expect(result.journey.metadata.params.length).toBe(1); // the fill step was promoted to a variable
  const fillStep = result.journey.recording.pages[0].steps[1].step;
  if (fillStep.kind === "fill") expect(fillStep.value).toEqual({ var: expect.any(String) });
});
