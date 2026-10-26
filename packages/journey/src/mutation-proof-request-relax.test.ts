import { describe, expect, it } from "vitest";
import { JourneySchema, assertionSiteKey, journeyAssertions, planJourneyMutations, runDeclaredTargetedProof, nextTargetedRelaxation, targetedMutationReplay, targetedControlReplay, suggestTargetedProofPlan, type Journey, type JourneyTargetedProofPlan } from "./index.js";

function fixture(declared = true): Journey {
  return JourneySchema.parse({ metadata: { id: "publish", name: "Publish", promoted: false, params: [], createdAtIso: "2026-10-26T00:00:00Z", endState: [{ kind: "page", assertion: { kind: "textIncludes", target: { testId: "result" }, text: "Saved" } }], mutationPairs: [{ check: "end-state:0", mustFailWhen: "block-write:1" }], ...(declared ? { targetedProofs: [{ check: "end-state:0", mustFailWhen: "block-write:1", relax: ["step-request:1:0"] }] } : {}) }, recording: { version: "1", site: "https://example.test", pages: [{ url: "/", steps: [{ step: { kind: "click", target: { testId: "save" }, expect: { kind: "textIncludes", target: { testId: "result" }, text: "Saved" } }, expectRequests: [{ kind: "responseStatus", method: "POST", pathGlob: "/save", status: { class: 2 } }, { kind: "requestMade", method: "GET", pathGlob: "/other" }], delta: { verdict: "relevant-change", why: "saved", changes: [], requests: ["POST /save → 200"], overheadMs: 0 } }] }] } });
}
describe("#708 declared step-request relaxation", () => {
  const setup = () => { const j = fixture(); const plan = planJourneyMutations(j); const m = plan.mutations.find((x) => x.id === "block-write:1")!; const target = journeyAssertions(j).find((x) => assertionSiteKey(x) === "end-state:0")!; return { j, plan, m, target }; };
  it("keeps automatic relaxation conservative and proposes the exact declared workflow", () => {
    const { j, plan, m } = setup();
    const run = { outcome: "failed" as const, failedSites: [{ where: "step-request" as const, step: 1, checkIndex: 0 }] };
    const next = nextTargetedRelaxation(j, plan, m, "end-state:0", run, []);
    expect(next).toEqual({ refuse: "step-request:1:0 is not a step postcondition" });
    expect(suggestTargetedProofPlan({ site: "end-state:0", relaxedSites: [], ...run, refused: "step-request:1:0 is not a step postcondition" }, m)).toEqual(j.metadata.targetedProofs![0]);
  });
  it("preserves all request checks and their indices in both mutated and control replays", () => {
    const { j, m } = setup(); const original = structuredClone(j);
    for (const replay of [targetedMutationReplay(j, m, "end-state:0", ["step-request:1:0"]), targetedControlReplay(j, m, ["step-request:1:0"])]) {
      expect(replay.relaxedStepRequests).toEqual(["step-request:1:0"]);
      expect(replay.journey.recording.pages[0]!.steps[0]!.expectRequests).toEqual(j.recording.pages[0]!.steps[0]!.expectRequests);
    }
    expect(j).toEqual(original);
  });
  it("requires a passing unmutated control before accepting the target failure", async () => {
    const { j, plan, m, target } = setup(); let controls = 0;
    const r = await runDeclaredTargetedProof(j, plan, m, target, j.metadata.targetedProofs![0]!, async (describe, kind) => {
      expect(describe(j).relaxedStepRequests).toEqual(["step-request:1:0"]);
      if (kind === "control") { controls++; return { outcome: "passed", failedSites: [] }; }
      return { outcome: "failed", failedSites: [{ where: "end-state", index: 0 }] };
    });
    expect(controls).toBe(1); expect(r.control).toBe("passed"); expect(r.refused).toBeUndefined();
  });
  it("refuses an unpaired request defense without replaying", async () => {
    const { j, plan, m, target } = setup(); let calls = 0;
    const r = await runDeclaredTargetedProof(j, { ...plan, pairs: plan.pairs.filter((p) => p.site !== "step-request:1:0") }, m, target, j.metadata.targetedProofs![0]!, async () => { calls++; return { outcome: "passed", failedSites: [] }; });
    expect(r.refused).toContain("not paired"); expect(calls).toBe(0);
  });
  it("refuses a failing control and an omitted request defense", async () => {
    const { j, plan, m, target } = setup();
    const r = await runDeclaredTargetedProof(j, plan, m, target, j.metadata.targetedProofs![0]!, async (_describe, kind) => kind === "control" ? { outcome: "failed", failedSites: [] } : { outcome: "failed", failedSites: [{ where: "end-state", index: 0 }] });
    expect(r.refused).toContain("control replay");
    const omitted = await runDeclaredTargetedProof(j, plan, m, target, j.metadata.targetedProofs![0]!, async () => ({ outcome: "failed", failedSites: [{ where: "step-request", step: 1, checkIndex: 1 }] }));
    expect(omitted.refused).toContain("step-request:1:1 blocked");
  });
  it.each(["step-request:1:4", "end-state:0", "step-request:99:0"])("refuses invalid declared relaxation %s", (key) => {
    const raw = fixture(false); raw.metadata.targetedProofs = [{ check: "end-state:0", mustFailWhen: "block-write:1", relax: [key] }];
    expect(JourneySchema.safeParse(raw).success).toBe(false);
  });
  it("never permits relaxing the target request itself", () => {
    const j = fixture(false); j.metadata.targetedProofs = [{ check: "step-request:1:0", mustFailWhen: "block-write:1", relax: ["step-request:1:0"] } satisfies JourneyTargetedProofPlan];
    expect(JourneySchema.safeParse(j).success).toBe(false);
  });
});
