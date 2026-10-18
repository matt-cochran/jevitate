import { describe, it, expect } from "vitest";
import type { RecordedStep } from "@jevitate/recording";
import { classifyMutation, journeyAssertions, mutationReplay, planJourneyMutations, type Journey } from "./index.js";

// #580: an assertion that compares the page with an INPUT before any action reads it (or with an
// assertion-only input) is a guard: a `guard-param` gives the whole run a wrong value and the guard
// must refuse it at its own step. A swap pinned to the supplied value never pairs with it.
const heading = { kind: "visible" as const, target: { role: "heading" as const, name: "Thread" } };
const steps: RecordedStep[] = [
  { step: { kind: "navigate", url: "/c/${commentId}", expect: heading } },
  { step: { kind: "assert", check: { kind: "attr", target: { testId: "source" }, name: "data-id", value: { var: "expected_commentid" } } } },
  { step: { kind: "assert", check: { kind: "attr", target: { testId: "source" }, name: "data-account", value: { var: "who" } } } },
  { step: { kind: "select", target: { label: "Who" }, value: { var: "who" }, expect: { kind: "valueEquals", target: { label: "Who" }, value: { var: "who" } } } },
];
const journey: Journey = {
  metadata: {
    id: "guard",
    name: "Guard",
    promoted: false,
    params: ["commentId", "expected_commentid", "who"],
    parameters: [{ name: "who", mutationValues: ["mcpl", "personal"] }],
    createdAtIso: "2026-10-18T00:00:00Z",
  },
  recording: { version: "1", site: "http://127.0.0.1", pages: [{ url: "/c", steps }] },
};
const params = { commentId: "c-1", expected_commentid: "c-1", who: "mcpl" };
const plan = planJourneyMutations(journey, { params });
const pairedWith = (id: string) => plan.pairs.filter((p) => p.mutation === id).map((p) => p.site);

describe("#580 guard-param", () => {
  it("plans a guard for an assertion-only input", () => {
    expect(pairedWith("guard-param:expected_commentid")).toEqual(["step:2"]);
  });

  it("plans a guard for a check that runs before the action reads the input", () => {
    expect(pairedWith("guard-param:who")).toEqual(["step:3"]);
  });

  it("pairs the swap only with the checks at or after the action", () => {
    expect(pairedWith("swap-param:who")).toEqual(["step:4"]);
  });

  it("gives the whole run a wrong input without pinning the guard", () => {
    const m = plan.mutations.find((x) => x.id === "guard-param:who")!;
    expect(mutationReplay(journey, m, { params })).toEqual({ journey, params: { ...params, who: "personal" } });
  });

  it("names a reviewed source when the input has reviewed values", () => {
    expect(plan.mutations.find((x) => x.id === "guard-param:who")?.source).toBe("reviewed");
  });

  it("counts a guard that fails at its own step as sensitive", () => {
    const m = plan.mutations.find((x) => x.id === "guard-param:expected_commentid")!;
    const site = journeyAssertions(journey).find((s) => s.where === "step" && s.step === 2)!;
    expect(classifyMutation(site, m, { outcome: "failed", failedSites: [{ where: "step", step: 2, postcondition: true }] })).toBe("sensitive");
  });

  it("never plans a guard for a secret input", () => {
    const secret: Journey = { ...journey, metadata: { ...journey.metadata, parameters: [{ name: "expected_commentid", secret: true }] } };
    expect(planJourneyMutations(secret, { params }).mutations.map((m) => m.id)).not.toContain("guard-param:expected_commentid");
  });
});
