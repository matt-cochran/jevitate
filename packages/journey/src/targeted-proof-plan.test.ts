import { describe, it, expect } from "vitest";
import {
  JourneySchema,
  MAX_DECLARED_RELAXATIONS,
  MAX_TARGETED_RELAXATIONS,
  assertionSiteKey,
  classifyMutation,
  journeyAssertions,
  journeyProofHash,
  judgeAssertions,
  planJourneyMutations,
  runDeclaredTargetedProof,
  suggestTargetedProofPlan,
  targetedProofPlanIssues,
  type Journey,
  type JourneyMutation,
  type JourneyTargetedProofPlan,
  type MutationFailedSite,
  type MutationPlan,
  type MutationRunResult,
  type TargetedProof,
} from "./index.js";

// #616 — a DECLARED, human-reviewable targeted-proof plan: a layered-defense Journey can name the
// earlier postconditions to relax so a late assertion is proven even when the automatic #609 proof
// (bounded at MAX_TARGETED_RELAXATIONS) cannot reach it.

/** Six steps all checking the same `threadId` param, plus an end-state check on it. */
function defaultSteps(): unknown[] {
  const click = (n: number) => ({
    step: {
      kind: "click",
      target: { role: "button", name: `Step ${n}` },
      expect: { kind: "attr", target: { testId: `badge-${n}` }, name: "data-threadid", value: { var: "threadId" } },
    },
  });
  return [
    {
      step: {
        kind: "select",
        target: { label: "Thread" },
        value: { var: "threadId" },
        expect: { kind: "attr", target: { testId: "badge-1" }, name: "data-threadid", value: { var: "threadId" } },
      },
    },
    click(2),
    click(3),
    click(4),
    click(5),
    click(6),
  ];
}

function journeyObject(steps: unknown[], metadata: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    metadata: {
      id: "layered",
      name: "Layered defense",
      promoted: false,
      params: ["threadId"],
      createdAtIso: "2026-10-17T00:00:00Z",
      endState: [{ kind: "page", assertion: { kind: "valueEquals", target: { testId: "thread" }, value: { var: "threadId" } } }],
      ...metadata,
    },
    recording: { version: "1", site: "http://localhost:3000", pages: [{ url: "/threads", steps }] },
  };
}

const parsed = (): Journey => JourneySchema.parse(journeyObject(defaultSteps()));

const plan = (): MutationPlan => planJourneyMutations(parsed(), { params: { threadId: "T-1042" } });
const swap = (): JourneyMutation => plan().mutations.find((m) => m.id === "swap-param:threadId")!;
const endStateSite = () => journeyAssertions(parsed()).find((s) => assertionSiteKey(s) === "end-state:0")!;
const relaxFive = ["step:1", "step:2", "step:3", "step:4", "step:5"];

/** The parse issues at exactly one metadata.targetedProofs path. */
function issuesAt(raw: Record<string, unknown>, path: readonly (string | number)[]): string[] {
  const result = JourneySchema.safeParse(raw);
  return result.success ? [] : result.error.issues.filter((i) => JSON.stringify(i.path) === JSON.stringify(path)).map((i) => i.message);
}

const withPlan = (plan: JourneyTargetedProofPlan, steps: unknown[] = defaultSteps()) => journeyObject(steps, { targetedProofs: [plan] });

describe("#616 targetedProofs schema", () => {
  it("parses a plan relaxing five earlier postconditions for a late end-state assertion", () => {
    const result = JourneySchema.safeParse(withPlan({ check: "end-state:0", mustFailWhen: "swap-param:threadId", relax: relaxFive }));
    expect(result.success).toBe(true);
  });

  it("issues at the check path for an unknown assertion site", () => {
    expect(issuesAt(withPlan({ check: "end-state:9", mustFailWhen: "swap-param:threadId", relax: ["step:1"] }), ["metadata", "targetedProofs", 0, "check"])).toHaveLength(1);
  });

  it("issues at the mustFailWhen path for a mutation that does not resolve", () => {
    expect(issuesAt(withPlan({ check: "end-state:0", mustFailWhen: "swap-param:missing", relax: ["step:1"] }), ["metadata", "targetedProofs", 0, "mustFailWhen"])).toHaveLength(1);
  });

  it("issues at the relax path for an entry that is not a step site", () => {
    expect(issuesAt(withPlan({ check: "end-state:0", mustFailWhen: "swap-param:threadId", relax: ["step-request:1:0"] }), ["metadata", "targetedProofs", 0, "relax"])).toHaveLength(1);
  });

  it("issues at the relax path for a step the Journey does not have", () => {
    expect(issuesAt(withPlan({ check: "end-state:0", mustFailWhen: "swap-param:threadId", relax: ["step:99"] }), ["metadata", "targetedProofs", 0, "relax"])).toHaveLength(1);
  });

  it("issues at the relax path for a handback resume step", () => {
    const steps = [
      defaultSteps()[0]!,
      { step: { kind: "handback", prompt: "Sign in", resume: { kind: "visible", target: { role: "heading", name: "Inbox" } } } },
      ...defaultSteps().slice(1),
    ];
    expect(issuesAt(withPlan({ check: "end-state:0", mustFailWhen: "swap-param:threadId", relax: ["step:2"] }, steps), ["metadata", "targetedProofs", 0, "relax"])).toHaveLength(1);
  });

  it("issues at the relax path for a step with no page postcondition", () => {
    const steps = [
      defaultSteps()[0]!,
      { step: { kind: "waitFor", target: { testId: "spinner" }, state: "hidden" } },
      ...defaultSteps().slice(1),
    ];
    expect(issuesAt(withPlan({ check: "end-state:0", mustFailWhen: "swap-param:threadId", relax: ["step:2"] }, steps), ["metadata", "targetedProofs", 0, "relax"])).toHaveLength(1);
  });

  it("issues at the relax path for a relax that is not before a step target", () => {
    expect(issuesAt(withPlan({ check: "step:3", mustFailWhen: "swap-param:threadId", relax: ["step:5"] }), ["metadata", "targetedProofs", 0, "relax"])).toHaveLength(1);
  });

  it("issues at the relax path for a relax equal to a step target", () => {
    expect(issuesAt(withPlan({ check: "step:3", mustFailWhen: "swap-param:threadId", relax: ["step:3"] }), ["metadata", "targetedProofs", 0, "relax"])).toHaveLength(1);
  });

  it("issues at the relax path for a duplicated relax entry", () => {
    expect(issuesAt(withPlan({ check: "end-state:0", mustFailWhen: "swap-param:threadId", relax: ["step:1", "step:1"] }), ["metadata", "targetedProofs", 0, "relax"])).toHaveLength(1);
  });

  it("issues at the relax path for a relax longer than the declared bound", () => {
    const tooMany = ["step:1", "step:2", "step:3", "step:4", "step:5", "step:6", "step:7", "step:8", `step:${MAX_DECLARED_RELAXATIONS + 1}`];
    expect(issuesAt(withPlan({ check: "end-state:0", mustFailWhen: "swap-param:threadId", relax: tooMany }), ["metadata", "targetedProofs", 0, "relax"]).length).toBeGreaterThan(0);
  });

  it("issues at the check path for two plans with the same check and mutation", () => {
    const raw = journeyObject(defaultSteps(), {
      targetedProofs: [
        { check: "end-state:0", mustFailWhen: "swap-param:threadId", relax: ["step:1"] },
        { check: "end-state:0", mustFailWhen: "swap-param:threadId", relax: ["step:1"] },
      ],
    });
    expect(issuesAt(raw, ["metadata", "targetedProofs", 1, "check"])).toHaveLength(1);
  });

  it("reports no plan issues for a plan relaxing five earlier postconditions", () => {
    const journey = parsed();
    journey.metadata.targetedProofs = [{ check: "end-state:0", mustFailWhen: "swap-param:threadId", relax: relaxFive }];
    expect(targetedProofPlanIssues(journey)).toEqual([]);
  });
});

/** A declared plan whose every relax site is paired with the mutation. */
const declared = { check: "end-state:0", mustFailWhen: "swap-param:threadId", relax: relaxFive } satisfies JourneyTargetedProofPlan;

describe("#616 runDeclaredTargetedProof", () => {
  const run = (
    replayResult: { outcome: MutationRunResult["outcome"]; failedSites: readonly MutationFailedSite[] },
    controlOutcome: MutationRunResult["outcome"] = "passed",
    declared: JourneyTargetedProofPlan = { check: "end-state:0", mustFailWhen: "swap-param:threadId", relax: relaxFive },
    p: MutationPlan = plan(),
  ) =>
    runDeclaredTargetedProof(parsed(), p, swap(), endStateSite(), declared, async (_describe, kind) =>
      kind === "control" ? { outcome: controlOutcome, failedSites: [] } : replayResult,
    );

  it("runs the targeted replay and, on a sensitive target, exactly one passing control replay", async () => {
    let calls = 0;
    await runDeclaredTargetedProof(parsed(), plan(), swap(), endStateSite(), declared, async (_describe, kind) => {
      calls += 1;
      return kind === "control" ? { outcome: "passed", failedSites: [] } : { outcome: "failed", failedSites: [{ where: "end-state", index: 0 }] };
    });
    expect(calls).toBe(2);
  });

  it("marks the returned proof as declared", async () => {
    const proof = await run({ outcome: "failed", failedSites: [{ where: "end-state", index: 0 }] });
    expect(proof.declared).toBe(true);
  });

  it("returns the declared relax list as the proof's relaxed sites", async () => {
    const proof = await run({ outcome: "failed", failedSites: [{ where: "end-state", index: 0 }] });
    expect(proof.relaxedSites).toEqual(relaxFive);
  });

  it("classifies the target as sensitive when it failed and the control passed", async () => {
    const proof = await run({ outcome: "failed", failedSites: [{ where: "end-state", index: 0 }] });
    expect(classifyMutation(endStateSite(), swap(), { outcome: proof.outcome, failedSites: proof.failedSites })).toBe("sensitive");
  });

  it("refuses without calling replay when a relax site is not paired with the mutation", async () => {
    let calls = 0;
    const unpaired: MutationPlan = { mutations: [swap()], pairs: [{ site: "end-state:0", mutation: swap().id }] };
    await runDeclaredTargetedProof(parsed(), unpaired, swap(), endStateSite(), declared, async () => {
      calls += 1;
      return { outcome: "failed", failedSites: [] };
    });
    expect(calls).toBe(0);
  });

  it("names the unpaired relax site when it refuses", async () => {
    const unpaired: MutationPlan = { mutations: [swap()], pairs: [{ site: "end-state:0", mutation: swap().id }] };
    const proof = await run({ outcome: "failed", failedSites: [] }, "passed", declared, unpaired);
    expect(proof.refused).toContain("step:1 is not paired with swap-param:threadId");
  });

  it("refuses when the control replay does not pass", async () => {
    const proof = await run({ outcome: "failed", failedSites: [{ where: "end-state", index: 0 }] }, "failed");
    expect(proof.refused).toContain("did not pass (failed)");
  });

  it("refuses naming the site when an undeclared earlier postcondition blocks the replay", async () => {
    const blocked = { check: "end-state:0", mustFailWhen: "swap-param:threadId", relax: ["step:2"] } satisfies JourneyTargetedProofPlan;
    const proof = await run({ outcome: "failed", failedSites: [{ where: "step", step: 3, postcondition: true }] }, "passed", blocked);
    expect(proof.refused).toBe("step:3 blocked the declared proof (not in relax)");
  });
});

describe("#616 declared-proof summary soundness", () => {
  it("keeps the target a cascade when a relaxed site is not itself proven sensitive to the mutation", () => {
    const m = swap();
    const proof: TargetedProof = {
      site: "end-state:0",
      relaxedSites: ["step:5"],
      outcome: "failed",
      failedSites: [{ where: "end-state", index: 0 }],
      control: "passed",
      declared: true,
    };
    const result: MutationRunResult = { outcome: "failed", failedSites: [{ where: "end-state", index: 0 }], targeted: [proof] };
    const judged = judgeAssertions(parsed(), plan(), new Map([[m.id, result]])).find((a) => a.site === "end-state:0");
    expect(judged).toEqual({ site: "end-state:0", verdict: "cascade", targetedRefusal: "relaxed site step:5 is not itself proven sensitive to swap-param:threadId" });
  });
});

describe("#616 suggestTargetedProofPlan", () => {
  const m = swap();

  it("returns the relaxed sites plus the blocking step for an automatic bound refusal", () => {
    const proof: TargetedProof = {
      site: "end-state:0",
      relaxedSites: ["step:1", "step:2", "step:3", "step:4"],
      outcome: "failed",
      failedSites: [{ where: "step", step: 5, postcondition: true }],
      refused: `relaxation bound ${MAX_TARGETED_RELAXATIONS} reached`,
    };
    expect(suggestTargetedProofPlan(proof, m)).toEqual({ check: "end-state:0", mustFailWhen: "swap-param:threadId", relax: [...proof.relaxedSites, "step:5"] });
  });

  it("returns null for a refusal that is not the automatic bound", () => {
    const proof: TargetedProof = {
      site: "end-state:0",
      relaxedSites: [],
      outcome: "failed",
      failedSites: [{ where: "step", step: 5, postcondition: true }],
      refused: "step:5 is not paired with swap-param:threadId",
    };
    expect(suggestTargetedProofPlan(proof, m)).toBeNull();
  });
});

describe("#616 proof hash", () => {
  it("changes when only metadata.targetedProofs changes", () => {
    const without = parsed();
    const withDeclared = parsed();
    withDeclared.metadata.targetedProofs = [{ check: "end-state:0", mustFailWhen: "swap-param:threadId", relax: ["step:1"] }];
    expect(journeyProofHash(withDeclared)).not.toBe(journeyProofHash(without));
  });
});
