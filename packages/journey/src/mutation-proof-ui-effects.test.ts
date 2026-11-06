import { describe, expect, it } from "vitest";
import type { RecordedStep } from "@jevitate/recording";
import { judgeAssertions, lintJourney, mutationProofVerdict, mutationReplay, mutationWriteMatches, planJourneyMutations, type Journey, type MutationRunResult } from "./index.js";

function journey(steps: RecordedStep[], endState: Journey["metadata"]["endState"] = []): Journey {
  return {
    metadata: { id: "ui-effects", name: "UI effects", promoted: false, params: [], createdAtIso: "2026-11-06T00:00:00Z", endState },
    recording: { version: "1", site: "http://localhost:3000", pages: [{ url: "/editor", steps }] },
  };
}

function click(target: string, requests: string[] = []): RecordedStep {
  return {
    step: { kind: "click", target: { testId: target }, expect: { kind: "valueEquals", target: { testId: "objective" }, value: "Improved" } },
    delta: { verdict: "relevant-change", why: "changed", changes: ["objective"], requests, overheadMs: 0 },
  };
}

describe("UI effects and known HTTP writes are distinct mutation candidates", () => {
  it("tests a local apply effect by skipping it without inventing an HTTP write", () => {
    expect(planJourneyMutations(journey([click("apply")])).mutations.map((m) => m.id)).toEqual(["skip:1"]);
  });

  it("tests opening a different dialog without a recorded request or delta", () => {
    const open: RecordedStep = { step: { kind: "click", target: { testId: "open" }, expect: { kind: "visible", target: { role: "dialog", name: "Review" } } } };
    expect(planJourneyMutations(journey([open])).mutations.map((m) => m.id)).toEqual(["skip:1"]);
  });

  it("does not generate a UI skip for an own-target visibility claim", () => {
    const own: RecordedStep = { step: { kind: "click", target: { testId: "open" }, expect: { kind: "visible", target: { testId: "open" } } } };
    expect(planJourneyMutations(journey([own])).mutations).toEqual([]);
  });

  it("does not lose a UI effect because its partial trace contains a GET", () => {
    expect(planJourneyMutations(journey([click("apply", ["GET /telemetry → 200"])] )).mutations.map((m) => m.id)).toEqual(["skip:1"]);
  });

  it.each([[], ["GET /telemetry → 200"], ["malformed"], ["unrecognized method"], Array.from({ length: 10 }, (_, i) => `GET /poll/${i} → 200`)])(
    "retains persistence uncertainty with incomplete request evidence %j",
    (requests) => {
      expect(lintJourney(journey([click("apply", requests)])).some((f) => f.rule === "no-persistence-check")).toBe(true);
    },
  );

  it.each(["202", "204", "302", "400", "500", "pending", "failed", "unknown"])("retains positively observed writes with status %s", (status) => {
    expect(planJourneyMutations(journey([click("start", [`POST /start → ${status}`])])).mutations.map((m) => m.id)).toEqual(["skip:1", "block-write:1"]);
  });

  it("pairs final response status with its unique originating request rather than a later local apply", () => {
    const j = journey([click("start", ["POST /start → 202"]), click("approve", ["POST /approve → 200"]), click("apply")], [
      { kind: "responseStatus", method: "POST", pathGlob: "/start", status: { class: 2 } },
    ]);
    expect(planJourneyMutations(j).pairs.filter((p) => p.site === "end-state:0").map((p) => p.mutation)).toEqual(["skip:1", "block-write:1"]);
  });

  it("pairs the applied field with the final UI action without inventing an HTTP block", () => {
    const j = journey([click("start", ["POST /start → 202"]), click("approve", ["POST /approve → 200"]), click("apply")], [
      { kind: "page", assertion: { kind: "valueEquals", target: { testId: "objective" }, value: "Improved" } },
    ]);
    expect(planJourneyMutations(j).pairs.filter((p) => p.site === "end-state:0").map((p) => p.mutation)).toEqual(["skip:3"]);
  });

  it("does not guess which step owns a response assertion when multiple steps match", () => {
    const j = journey([click("first", ["POST /start → 202"]), click("retry", ["POST /start → 202"])], [
      { kind: "responseStatus", method: "POST", pathGlob: "/start", status: { class: 2 } },
    ]);
    expect(planJourneyMutations(j).pairs.filter((p) => p.site === "end-state:0")).toEqual([]);
  });

  it("keeps an explicitly declared HTTP block even when applicability is unknown", () => {
    const j = journey([click("apply")]);
    j.metadata.mutationPairs = [{ check: "step:1", mustFailWhen: "block-write:1" }];
    expect(planJourneyMutations(j).pairs).toContainEqual({ site: "step:1", mutation: "block-write:1", declared: true });
  });

  it("passes a declared request matcher to replay without inventing a recorded request", () => {
    const j = journey([click("start")]);
    j.recording.pages[0]!.steps[0]!.expectRequests = [{ kind: "requestMade", method: "POST", pathGlob: "/api/jobs/*" }];
    const replay = mutationReplay(j, { id: "block-write:1", kind: "block-write", step: 1 });
    expect({ recorded: replay.blockRequests, matchers: replay.blockMatchers }).toEqual({ recorded: [], matchers: [{ method: "POST", pathGlob: "/api/jobs/*" }] });
  });

  it.each([
    [{ method: "POST", path: "/api/jobs/42" }, true],
    [{ method: "GET", path: "/api/jobs/42" }, false],
    [{ method: "POST", path: "/telemetry" }, false],
  ])("matches a declared HTTP mutation against the actual blocked request %j", (request, expected) => {
    expect(mutationWriteMatches({ method: "POST", pathGlob: "/api/jobs/*" }, request)).toBe(expected);
  });

  it("does not accept a blocked request on another origin for an absolute matcher", () => {
    expect(mutationWriteMatches({ method: "POST", pathGlob: "https://api.test/jobs/*" }, { method: "POST", path: "https://other.test/jobs/42" })).toBe(false);
  });

  it("does not let a single-segment declared glob match a nested telemetry path", () => {
    expect(mutationWriteMatches({ method: "POST", pathGlob: "/api/jobs/*" }, { method: "POST", path: "/api/jobs/42/telemetry" })).toBe(false);
  });

  it("does not interpret an observed literal star as a declared wildcard", () => {
    expect(mutationWriteMatches({ method: "POST", pathGlob: "/api/jobs/*", literal: true }, { method: "POST", path: "/api/jobs/42" })).toBe(false);
  });

  it("uses the oracle's brace-alternative matcher for declared blocked requests", () => {
    expect(mutationWriteMatches({ method: "POST", pathGlob: "/api/jobs/{a,b}" }, { method: "POST", path: "/api/jobs/a" })).toBe(true);
  });

  it("does not treat an embedded double star as a recursive path segment", () => {
    expect(mutationWriteMatches({ method: "POST", pathGlob: "/api/job**meta" }, { method: "POST", path: "/api/jobs/42/meta" })).toBe(false);
  });

  it("does not manufacture unique provenance by excluding a possible brace-alternative owner", () => {
    const second = click("other");
    second.expectRequests = [{ kind: "requestMade", method: "POST", pathGlob: "/api/jobs/{a,b}" }];
    const j = journey([click("first", ["POST /api/jobs/a → 200"]), second], [{ kind: "responseStatus", method: "POST", pathGlob: "/api/jobs/a", status: { class: 2 } }]);
    expect(planJourneyMutations(j).pairs.filter((p) => p.site === "end-state:0")).toEqual([]);
  });

  it("does not promote possible-only glob overlap into a positive originating-step match", () => {
    const action = click("other");
    action.expectRequests = [{ kind: "requestMade", method: "POST", pathGlob: "/unrelated/*" }];
    const j = journey([action], [{ kind: "responseStatus", method: "POST", pathGlob: "/api/jobs/*", status: { class: 2 } }]);
    expect(planJourneyMutations(j).pairs.filter((p) => p.site === "end-state:0")).toEqual([]);
  });

  it("preserves ambiguity when another step declares a glob that could own the same final response", () => {
    const second = click("retry");
    second.expectRequests = [{ kind: "requestMade", method: "POST", pathGlob: "/api/jobs/*" }];
    const j = journey([click("first", ["POST /api/jobs/42 → 200"]), second], [{ kind: "responseStatus", method: "POST", pathGlob: "/api/jobs/42", status: { class: 2 } }]);
    expect(planJourneyMutations(j).pairs.filter((p) => p.site === "end-state:0")).toEqual([]);
  });

  it("does not infer persistence ownership from a final local UI action", () => {
    const j = journey([click("start", ["POST /start → 202"]), click("apply")], [{ kind: "reloadThen", assertion: { kind: "valueEquals", target: { testId: "objective" }, value: "Improved" } }]);
    expect(planJourneyMutations(j).pairs.filter((p) => p.site === "end-state:0")).toEqual([]);
  });

  it("keeps an ambiguous network end-state inconclusive despite sensitive own-action checks", () => {
    const j = journey([click("first", ["POST /start → 202"]), click("retry", ["POST /start → 202"])], [{ kind: "responseStatus", method: "POST", pathGlob: "/start", status: { class: 2 } }]);
    const plan = planJourneyMutations(j);
    const results = new Map(plan.mutations.map((m) => [m.id, { outcome: "failed", failedSites: [{ where: "step", step: m.step, postcondition: true }] } as MutationRunResult]));
    expect(mutationProofVerdict({ basePassed: true, mutations: [...results.values()], assertions: judgeAssertions(j, plan, results) }).verdict).toBe("inconclusive");
  });

  describe("a checked UI action with no recorded write or change", () => {
    const local = (target: string): RecordedStep => ({ step: { kind: "click", target: { testId: target }, expect: { kind: "count", target: { css: "p.preview" }, min: 1 } } });
    const end: Journey["metadata"]["endState"] = [{ kind: "page", assertion: { kind: "textIncludes", target: { testId: "status" }, text: "done" } }];
    const passed: MutationRunResult = { outcome: "passed", failedSites: [] };

    it("never takes a final check as the last effect", () => {
      const plan = planJourneyMutations(journey([click("start", ["POST /start → 202"]), local("preview")], end));
      expect(plan.pairs.filter((p) => p.site === "end-state:0").map((p) => p.mutation)).toEqual(["skip:1", "block-write:1"]);
    });

    it("leaves its own check unpaired when the skip did not break it", () => {
      const j = journey([local("preview")]);
      const assertions = judgeAssertions(j, planJourneyMutations(j), new Map([["skip:1", passed]]));
      expect(assertions.find((a) => a.site === "step:1")?.verdict).toBe("unpaired");
    });

    it("leaves its own check unpaired when the run failed elsewhere", () => {
      const j = journey([local("preview")]);
      const assertions = judgeAssertions(j, planJourneyMutations(j), new Map([["skip:1", { outcome: "failed", failedSites: [{ where: "end-state", index: 0 }] } as MutationRunResult]]));
      expect(assertions.find((a) => a.site === "step:1")?.verdict).toBe("unpaired");
    });

    it("counts its own check as sensitive only when the skip really failed it", () => {
      const j = journey([local("preview")]);
      const assertions = judgeAssertions(j, planJourneyMutations(j), new Map([["skip:1", { outcome: "failed", failedSites: [{ where: "step", step: 1, postcondition: true }] } as MutationRunResult]]));
      expect(assertions.find((a) => a.site === "step:1")).toMatchObject({ verdict: "sensitive", provedBy: "skip:1" });
    });
  });

  describe("a final network check the block broke and the skip did not", () => {
    const j = journey([click("b", ["POST /api/sync → 200"])], [{ kind: "responseStatus", method: "POST", pathGlob: "/api/sync", status: { class: 2 } }]);
    const failedAtEnd: MutationRunResult = { outcome: "failed", failedSites: [{ where: "end-state", index: 0 }] };
    const passed: MutationRunResult = { outcome: "passed", failedSites: [] };
    const reading = (journeyUnderTest: Journey, skip: MutationRunResult): string | undefined =>
      judgeAssertions(journeyUnderTest, planJourneyMutations(journeyUnderTest), new Map([["skip:1", skip], ["block-write:1", failedAtEnd]])).find((a) => a.site === "end-state:0")?.verdict;

    it("is insensitive: the block aborted a request this step did not send", () => {
      expect(reading(j, passed)).toBe("insensitive");
    });

    it("stays sensitive when skip and block agree", () => {
      expect(reading(j, failedAtEnd)).toBe("sensitive");
    });

    it("stays sensitive when a person declared the block", () => {
      const declared = structuredClone(j);
      declared.metadata.mutationPairs = [{ check: "end-state:0", mustFailWhen: "block-write:1" }];
      expect(reading(declared, passed)).toBe("sensitive");
    });
  });

  it("does not read a read RPC named by a glob as a write", () => {
    const action = click("open");
    action.delta = undefined;
    action.step = { kind: "click", target: { testId: "open" }, expect: { kind: "urlIncludes", text: "" } };
    action.expectRequests = [{ kind: "requestMade", method: "POST", pathGlob: "/board.v1.Items/Get*" }];
    expect(planJourneyMutations(journey([action])).mutations).toEqual([]);
    action.expectRequests = [{ kind: "requestMade", method: "POST", pathGlob: "/board.v1.Items/*" }];
    expect(planJourneyMutations(journey([action])).mutations.map((m) => m.id)).toEqual(["skip:1", "block-write:1"]);
  });
});
