import { describe, it, expect } from "vitest";
import type { Step } from "@jevitate/recording";
import {
  JourneySchema,
  MAX_TARGETED_RELAXATIONS,
  assertionSiteKey,
  classifyMutation,
  journeyAssertions,
  judgeAssertions,
  mutationProofVerdict,
  nextTargetedRelaxation,
  planJourneyMutations,
  relaxedMutationReplay,
  runTargetedProof,
  targetedControlReplay,
  targetedMutationReplay,
  type Journey,
  type JourneyMutation,
  type MutationFailedSite,
  type MutationPlan,
  type MutationRunResult,
} from "./index.js";

// #609 — a TARGETED proof for an assertion that is a `cascade` under a paired mutation only because
// an EARLIER intentional defense caught the same mutation first. The earlier step's postcondition is
// weakened in a cloned Journey (bounded and recorded); the target assertion is never relaxed.

const PARAMS = { threadId: "T-1042" };

/** select `{var: threadId}` (own valueEquals), click with a `data-threadid` attr check, end-state valueEquals. */
function threadJourney(): Journey {
  return JourneySchema.parse({
    metadata: {
      id: "thread",
      name: "Open a thread",
      promoted: false,
      params: ["threadId"],
      createdAtIso: "2026-10-17T00:00:00Z",
      endState: [{ kind: "page", assertion: { kind: "valueEquals", target: { testId: "thread" }, value: { var: "threadId" } } }],
    },
    recording: {
      version: "1",
      site: "http://localhost:3000",
      pages: [
        {
          url: "/threads",
          steps: [
            {
              step: {
                kind: "select",
                target: { label: "Thread" },
                value: { var: "threadId" },
                expect: { kind: "valueEquals", target: { label: "Thread" }, value: { var: "threadId" } },
              },
            },
            {
              step: {
                kind: "click",
                target: { role: "button", name: "Open" },
                expect: { kind: "attr", target: { testId: "thread-badge" }, name: "data-threadid", value: { var: "threadId" } },
              },
            },
          ],
        },
      ],
    },
  });
}

const plan = (): MutationPlan => planJourneyMutations(threadJourney(), { params: PARAMS });
const swapMutation = (): JourneyMutation => plan().mutations.find((m) => m.id === "swap-param:threadId")!;
const siteOf = (key: string) => journeyAssertions(threadJourney()).find((s) => assertionSiteKey(s) === key)!;
/** A plan that pairs the mutation only with the target end state, so the blocking step is unpaired. */
const unpairedPlan = (m: JourneyMutation): MutationPlan => ({ mutations: [m], pairs: [{ site: "end-state:0", mutation: m.id }] });

const ownPost = { where: "step" as const, step: 1, postcondition: true };
/** The mutation's own postcondition failed, and its relaxed replay was blocked at step 2. */
const relaxedBlockedAtStep2: MutationRunResult = {
  outcome: "failed",
  failedSites: [ownPost],
  relaxed: { outcome: "failed", failedSites: [{ where: "step", step: 2, postcondition: true }] },
};
const relaxedRun = { outcome: "failed" as const, failedSites: [{ where: "step" as const, step: 2, postcondition: true }] };
const step2Site = siteOf("step:2");
const endStateSite = siteOf("end-state:0");

describe("#609 nextTargetedRelaxation", () => {
  it("relaxes the first blocking earlier postcondition paired with the mutation", () => {
    expect(nextTargetedRelaxation(threadJourney(), plan(), swapMutation(), "end-state:0", relaxedRun, [])).toEqual({ relax: "step:2" });
  });

  it("returns null when the target is no longer a cascade", () => {
    const sensitiveRun = { outcome: "failed" as const, failedSites: [{ where: "end-state" as const, index: 0 }] };
    expect(nextTargetedRelaxation(threadJourney(), plan(), swapMutation(), "end-state:0", sensitiveRun, [])).toBeNull();
  });

  it("refuses a blocking step that is not paired with the mutation", () => {
    const journey = threadJourney();
    const m = swapMutation();
    expect(nextTargetedRelaxation(journey, unpairedPlan(m), m, "end-state:0", relaxedRun, [])).toEqual({ refuse: "step:2 is not paired with swap-param:threadId" });
  });

  it("refuses a blocking action failure rather than a postcondition", () => {
    const actionFailed = { outcome: "failed" as const, failedSites: [{ where: "step" as const, step: 2, postcondition: false }] };
    expect(nextTargetedRelaxation(threadJourney(), plan(), swapMutation(), "end-state:0", actionFailed, [])).toEqual({ refuse: "step:2 action failed (not a postcondition)" });
  });

  it("refuses once the relaxation bound is reached", () => {
    expect(nextTargetedRelaxation(threadJourney(), plan(), swapMutation(), "end-state:0", relaxedRun, ["step:9", "step:8", "step:7", "step:6"])).toEqual({
      refuse: `relaxation bound ${MAX_TARGETED_RELAXATIONS} reached`,
    });
  });

  it("refuses a failure before the mutated step", () => {
    const before: MutationRunResult = { outcome: "failed", failedSites: [{ where: "step", step: 1, postcondition: true }] };
    const m: JourneyMutation = { kind: "skip", step: 3, id: "skip:3" };
    expect(nextTargetedRelaxation(threadJourney(), plan(), m, "end-state:0", { outcome: before.outcome, failedSites: before.failedSites }, [])).toEqual({
      refuse: "failure before the mutated step",
    });
  });

  it("refuses an unevaluable end state", () => {
    const unevaluable: readonly MutationFailedSite[] = [{ where: "unevaluable" }];
    expect(nextTargetedRelaxation(threadJourney(), plan(), swapMutation(), "end-state:0", { outcome: "failed", failedSites: unevaluable }, [])).toEqual({ refuse: "unevaluable end state" });
  });
});

describe("#609 targetedMutationReplay", () => {
  it("leaves the input Journey deep-equal to before", () => {
    const journey = threadJourney();
    const before = structuredClone(journey);
    targetedMutationReplay(journey, swapMutation(), "end-state:0", ["step:2"], { params: PARAMS });
    expect(journey).toEqual(before);
  });

  it("weakens a relaxed earlier step's expect to a claim on its own target", () => {
    const journey = threadJourney();
    journey.recording.pages[0]!.steps[1]!.step = { ...journey.recording.pages[0]!.steps[1]!.step, waitFor: { maxMs: 30_000 } } as Step;
    const how = targetedMutationReplay(journey, swapMutation(), "end-state:0", ["step:2"], { params: PARAMS });
    expect(how.journey.recording.pages[0]!.steps[1]!.step).toEqual({
      kind: "click",
      target: { role: "button", name: "Open" },
      expect: { kind: "visible", target: { role: "button", name: "Open" } },
    });
  });

  it("replaces a relaxed assert step's check with the no-claim urlIncludes", () => {
    const journey = threadJourney();
    journey.recording.pages[0]!.steps[1]!.step = { kind: "assert", check: { kind: "attr", target: { testId: "thread-badge" }, name: "data-threadid", value: { var: "threadId" } } };
    const how = targetedMutationReplay(journey, swapMutation(), "end-state:0", ["step:2"], { params: PARAMS });
    expect(how.journey.recording.pages[0]!.steps[1]!.step).toEqual({ kind: "assert", check: { kind: "urlIncludes", text: "" } });
  });

  it("never relaxes the target assertion", () => {
    expect(() => targetedMutationReplay(threadJourney(), swapMutation(), "end-state:0", ["end-state:0"], { params: PARAMS })).toThrow(/target/);
  });

  it("rejects a non-step relaxation key", () => {
    expect(() => targetedMutationReplay(threadJourney(), swapMutation(), "end-state:0", ["step-request:2:0"], { params: PARAMS })).toThrow(/step/);
  });

  it("rejects relaxing a handback resume", () => {
    const journey = threadJourney();
    journey.recording.pages[0]!.steps[1]!.step = { kind: "handback", prompt: "Sign in", resume: { kind: "visible", target: { role: "heading", name: "Inbox" } } };
    expect(() => targetedMutationReplay(journey, swapMutation(), "end-state:0", ["step:2"], { params: PARAMS })).toThrow(/resume/);
  });
});

describe("#609 runTargetedProof", () => {
  const run = (
    replayResult: { outcome: MutationRunResult["outcome"]; failedSites: readonly MutationFailedSite[] },
    p: MutationPlan = plan(),
    control: MutationRunResult["outcome"] = "passed",
  ) =>
    runTargetedProof(threadJourney(), p, swapMutation(), endStateSite, relaxedBlockedAtStep2, async (_describe, kind) => (kind === "control" ? { outcome: control, failedSites: [] } : replayResult), { params: PARAMS });

  it("records the earlier site it relaxed", async () => {
    const proof = await run({ outcome: "failed", failedSites: [{ where: "end-state", index: 0 }] });
    expect(proof.relaxedSites).toEqual(["step:2"]);
  });

  it("a targeted end-state failure proves the site sensitive with its relaxed sites", async () => {
    const proof = await run({ outcome: "failed", failedSites: [{ where: "end-state", index: 0 }] });
    const result: MutationRunResult = { ...relaxedBlockedAtStep2, targeted: [proof] };
    const judged = judgeAssertions(threadJourney(), plan(), new Map([[swapMutation().id, result]])).find((a) => a.site === "end-state:0");
    expect(judged).toEqual({ site: "end-state:0", verdict: "sensitive", provedBy: "swap-param:threadId", relaxedSites: ["step:2"] });
  });

  it("a targeted run that passes classifies the target as insensitive", async () => {
    const proof = await run({ outcome: "passed", failedSites: [] });
    expect(classifyMutation(endStateSite, swapMutation(), { ...relaxedBlockedAtStep2, targeted: [proof] })).toBe("insensitive");
  });

  it("refuses a targeted failure whose unmutated control replay does not pass", async () => {
    const proof = await run({ outcome: "failed", failedSites: [{ where: "end-state", index: 0 }] }, plan(), "failed");
    expect(proof.refused).toMatch(/unmutated control replay with step:2 relaxed did not pass/);
  });

  it("a failed control keeps the target a cascade", async () => {
    const proof = await run({ outcome: "failed", failedSites: [{ where: "end-state", index: 0 }] }, plan(), "failed");
    expect(classifyMutation(endStateSite, swapMutation(), { ...relaxedBlockedAtStep2, targeted: [proof] })).toBe("cascade");
  });

  it("describes each targeted replay from the Journey the run gives it", async () => {
    const seen: string[] = [];
    const given = { ...threadJourney(), recording: { ...threadJourney().recording, site: "http://env.example.test" } };
    await runTargetedProof(threadJourney(), plan(), swapMutation(), endStateSite, relaxedBlockedAtStep2, async (describe, kind) => {
      seen.push(describe(given).journey.recording.site);
      return kind === "control" ? { outcome: "passed", failedSites: [] } : { outcome: "failed", failedSites: [{ where: "end-state", index: 0 }] };
    }, { params: PARAMS });
    expect(seen).toEqual(["http://env.example.test", "http://env.example.test"]);
  });

  it("a refused targeted run keeps the target a cascade and names the refusing site", async () => {
    const m = swapMutation();
    const proof = await run({ outcome: "failed", failedSites: [] }, unpairedPlan(m));
    const result: MutationRunResult = { ...relaxedBlockedAtStep2, targeted: [proof] };
    const judged = judgeAssertions(threadJourney(), unpairedPlan(m), new Map([[m.id, result]])).find((a) => a.site === "end-state:0");
    expect(judged).toMatchObject({ verdict: "cascade", targetedRefusal: "step:2 is not paired with swap-param:threadId" });
  });
});

describe("#609 targetedControlReplay", () => {
  it("applies no mutation (no altered params, skip, block or select swap)", () => {
    expect(Object.keys(targetedControlReplay(threadJourney(), swapMutation(), ["step:2"]))).toEqual(["journey"]);
  });

  it("weakens the mutated step's own claim as the targeted replay does", () => {
    const how = targetedControlReplay(threadJourney(), swapMutation(), ["step:2"]);
    const own = how.journey.recording.pages[0]!.steps[0]!.step;
    expect("expect" in own ? own.expect.kind : own.kind).toBe("visible");
  });

  it("leaves the input Journey deep-equal to before", () => {
    const journey = threadJourney();
    const before = structuredClone(journey);
    targetedControlReplay(journey, swapMutation(), ["step:2"]);
    expect(journey).toEqual(before);
  });
});

describe("#609 relaxed guard-param replay", () => {
  it("leaves the input Journey deep-equal to before", () => {
    const journey = threadJourney();
    const before = structuredClone(journey);
    relaxedMutationReplay(journey, { id: "guard-param:threadId", kind: "guard-param", step: 1, param: "threadId" }, { params: PARAMS });
    expect(journey).toEqual(before);
  });
});

describe("#609 classification without a targeted result", () => {
  it("keeps the end-state site a cascade", () => {
    expect(classifyMutation(endStateSite, swapMutation(), relaxedBlockedAtStep2)).toBe("cascade");
  });

  it("keeps the blocking step sensitive from the original/relaxed run", () => {
    expect(classifyMutation(step2Site, swapMutation(), relaxedBlockedAtStep2)).toBe("sensitive");
  });

  it("mentions the targeted refusal when the verdict stays inconclusive", async () => {
    const m = swapMutation();
    const proof = await runTargetedProof(threadJourney(), unpairedPlan(m), m, endStateSite, relaxedBlockedAtStep2, async () => ({ outcome: "failed", failedSites: [] }), { params: PARAMS });
    const result: MutationRunResult = { ...relaxedBlockedAtStep2, targeted: [proof] };
    const assertions = judgeAssertions(threadJourney(), unpairedPlan(m), new Map([[m.id, result]]));
    expect(mutationProofVerdict({ basePassed: true, mutations: [result], assertions }).reason).toContain("step:2 is not paired with swap-param:threadId");
  });
});
