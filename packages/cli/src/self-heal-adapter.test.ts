import { expect, test, vi } from "vitest";
import type { Recording, Assertion, Step } from "@jevitate/recording";
import type { JudgmentPort, GenerationPort } from "@jevitate/ai-core";
import { EMPTY_CHANGE_SCOPE, explainsBreak, type HealerRequest } from "@jevitate/runtime";
import { makeExploreSelfHealer } from "./self-heal-adapter.js";

const expectedPostcondition: Assertion = { kind: "visible", target: { testId: "next" } };
const brokenStep: Step = { kind: "click", target: { testId: "old-button" }, expect: expectedPostcondition };
const learnedStep: Step = { kind: "click", target: { testId: "new-button" }, expect: { kind: "urlIncludes", text: "/" } };
const segment: Recording = { version: "1.0", site: "https://example.test", pages: [{ url: "/a", steps: [{ step: learnedStep }] }] };

vi.mock("@jevitate/explore", () => ({
  runGoalBasedMission: vi.fn(async () => ({ outcome: "succeeded", recording: segment, transcript: [] })),
}));

const judgment: JudgmentPort = { systemOne: vi.fn(async () => ({})) };
const generation: GenerationPort = { generate: vi.fn(async () => ({ output: { text: "" }, provenance: { model: "fake", tookMs: 0 } })) } as any;

const request = (extra: Partial<HealerRequest> = {}): HealerRequest => ({
  actor: {} as any,
  brokenStep,
  explanation: explainsBreak(brokenStep, EMPTY_CHANGE_SCOPE),
  evidence: [],
  tried: [],
  deadlineAtMs: 0,
  maxModelCalls: 6,
  ...extra,
});

test("proposes the broken step with the re-learned locator only (its proof as recorded)", async () => {
  const healer = makeExploreSelfHealer(judgment, generation);
  const proposal = await healer.proposeCandidates(request());
  expect(proposal.candidates.map((c) => c.step)).toEqual([{ ...brokenStep, target: { testId: "new-button" } }]);
});

test("proposes nothing for a non-succeeded mission", async () => {
  const { runGoalBasedMission } = await import("@jevitate/explore");
  (runGoalBasedMission as any).mockResolvedValueOnce({ outcome: "blocked", recording: segment, transcript: [] });
  const healer = makeExploreSelfHealer(judgment, generation);
  expect((await healer.proposeCandidates(request())).candidates).toEqual([]);
});

test("#399: the run's secrets reach the re-learn mission (it redacts them from every model prompt)", async () => {
  const { runGoalBasedMission } = await import("@jevitate/explore");
  const healer = makeExploreSelfHealer(judgment, generation);
  await healer.proposeCandidates(request({ secrets: ["tok-399"] }));
  expect(runGoalBasedMission).toHaveBeenLastCalledWith(expect.objectContaining({ secrets: ["tok-399"] }));
});
