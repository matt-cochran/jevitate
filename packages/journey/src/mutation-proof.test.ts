import { describe, it, expect } from "vitest";
import type { Recording, RecordedStep } from "@jevitate/recording";
import {
  JourneySchema,
  journeyAssertions,
  journeyWriteSteps,
  planJourneyMutations,
  mutationReplay,
  classifyMutation,
  judgeAssertions,
  mutationProofVerdict,
  assertionSiteKey,
  type Journey,
  type MutationRunResult,
} from "./index.js";

// #402 — the pure half of `journey verify --mutate`: which mutations a Journey gets, which assertion
// each one must break, how a mutated replay is set up, and how its result is classified.

const meta = { id: "mut", name: "Mutate", promoted: false, params: [], createdAtIso: "2026-10-07T00:00:00Z" };

function rec(steps: RecordedStep[]): Recording {
  return { version: "1", site: "http://localhost:3000", pages: [{ url: "/editor", steps }] };
}

function j(steps: RecordedStep[], metadata: Partial<Journey["metadata"]> = {}): Journey {
  return { metadata: { ...meta, ...metadata }, recording: rec(steps) };
}

const saveWrite = { verdict: "relevant-change" as const, why: "saved", changes: ["status"], requests: ["POST /api/save → 200"], overheadMs: 1 };
const status2xx = { kind: "responseStatus" as const, method: "POST", pathGlob: "/api/save", status: { class: 2 as const } };
const reloadThen = { kind: "reloadThen" as const, assertion: { kind: "textIncludes" as const, target: { testId: "status" }, text: "hello" } };

/** navigate, fill "hello" (valueEquals), click Save (a write), with the given strengthening. */
function saveJourney(opts: { stepRequests?: boolean; endState?: boolean; ownTarget?: boolean } = {}): Journey {
  return j(
    [
      { step: { kind: "navigate", url: "/editor", expect: { kind: "visible", target: { role: "heading", name: "Editor" } } } },
      { step: { kind: "fill", target: { label: "Text" }, value: { redacted: false, value: "hello" }, expect: { kind: "valueEquals", target: { label: "Text" }, value: "hello" } } },
      {
        step: { kind: "click", target: { role: "button", name: "Save" }, expect: { kind: "visible", target: { role: "button", name: "Save" } } },
        delta: saveWrite,
        ...(opts.stepRequests === true ? { expectRequests: [status2xx] } : {}),
      },
    ],
    opts.endState === true ? { endState: [reloadThen] } : {},
  );
}

describe("#402 journeyWriteSteps", () => {
  it("lists each write step (1-based) with its recorded write request lines", () => {
    expect(journeyWriteSteps(saveJourney())).toEqual([{ step: 3, requests: ["POST /api/save → 200"] }]);
  });

  it("a read request is not a write", () => {
    const journey = j([{ step: { kind: "click", target: { testId: "x" }, expect: { kind: "urlIncludes", text: "/x" } }, delta: { ...saveWrite, verdict: "no-change", requests: ["GET /api/items → 200"] } }]);
    expect(journeyWriteSteps(journey)).toEqual([]);
  });
});

describe("#402 planJourneyMutations", () => {
  it("each write step gets skip and block-write; a fill whose value an assertion checks gets stale-value", () => {
    const plan = planJourneyMutations(saveJourney());
    expect(plan.mutations.map((m) => m.id)).toEqual(["skip:3", "block-write:3", "stale-value:2"]);
  });

  it("pairs a write step's own expect and step-request checks with its mutations, and the end state with the LAST write", () => {
    const plan = planJourneyMutations(saveJourney({ stepRequests: true, endState: true }));
    const pairsOf = (site: string): string[] => plan.pairs.filter((p) => p.site === site).map((p) => p.mutation).sort();
    expect(pairsOf("step:3")).toEqual(["block-write:3", "skip:3"]);
    expect(pairsOf("step-request:3:0")).toEqual(["block-write:3", "skip:3"]);
    // The reloadThen checks the typed "hello", so the fill's stale-value must break it too.
    expect(pairsOf("end-state:0")).toEqual(["block-write:3", "skip:3", "stale-value:2"]);
    expect(pairsOf("step:2")).toEqual(["stale-value:2"]);
    expect(pairsOf("step:1")).toEqual([]);
  });

  it("an explicit no-claim expect is never paired (it claims nothing)", () => {
    const journey = saveJourney({ stepRequests: true });
    const save = journey.recording.pages[0]!.steps[2]!;
    save.step = { kind: "click", target: { role: "button", name: "Save" }, expect: { kind: "count", target: { testId: "status" }, min: 0 } };
    const plan = planJourneyMutations(journey);
    expect(plan.pairs.filter((p) => p.site === "step:3")).toEqual([]);
    expect(plan.pairs.filter((p) => p.site === "step-request:3:0").length).toBe(2);
  });

  it("an end-state check is not paired with an earlier write step", () => {
    const journey = saveJourney({ endState: true });
    journey.recording.pages[0]!.steps.push({
      step: { kind: "click", target: { role: "button", name: "Publish" }, expect: { kind: "textIncludes", target: { testId: "status" }, text: "Published" } },
      delta: { ...saveWrite, requests: ["POST /api/publish → 200"] },
    });
    const plan = planJourneyMutations(journey);
    expect(plan.pairs.filter((p) => p.site === "end-state:0").map((p) => p.mutation).sort()).toEqual(["block-write:4", "skip:4", "stale-value:2"]);
  });

  it("a fill whose value is a param is resolved from the params", () => {
    const journey = saveJourney();
    journey.recording.pages[0]!.steps[1]!.step = {
      kind: "fill",
      target: { label: "Text" },
      value: { var: "text" },
      expect: { kind: "valueEquals", target: { label: "Text" }, value: "hello" },
    };
    expect(planJourneyMutations(journey).mutations.map((m) => m.id)).not.toContain("stale-value:2");
    expect(planJourneyMutations(journey, { params: { text: "hello" } }).mutations.map((m) => m.id)).toContain("stale-value:2");
  });

  it("adds declarative pairs, resolving an anchor name", () => {
    const journey = saveJourney({ endState: true });
    journey.metadata.anchors = [{ name: "typed", step: 2 }];
    journey.metadata.mutationPairs = [{ check: "end-state:0", mustFailWhen: "stale-value:typed" }];
    const plan = planJourneyMutations(journey);
    expect(plan.pairs).toContainEqual({ site: "end-state:0", mutation: "stale-value:2", declared: true });
  });
});

describe("#402 metadata.mutationPairs validation", () => {
  it("accepts a pair naming an existing site and step", () => {
    const journey = saveJourney({ stepRequests: true });
    journey.metadata.mutationPairs = [{ check: "step-request:3:0", mustFailWhen: "skip:3" }];
    expect(JourneySchema.safeParse(journey).success).toBe(true);
  });

  it.each([
    [{ check: "step-request:3:1", mustFailWhen: "skip:3" }, /no assertion/],
    [{ check: "end-state:0", mustFailWhen: "skip:3" }, /no assertion/],
    [{ check: "step:3", mustFailWhen: "skip:9" }, /step/],
    [{ check: "step:3", mustFailWhen: "skip:nope" }, /anchor/],
    [{ check: "step:3", mustFailWhen: "stale-value:3" }, /not a fill/],
    [{ check: "step:3", mustFailWhen: "explode:3" }, /.+/],
    [{ check: "page:3", mustFailWhen: "skip:3" }, /.+/],
  ])("refuses %j", (pair, message) => {
    const journey = saveJourney({ stepRequests: true });
    journey.metadata.mutationPairs = [pair];
    const r = JourneySchema.safeParse(journey);
    expect(r.success).toBe(false);
    if (!r.success) expect(r.error.issues.map((i) => i.message).join("\n")).toMatch(message);
  });
});

describe("#402 mutationReplay", () => {
  it("skip of a step with an expect keeps the step's index and checks its expect without acting", () => {
    const journey = saveJourney();
    const r = mutationReplay(journey, { kind: "skip", step: 3, id: "skip:3" });
    expect(r.journey.recording.pages[0]!.steps[2]!.step).toEqual({ kind: "assert", check: { kind: "visible", target: { role: "button", name: "Save" } } });
    expect(r.journey.recording.pages[0]!.steps).toHaveLength(3);
    expect(journey.recording.pages[0]!.steps[2]!.step.kind).toBe("click"); // never mutates the input
    expect(r.skipIndex).toBeUndefined();
  });

  it("skip of a step without an expect skips it in place", () => {
    const journey = saveJourney();
    journey.recording.pages[0]!.steps[2]!.step = { kind: "waitFor", target: { testId: "x" }, state: "visible" };
    expect(mutationReplay(journey, { kind: "skip", step: 3, id: "skip:3" })).toEqual({ journey, skipIndex: 2 });
  });

  it("block-write blocks writes in that step's window only", () => {
    const journey = saveJourney();
    expect(mutationReplay(journey, { kind: "block-write", step: 3, id: "block-write:3" })).toEqual({ journey, blockIndex: 2, blockRequests: ["POST /api/save → 200"] });
  });

  it("stale-value types an empty value", () => {
    const r = mutationReplay(saveJourney(), { kind: "stale-value", step: 2, id: "stale-value:2" });
    const step = r.journey.recording.pages[0]!.steps[1]!.step;
    expect(step.kind === "fill" && step.value).toEqual({ redacted: false, value: "" });
  });
});

describe("#402 classifyMutation", () => {
  const journey = saveJourney({ stepRequests: true, endState: true });
  const site = (key: string) => journeyAssertions(journey).find((s) => assertionSiteKey(s) === key)!;
  const skip3 = { kind: "skip" as const, step: 3, id: "skip:3" };
  const failed = (...failedSites: MutationRunResult["failedSites"]): MutationRunResult => ({ outcome: "failed", failedSites });

  it("a mutated replay that passed: insensitive", () => {
    expect(classifyMutation(site("step:3"), skip3, { outcome: "passed", failedSites: [] })).toBe("insensitive");
  });

  it("the paired step's own postcondition failed: sensitive", () => {
    expect(classifyMutation(site("step:3"), skip3, failed({ where: "step", step: 3, postcondition: true }))).toBe("sensitive");
  });

  it("the paired step failed in its action, not its postcondition: cascade", () => {
    expect(classifyMutation(site("step:3"), skip3, failed({ where: "step", step: 3, postcondition: false }))).toBe("cascade");
  });

  it("a different step failed: cascade", () => {
    expect(classifyMutation(site("step-request:3:0"), skip3, failed({ where: "step", step: 4, postcondition: true }))).toBe("cascade");
  });

  it("the paired step-request check failed: sensitive", () => {
    expect(classifyMutation(site("step-request:3:0"), skip3, failed({ where: "step-request", step: 3, checkIndex: 0 }))).toBe("sensitive");
  });

  it("the paired end-state check failed with an earlier step-request failing too: cascade", () => {
    expect(classifyMutation(site("end-state:0"), skip3, failed({ where: "step-request", step: 2, checkIndex: 0 }, { where: "end-state", index: 0 }))).toBe("cascade");
  });

  it("the paired end-state check failed alongside the mutated step's own request check: sensitive", () => {
    expect(classifyMutation(site("end-state:0"), skip3, failed({ where: "step-request", step: 3, checkIndex: 0 }, { where: "end-state", index: 0 }))).toBe("sensitive");
  });

  it("an unevaluable end state is never sensitive", () => {
    expect(classifyMutation(site("end-state:0"), skip3, failed({ where: "unevaluable" }))).toBe("cascade");
  });

  it("not-applied and error pass through", () => {
    expect(classifyMutation(site("step:3"), skip3, { outcome: "not-applied", failedSites: [] })).toBe("not-applied");
    expect(classifyMutation(site("step:3"), skip3, { outcome: "error", failedSites: [] })).toBe("error");
  });
});

describe("#402 judgeAssertions", () => {
  it("sensitive wins over insensitive, proved by the first mutation that broke it; an unpaired assertion is unpaired", () => {
    const journey = saveJourney({ stepRequests: true });
    const plan = planJourneyMutations(journey);
    const results = new Map<string, MutationRunResult>([
      ["skip:3", { outcome: "passed", failedSites: [] }],
      ["block-write:3", { outcome: "failed", failedSites: [{ where: "step-request", step: 3, checkIndex: 0 }] }],
      ["stale-value:2", { outcome: "failed", failedSites: [{ where: "step", step: 2, postcondition: true }] }],
    ]);
    const verdicts = judgeAssertions(journey, plan, results);
    expect(verdicts).toEqual([
      { site: "step:1", verdict: "unpaired" },
      { site: "step:2", verdict: "sensitive", provedBy: "stale-value:2" },
      { site: "step:3", verdict: "insensitive" },
      { site: "step-request:3:0", verdict: "sensitive", provedBy: "block-write:3" },
    ]);
  });
});

describe("#402 mutationProofVerdict", () => {
  const ok = { outcome: "failed" as const, failedSites: [] };
  it("base failed: inconclusive, whatever the assertions", () => {
    expect(mutationProofVerdict({ basePassed: false, mutations: [], assertions: [] }).verdict).toBe("inconclusive");
  });
  it("every paired assertion sensitive: proven (unpaired ones do not count)", () => {
    expect(
      mutationProofVerdict({ basePassed: true, mutations: [ok], assertions: [{ site: "step:1", verdict: "unpaired" }, { site: "step:2", verdict: "sensitive", provedBy: "skip:2" }] }).verdict,
    ).toBe("proven");
  });
  it("any insensitive: insensitive", () => {
    expect(
      mutationProofVerdict({ basePassed: true, mutations: [ok], assertions: [{ site: "step:2", verdict: "sensitive" }, { site: "step:3", verdict: "insensitive" }] }).verdict,
    ).toBe("insensitive");
  });
  it("every mutation errored, or nothing was paired: inconclusive", () => {
    expect(mutationProofVerdict({ basePassed: true, mutations: [{ outcome: "error", failedSites: [] }], assertions: [{ site: "step:3", verdict: "error" }] }).verdict).toBe("inconclusive");
    expect(mutationProofVerdict({ basePassed: true, mutations: [], assertions: [{ site: "step:1", verdict: "unpaired" }] }).verdict).toBe("inconclusive");
  });
  it("only cascades or not-applied: inconclusive (nothing proven, nothing vacuous)", () => {
    expect(mutationProofVerdict({ basePassed: true, mutations: [ok], assertions: [{ site: "step:3", verdict: "cascade" }] }).verdict).toBe("inconclusive");
  });
});
