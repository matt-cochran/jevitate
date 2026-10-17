import { describe, it, expect } from "vitest";
import type { RecordedStep, Step } from "@jevitate/recording";
import {
  JourneySchema,
  classifyMutation,
  journeyAssertions,
  judgeAssertions,
  mutationProofVerdict,
  mutationReplay,
  relaxedMutationReplay,
  planJourneyMutations,
  assertionSiteKey,
  type Journey,
  type JourneyMutation,
  type MutationRunResult,
} from "./index.js";

// #565 — `journey verify --mutate` proves parameter-relative checks: a non-secret parameter an
// assertion names is swapped and truncated where the app receives it (the assertion still expects
// the supplied value), and a `{ var }` fill gets a stale-value that types an altered value.

const REPLY = "Thanks, see you Monday";
const TOKEN = "tok-SEKRET-123";
const params = { reply: REPLY, apiToken: TOKEN };

/** navigate, fill the API token (secret), fill the composer from `reply`, preview; end state names ${reply}. */
function composeJourney(): Journey {
  const steps: RecordedStep[] = [
    { step: { kind: "navigate", url: "/compose", expect: { kind: "visible", target: { role: "heading", name: "Compose" } } } },
    { step: { kind: "fill", target: { label: "Token" }, value: { var: "apiToken" }, expect: { kind: "count", target: { label: "Token" }, min: 0 } } },
    {
      variableName: "reply",
      step: { kind: "fill", target: { label: "Reply" }, value: { var: "reply" }, expect: { kind: "valueEquals", target: { label: "Reply" }, value: { var: "reply" } } },
    },
    { step: { kind: "click", target: { role: "button", name: "Preview" }, expect: { kind: "count", target: { css: "p.preview" }, min: 1 } } },
  ];
  return JourneySchema.parse({
    metadata: {
      id: "compose",
      name: "Compose a reply",
      promoted: false,
      params: ["reply"],
      parameters: [{ name: "apiToken", secret: true }],
      createdAtIso: "2026-10-17T00:00:00Z",
      endState: [{ kind: "page", assertion: { kind: "textIncludes", target: { css: "p.preview" }, text: "Reply: ${reply}" } }],
    },
    recording: { version: "1", site: "http://localhost:3000", pages: [{ url: "/compose", steps }] },
  });
}

const plan = () => planJourneyMutations(composeJourney(), { params });
const pairedSites = (id: string): string[] =>
  plan()
    .pairs.filter((p) => p.mutation === id)
    .map((p) => p.site)
    .sort();
const mutationById = (id: string): JourneyMutation => plan().mutations.find((m) => m.id === id)!;
const stepAt = (j: Journey, n: number): Step => j.recording.pages[0]!.steps[n - 1]!.step;
const siteByKey = (key: string) => journeyAssertions(composeJourney()).find((s) => assertionSiteKey(s) === key)!;

const failedAtFill: MutationRunResult = {
  outcome: "failed",
  failedSites: [{ where: "step", step: 3, postcondition: true }],
  relaxed: { outcome: "failed", failedSites: [{ where: "end-state", index: 0 }] },
};
const passed: MutationRunResult = { outcome: "passed", failedSites: [] };

describe("#565 planJourneyMutations: parameter-relative checks", () => {
  it("swaps a non-secret parameter an assertion names", () => {
    expect(plan().mutations.map((m) => m.id)).toContain("swap-param:reply");
  });

  it("truncates a non-secret parameter an assertion names", () => {
    expect(plan().mutations.map((m) => m.id)).toContain("truncate-param:reply");
  });

  it("a param mutation takes effect at the first step whose action reads the parameter", () => {
    expect(mutationById("swap-param:reply").step).toBe(3);
  });

  it("pairs the swap with every assertion that names the parameter", () => {
    expect(pairedSites("swap-param:reply")).toEqual(["end-state:0", "step:3"]);
  });

  it("pairs the truncation with every assertion that names the parameter", () => {
    expect(pairedSites("truncate-param:reply")).toEqual(["end-state:0", "step:3"]);
  });

  it("pairs a {var} fill's stale-value with the end-state check naming its variable", () => {
    expect(pairedSites("stale-value:3")).toEqual(["end-state:0", "step:3"]);
  });

  it("never mutates a secret parameter", () => {
    expect(plan().mutations.filter((m) => m.param === "apiToken" || m.step === 2)).toEqual([]);
  });

  it("derives no param mutation when the parameter's value is not supplied", () => {
    expect(planJourneyMutations(composeJourney()).mutations.filter((m) => m.param !== undefined)).toEqual([]);
  });

  it("the serialized plan never carries a parameter's value", () => {
    expect(JSON.stringify(plan())).not.toMatch(/Monday|SEKRET/);
  });
});

describe("#565 mutationReplay: a param mutation alters params, not the recording's claims", () => {
  it("a swap replays with the parameter altered (no other parameter of its shape)", () => {
    expect(mutationReplay(composeJourney(), mutationById("swap-param:reply"), { params }).params?.reply).toBe("Thanks, see you Mondaz");
  });

  it("a swap prefers another supplied parameter of the same shape", () => {
    const j = composeJourney();
    j.metadata.params = ["reply", "other"];
    const others = { ...params, reply: "a@example.test", other: "b@example.test" };
    const m = planJourneyMutations(j, { params: others }).mutations.find((x) => x.id === "swap-param:reply")!;
    expect(mutationReplay(j, m, { params: others }).params?.reply).toBe("b@example.test");
  });

  it("a truncation replays with the parameter's tail dropped", () => {
    expect(mutationReplay(composeJourney(), mutationById("truncate-param:reply"), { params }).params?.reply).toBe("Thanks, see");
  });

  it("a param replay keeps the secret parameter's supplied value for the run", () => {
    expect(mutationReplay(composeJourney(), mutationById("swap-param:reply"), { params }).params?.apiToken).toBe(TOKEN);
  });

  it("the end-state check still expects the supplied value", () => {
    const j = mutationReplay(composeJourney(), mutationById("swap-param:reply"), { params }).journey;
    expect(j.metadata.endState?.[0]).toMatchObject({ assertion: { text: `Reply: ${REPLY}` } });
  });

  it("the composer check still expects exactly the supplied value", () => {
    const j = mutationReplay(composeJourney(), mutationById("swap-param:reply"), { params }).journey;
    expect(stepAt(j, 3)).toMatchObject({ expect: { kind: "valueEquals", value: REPLY } });
  });

  it("a relaxed param replay leaves the reading step a weak claim on its own target", () => {
    const j = relaxedMutationReplay(composeJourney(), mutationById("swap-param:reply"), { params }).journey;
    expect(stepAt(j, 3)).toMatchObject({ expect: { kind: "visible", target: { label: "Reply" } } });
  });

  it("a {var} fill's stale-value types an altered value of the parameter", () => {
    const j = mutationReplay(composeJourney(), mutationById("stale-value:3"), { params }).journey;
    expect(stepAt(j, 3)).toMatchObject({ value: { redacted: false, value: "Thanks, see you Mondaz" } });
  });

  it("no mutated recording carries the secret parameter's value", () => {
    const journeys = plan().mutations.flatMap((m) => [mutationReplay(composeJourney(), m, { params }).journey, relaxedMutationReplay(composeJourney(), m, { params }).journey]);
    expect(JSON.stringify(journeys)).not.toContain(TOKEN);
  });
});

describe("#565 classification and verdict of parameter-relative checks", () => {
  it("the end-state check is sensitive when the swapped replay fails there (on the relaxed replay)", () => {
    expect(classifyMutation(siteByKey("end-state:0"), mutationById("swap-param:reply"), failedAtFill)).toBe("sensitive");
  });

  it("the composer check is sensitive when the swapped replay fails at its postcondition", () => {
    expect(classifyMutation(siteByKey("step:3"), mutationById("swap-param:reply"), failedAtFill)).toBe("sensitive");
  });

  it("the end-state check is insensitive when the page ignores the parameter", () => {
    const ignored: MutationRunResult = { ...failedAtFill, relaxed: { outcome: "passed", failedSites: [] } };
    expect(classifyMutation(siteByKey("end-state:0"), mutationById("swap-param:reply"), ignored)).toBe("insensitive");
  });

  it("the proof is proven when every param mutation breaks its checks", () => {
    const p = plan();
    const results = new Map(p.mutations.map((m) => [m.id, failedAtFill]));
    const assertions = judgeAssertions(composeJourney(), p, results);
    expect(mutationProofVerdict({ basePassed: true, mutations: [...results.values()], assertions }).verdict).toBe("proven");
  });

  it("the proof is insensitive when the param mutations leave the end state passing", () => {
    const p = plan();
    const ignored: MutationRunResult = { ...failedAtFill, relaxed: passed };
    const results = new Map(p.mutations.map((m) => [m.id, ignored]));
    const assertions = judgeAssertions(composeJourney(), p, results);
    expect(mutationProofVerdict({ basePassed: true, mutations: [...results.values()], assertions }).verdict).toBe("insensitive");
  });
});
