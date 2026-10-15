import { describe, expect, it } from "vitest";
import type { HttpCheck, RecordedStep } from "@jevitate/recording";
import { assertionSiteKey, classifyMutation, journeyAssertions, planJourneyMutations, type Journey } from "./index.js";

// #543 — an `http` end-state check under the mutation proof: no rule change, but its failure must
// prove the skipped write, and a probe that got no answer must never count as proof.

const outbox: HttpCheck = { kind: "http", method: "GET", url: "http://localhost:8025/api/messages", json: [{ path: "$.total", op: "equals", value: "1" }] };
const write: RecordedStep = {
  step: { kind: "click", target: { testId: "send" } },
  delta: { verdict: "relevant-change", why: "sent", changes: ["status"], requests: ["POST /api/reset → 202"], overheadMs: 1 },
};
const journey: Journey = {
  metadata: { id: "reset", name: "Reset", promoted: false, params: [], createdAtIso: "2026-10-15T00:00:00Z", endState: [outbox] },
  recording: { version: "1", site: "http://localhost:3000", pages: [{ url: "/forgot", steps: [write] }] },
};
const site = journeyAssertions(journey).find((s) => s.where === "end-state")!;
const skip = planJourneyMutations(journey).mutations.find((m) => m.kind === "skip")!;

describe("#543 mutation proof over an http end-state check", () => {
  it("pairs the last write's skip with the http end-state check", () => {
    expect(planJourneyMutations(journey).pairs.some((p) => p.site === assertionSiteKey(site) && p.mutation === skip.id)).toBe(true);
  });

  it("is sensitive when the skipped write leaves the http check failing", () => {
    expect(classifyMutation(site, skip, { outcome: "failed", failedSites: [{ where: "end-state", index: 0 }] })).toBe("sensitive");
  });

  it("is a cascade, never proof, when the http check was unevaluable", () => {
    expect(classifyMutation(site, skip, { outcome: "failed", failedSites: [{ where: "unevaluable" }] })).toBe("cascade");
  });
});
