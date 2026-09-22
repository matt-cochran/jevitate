import { expect, test, vi } from "vitest";
import type { Recording, Assertion } from "@jevitate/recording";
import type { JudgmentPort, GenerationPort } from "@jevitate/ai-core";
import { makeExploreSelfHealer } from "./self-heal-adapter.js";

const segment: Recording = { version: "1.0", site: "https://example.test", pages: [] };

vi.mock("@jevitate/explore", () => ({
  runGoalBasedMission: vi.fn(async () => ({ outcome: "succeeded", recording: segment, transcript: [] })),
}));

const judgment: JudgmentPort = { systemOne: vi.fn(async () => ({})) };
const generation: GenerationPort = { generate: vi.fn(async () => ({ output: { text: "" }, provenance: { model: "fake", tookMs: 0 } })) } as any;

test("maps a succeeded mission to {outcome: 'healed', segment}", async () => {
  const healer = makeExploreSelfHealer(judgment, generation);
  const expectedPostcondition: Assertion = { kind: "visible", target: { testId: "next" } };
  const result = await healer.reLearnStep({
    actor: {} as any,
    brokenStep: { kind: "click", target: { testId: "old-button" }, expect: expectedPostcondition },
    expectedPostcondition,
  });
  expect(result).toEqual({ outcome: "healed", segment });
});

test("maps a non-succeeded mission to {outcome: 'not-healed'}", async () => {
  const { runGoalBasedMission } = await import("@jevitate/explore");
  (runGoalBasedMission as any).mockResolvedValueOnce({ outcome: "blocked", recording: segment, transcript: [] });

  const healer = makeExploreSelfHealer(judgment, generation);
  const expectedPostcondition: Assertion = { kind: "visible", target: { testId: "next" } };
  const result = await healer.reLearnStep({
    actor: {} as any,
    brokenStep: { kind: "click", target: { testId: "old-button" }, expect: expectedPostcondition },
    expectedPostcondition,
  });
  expect(result.outcome).toBe("not-healed");
});
