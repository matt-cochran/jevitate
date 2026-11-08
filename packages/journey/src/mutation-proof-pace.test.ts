import { describe, expect, it } from "vitest";
import {
  JourneySchema,
  controlCanChangeVerdict,
  heldSites,
  mutationProofVerdict,
  paceEndStateFloorMs,
  paceFloorMs,
  paceTailMs,
  pacedReplay,
  relaxedMutationReplay,
  siblingDisagreements,
  sitesReachedEarly,
  sitesUnmatchedBy,
  thinSites,
  type Journey,
  type MutationPlan,
  type MutationReplay,
  type MutationRunResult,
  type ReplayPace,
} from "./index.js";

const CLAIM = { kind: "textIncludes", target: { css: "#job" }, text: "done" } as const;
const PROGRESS = { kind: "visible", target: { css: "#panel" } } as const;
const WAIT = { maxMs: 600_000, stallMs: 1_000, progress: PROGRESS };

function journey(wait?: object): Journey {
  return JourneySchema.parse({
    metadata: { id: "j", name: "J", promoted: false, params: [], createdAtIso: "2026-11-04T00:00:00Z" },
    recording: {
      version: "1",
      site: "https://example.test",
      pages: [
        {
          url: "/",
          steps: [
            { step: { kind: "click", target: { css: "#a" }, expect: CLAIM, ...(wait === undefined ? {} : { waitFor: wait }) } },
            { step: { kind: "click", target: { css: "#b" }, expect: CLAIM, ...(wait === undefined ? {} : { waitFor: wait }) } },
          ],
        },
      ],
    },
  });
}

const skip2 = { kind: "skip", step: 2, id: "skip:2" } as const;
const block2 = { kind: "block-write", step: 2, id: "block-write:2" } as const;
/** Step 1 took 2 s; step 2 took 8 s. */
const PACE: ReplayPace = { stepEndMs: [2_000, 10_000] };
const NONE: ReplayPace = { stepEndMs: [] };
const stepOf = (how: MutationReplay, n: number) => how.journey.recording.pages[0]!.steps[n - 1]!.step;
const replayOf = (j: Journey, pace: ReplayPace = PACE): MutationReplay => pacedReplay(j, { journey: structuredClone(j) }, skip2, pace);

describe("a replay's floor", () => {
  it("does not hold a step before the mutated one", () => {
    expect(paceFloorMs(PACE, skip2, 0)).toBeUndefined();
  });
  it("is what the base took from the mutated step's start, plus a second and a quarter of that step", () => {
    expect(paceFloorMs(PACE, skip2, 1)).toBe(8_000 + 1_000 + 2_000);
  });
  it("is nothing when the base measured nothing", () => {
    expect(paceFloorMs(NONE, skip2, 1)).toBeUndefined();
  });
  it("sets how long a replay that stopped sooner stays open", () => {
    expect(paceTailMs(PACE, skip2)).toBe(11_000);
  });
});

describe("a replay's end-state floor", () => {
  const SETTLED: ReplayPace = { stepEndMs: [2_000, 10_000], endStateMs: 14_000 };

  it("counts the settling after the last step, which no step's end shows", () => {
    expect(paceEndStateFloorMs(SETTLED, skip2)).toBe(12_000 + 1_000 + 2_000);
  });
  it("is the last step's floor when the base read no end state", () => {
    expect(paceEndStateFloorMs(PACE, skip2)).toBe(11_000);
  });
  it("names an end state read sooner than the base read it", () => {
    expect(sitesReachedEarly([{ where: "end-state", index: 0 }], skip2, SETTLED, [undefined, 11_000], 11_500)).toEqual(["end-state:0"]);
  });
  it("sets how long a replay that stopped sooner stays open", () => {
    expect(paceTailMs(SETTLED, skip2)).toBe(15_000);
  });
});

describe("a paced wait", () => {
  it("runs past what the base took when that outran the hang threshold", () => {
    const paced = stepOf(replayOf(journey({ maxMs: 600_000, stallMs: 1_000 })), 2);
    expect("waitFor" in paced && paced.waitFor?.maxMs).toBe(8_000 + 1_000 + 2_000);
  });
  it("is a whole number, whatever the base measured", () => {
    const paced = stepOf(replayOf(journey({ maxMs: 600_000, stallMs: 1_000 }), { stepEndMs: [2_000.5, 10_000.25] }), 2);
    expect(JourneySchema.safeParse({ ...journey(), recording: { ...journey().recording, pages: [{ url: "/", steps: [{ step: paced }] }] } }).success).toBe(true);
  });
  it("stays at the hang threshold for a job the base did not wait long on", () => {
    const paced = stepOf(replayOf(journey({ maxMs: 600_000, stallMs: 1_000 }), { stepEndMs: [2_000, 2_500] }), 2);
    expect("waitFor" in paced && paced.waitFor?.maxMs).toBe(6_000);
  });
  it("never raises the stored maxMs", () => {
    const paced = stepOf(replayOf(journey({ maxMs: 9_000, stallMs: 1_000 })), 2);
    expect("waitFor" in paced && paced.waitFor?.maxMs).toBe(9_000);
  });
  it("cannot be ended early by a progress signal", () => {
    const paced = stepOf(replayOf(journey(WAIT)), 2);
    expect("waitFor" in paced && paced.waitFor).not.toHaveProperty("progress");
  });
  it("leaves a step before the mutated one as stored", () => {
    expect(stepOf(replayOf(journey(WAIT)), 1)).toMatchObject({ waitFor: WAIT });
  });
  it("gives a claim with no waitFor one when the base's step outran the plain bound", () => {
    expect(stepOf(replayOf(journey()), 2)).toMatchObject({ waitFor: { maxMs: 11_000 } });
  });
  it("leaves a claim with no waitFor alone when the base's step did not", () => {
    expect(stepOf(replayOf(journey(), { stepEndMs: [2_000, 3_000] }), 2)).not.toHaveProperty("waitFor");
  });
  it("replays the same Journey object when there is nothing to pace", () => {
    const j = journey();
    const how = { journey: j, skipIndex: 1 };
    expect(pacedReplay(j, how, skip2, { stepEndMs: [2_000, 3_000] }).journey).toBe(j);
  });
  it("bounds a relaxed site's kept wait the same way", () => {
    const j = journey(WAIT);
    const waits = pacedReplay(j, relaxedMutationReplay(j, block2), block2, PACE).relaxedSiteWaits;
    expect(waits?.[0]).toMatchObject({ wait: { maxMs: 11_000 } });
  });
  it("drops a relaxed site's progress signal", () => {
    const j = journey(WAIT);
    const kept = pacedReplay(j, relaxedMutationReplay(j, block2), block2, PACE).relaxedSiteWaits?.[0];
    expect(kept !== undefined && kept.kind === "page" ? kept.wait : undefined).not.toHaveProperty("progress");
  });
});

describe("a failed site reached sooner than the base passed it", () => {
  const OWN = { where: "step", step: 2, postcondition: true } as const;
  const END = { where: "end-state", index: 0 } as const;

  it("is named, for a step", () => {
    expect(sitesReachedEarly([OWN], skip2, PACE, [undefined, 1_000])).toEqual(["step:2"]);
  });
  it("is named, for an end state", () => {
    expect(sitesReachedEarly([END], skip2, PACE, [undefined, 1_000])).toEqual(["end-state:0"]);
  });
  it("is not named once the replay had as long as the base", () => {
    expect(sitesReachedEarly([OWN], skip2, PACE, [undefined, 8_000])).toEqual([]);
  });
  it("is not named when the replay measured nothing", () => {
    expect(sitesReachedEarly([OWN], skip2, PACE, [])).toEqual([]);
  });
  it("is not named when the base measured nothing", () => {
    expect(sitesReachedEarly([OWN], skip2, NONE, [undefined, 1_000])).toEqual([]);
  });
});

describe("a failed site with little to spare over the base", () => {
  const OWN = { where: "step", step: 2, postcondition: true } as const;
  const END = { where: "end-state", index: 0 } as const;

  it("is named when reached at the floor", () => {
    expect(thinSites([END], skip2, PACE, [undefined, 11_000])).toEqual(["end-state:0"]);
  });
  it("is not named once it had twice the margin", () => {
    expect(thinSites([OWN], skip2, PACE, [undefined, 14_000])).toEqual([]);
  });
  it("is not named when the replay measured nothing", () => {
    expect(thinSites([OWN], skip2, PACE, [])).toEqual([]);
  });
});

describe("a matched control against a mutated replay", () => {
  const END = { where: "end-state", index: 0 } as const;
  const OWN = { where: "step", step: 2, postcondition: true } as const;

  it("does not match when it got to the end state later than the margin allows", () => {
    expect(sitesUnmatchedBy([END], { endStateReachedMs: 3_500 }, { endStateReachedMs: 6_000 }, 1_000)).toEqual(["end-state:0"]);
  });
  it("does not match when it got there sooner than the margin allows, where a claim that decays could still hold", () => {
    expect(sitesUnmatchedBy([END], { endStateReachedMs: 6_000 }, { endStateReachedMs: 3_500 }, 1_000)).toEqual(["end-state:0"]);
  });
  it("matches within the margin, either way", () => {
    expect(sitesUnmatchedBy([END], { endStateReachedMs: 3_500 }, { endStateReachedMs: 4_000 }, 1_000)).toEqual([]);
  });
  it("compares when a step's site was arrived at, not when a claim that failed gave up", () => {
    expect(sitesUnmatchedBy([OWN], { arrivedMs: [undefined, 1_000] }, { arrivedMs: [undefined, 1_200] }, 1_000)).toEqual([]);
  });
  it("says nothing when it measured nothing", () => {
    expect(sitesUnmatchedBy([END], { endStateReachedMs: 3_500 }, {}, 1_000)).toEqual([]);
  });
});

describe("a site the replay was held on the way to", () => {
  const END = { where: "end-state", index: 0 } as const;
  const OWN = { where: "step", step: 2, postcondition: true } as const;

  it("is named for an end state read after a hold", () => {
    expect(heldSites([END], { endStateHeldMs: 400 })).toEqual(["end-state:0"]);
  });
  it("is named for a later step reached after a hold", () => {
    expect(heldSites([OWN], { heldMs: [undefined, 400] })).toEqual(["step:2"]);
  });
  it("is not named for the mutated step itself, which nothing held", () => {
    expect(heldSites([OWN], { heldMs: [undefined, 0] })).toEqual([]);
  });
});

describe("a claim compared with when the base's claim held", () => {
  const OWN = { where: "step", step: 2, postcondition: true } as const;
  const REQUEST = { where: "step-request", step: 2, checkIndex: 0 } as const;
  /** Step 2's claim held 100 ms in; its request check kept the step going for 8 s. */
  const SLOW_CHECK: ReplayPace = { stepEndMs: [2_000, 10_000], claimHeldMs: [1_000, 2_100] };

  it("is not early for failing later than the claim held, though the step went on longer", () => {
    expect(sitesReachedEarly([OWN], skip2, SLOW_CHECK, [undefined, 2_000])).toEqual([]);
  });
  it("is early for failing before the claim held", () => {
    expect(sitesReachedEarly([OWN], skip2, SLOW_CHECK, [undefined, 50])).toEqual(["step:2"]);
  });
  it("still compares a request check with the step's end", () => {
    expect(sitesReachedEarly([REQUEST], skip2, SLOW_CHECK, [undefined, 2_000])).toEqual(["step-request:2:0"]);
  });
  it("does not judge a request check its failed step never got to", () => {
    expect(sitesReachedEarly([REQUEST, OWN], skip2, SLOW_CHECK, [undefined, 2_000])).toEqual([]);
  });
  it("gives a dead claim no more room for a slow request check", () => {
    const paced = stepOf(replayOf(journey({ maxMs: 600_000, stallMs: 1_000 }), SLOW_CHECK), 2);
    expect("waitFor" in paced && paced.waitFor?.maxMs).toBe(6_000);
  });
});

describe("a floor with no margin", () => {
  it("is what the base took", () => {
    expect(paceFloorMs(PACE, skip2, 1, false)).toBe(8_000);
  });
  it("is what the base took to read its end state", () => {
    expect(paceEndStateFloorMs({ ...PACE, endStateMs: 14_000 }, skip2, false)).toBe(12_000);
  });
});

describe("a proof whose replays were not isolated", () => {
  const input = { basePassed: true, mutations: [{ outcome: "passed" as const }], assertions: [{ site: "step:1", verdict: "insensitive" as const }] };

  it("reads inconclusive, even over an insensitive assertion", () => {
    expect(mutationProofVerdict({ ...input, notIsolated: "a replay left work" }).verdict).toBe("inconclusive");
  });
  it("gives that as its reason", () => {
    expect(mutationProofVerdict({ ...input, notIsolated: "a replay left work" }).reason).toBe("a replay left work");
  });
  it("counts a control that errored as an errored replay", () => {
    const sensitive = { basePassed: true, mutations: [{ outcome: "failed" as const, control: "error" as const }], assertions: [{ site: "step:1", verdict: "sensitive" as const }] };
    expect(mutationProofVerdict(sensitive).verdict).toBe("inconclusive");
  });
  it("counts a re-run that errored as an errored replay", () => {
    const sensitive = { basePassed: true, mutations: [{ outcome: "failed" as const, rerun: "error" as const }], assertions: [{ site: "step:1", verdict: "sensitive" as const }] };
    expect(mutationProofVerdict(sensitive).verdict).toBe("inconclusive");
  });
  it("still names a failed restore first", () => {
    expect(mutationProofVerdict({ ...input, restoreFailed: true, notIsolated: "a replay left work" }).reason).toMatch(/fixture restore failed/);
  });
});

describe("sibling mutations of a step", () => {
  const j = journey();
  const OWN_2: MutationRunResult = { outcome: "failed", failedSites: [{ where: "step", step: 2, postcondition: true }] };
  const PASSED: MutationRunResult = { outcome: "passed", failedSites: [] };
  const skip1 = { kind: "skip", step: 1, id: "skip:1" } as const;
  const plan: MutationPlan = { mutations: [skip2, block2], pairs: [{ site: "step:2", mutation: skip2.id }, { site: "step:2", mutation: block2.id }] };

  it("disagree when one fails a site the other passes", () => {
    expect(siblingDisagreements(j, plan, new Map([[skip2.id, OWN_2], [block2.id, PASSED]]))).toEqual([{ site: "step:2", sensitive: skip2.id, passed: block2.id }]);
  });
  it("agree when both fail it", () => {
    expect(siblingDisagreements(j, plan, new Map([[skip2.id, OWN_2], [block2.id, OWN_2]]))).toEqual([]);
  });
  it("do not disagree with a mutation of another step", () => {
    const across: MutationPlan = { mutations: [skip1, skip2], pairs: [{ site: "step:2", mutation: skip1.id }, { site: "step:2", mutation: skip2.id }] };
    expect(siblingDisagreements(j, across, new Map([[skip2.id, OWN_2], [skip1.id, PASSED]]))).toEqual([]);
  });
  it("do not disagree once the failure has been struck", () => {
    expect(siblingDisagreements(j, plan, new Map([[skip2.id, { ...OWN_2, waitsCut: ["step:2"] }], [block2.id, PASSED]]))).toEqual([]);
  });
});

describe("whether a control can still change the verdict", () => {
  const j = journey();
  const OWN_1: MutationRunResult = { outcome: "failed", failedSites: [{ where: "step", step: 1, postcondition: true }] };
  const OWN_2: MutationRunResult = { outcome: "failed", failedSites: [{ where: "step", step: 2, postcondition: true }] };
  const PASSED: MutationRunResult = { outcome: "passed", failedSites: [] };
  const NOT_APPLIED: MutationRunResult = { outcome: "not-applied", failedSites: [] };
  const skip1 = { kind: "skip", step: 1, id: "skip:1" } as const;
  const plan: MutationPlan = { mutations: [skip1, skip2, block2], pairs: [{ site: "step:1", mutation: skip1.id }, { site: "step:2", mutation: skip2.id }, { site: "step:2", mutation: block2.id }] };

  it("can while the proof can still be proven", () => {
    expect(controlCanChangeVerdict(j, plan, new Map([[skip1.id, OWN_1], [skip2.id, OWN_2]]), ["step:2"])).toBe(true);
  });
  it("cannot once another site is finally insensitive", () => {
    expect(controlCanChangeVerdict(j, plan, new Map([[skip1.id, PASSED], [skip2.id, OWN_2]]), ["step:2"])).toBe(false);
  });
  it("cannot when the proof cannot be proven and the reading has no sibling to fall to", () => {
    expect(controlCanChangeVerdict(j, plan, new Map([[skip1.id, NOT_APPLIED], [skip2.id, OWN_2], [block2.id, OWN_2]]), ["step:2"])).toBe(false);
  });
  it("can when the proof cannot be proven but a sibling is still to run, since its pass would decide the site", () => {
    expect(controlCanChangeVerdict(j, plan, new Map([[skip1.id, NOT_APPLIED], [skip2.id, OWN_2]]), ["step:2"])).toBe(true);
  });
});
