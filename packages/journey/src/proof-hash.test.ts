import { expect, it } from "vitest";
import type { Journey } from "./journey.js";
import { journeyProofHash } from "./proof-hash.js";

/** #523 — the proof hash: prose never changes it, executable content always does. One assertion each. */

function journey(): Journey {
  return {
    metadata: {
      id: "buy-pro",
      name: "Buy the Pro plan",
      promoted: false,
      params: [],
      createdAtIso: "2026-10-01T00:00:00.000Z",
      goal: "Buy the Pro plan",
      persona: "buyer",
      job: "upgrade",
      successCriteria: [{ description: "The order is confirmed", check: { kind: "textIncludes", target: { role: "status" }, text: "Order confirmed" } }],
      endState: [{ kind: "page", assertion: { kind: "textIncludes", target: { testId: "plan" }, text: "Pro" } }],
      anchors: [{ name: "plans", step: 1, description: "On the plans page", region: "testId=plans" }],
    },
    recording: {
      version: "1.0.0",
      site: "https://shop.example.test",
      pages: [
        {
          url: "https://shop.example.test/plans",
          steps: [
            {
              step: { kind: "click", target: { role: "button", name: "Activate Pro", display: { name: "Activate Pro" } }, expect: { kind: "urlIncludes", text: "/done" } },
              stepId: "s-aaaaaa",
              objective: "Pay for the plan",
              expectedResult: "The order is confirmed",
            },
          ],
        },
      ],
    },
  };
}

const BASE = journeyProofHash(journey());

function edited(edit: (j: Journey) => void): string {
  const j = structuredClone(journey());
  edit(j);
  return journeyProofHash(j);
}

const step = (j: Journey) => j.recording.pages[0]!.steps[0]!;

it("a goal edit does not change the proof hash", () => {
  expect(edited((j) => { j.metadata.goal = "Upgrade to Pro"; })).toBe(BASE);
});

it("a success-criterion description edit does not change the proof hash", () => {
  expect(edited((j) => { j.metadata.successCriteria![0]!.description = "Pro is active"; })).toBe(BASE);
});

it("a step objective edit does not change the proof hash", () => {
  expect(edited((j) => { step(j).objective = "Activate the plan"; })).toBe(BASE);
});

it("a step expected-result edit does not change the proof hash", () => {
  expect(edited((j) => { step(j).expectedResult = "Pro is active"; })).toBe(BASE);
});

it("approval bookkeeping and catalog links do not change the proof hash", () => {
  expect(edited((j) => { j.metadata.promoted = true; j.metadata.approval = { contentHash: "a".repeat(64), at: "2026-10-03T00:00:00.000Z" }; j.metadata.job = "other"; j.metadata.persona = "admin"; })).toBe(BASE);
});

it("a target's display label does not change the proof hash", () => {
  expect(edited((j) => { const s = step(j).step; if (s.kind === "click") s.target.display = { name: "Activate" }; })).toBe(BASE);
});

it("a step target change changes the proof hash", () => {
  expect(edited((j) => { const s = step(j).step; if (s.kind === "click") s.target.name = "Buy Pro"; })).not.toBe(BASE);
});

it("a step assertion change changes the proof hash", () => {
  expect(edited((j) => { const s = step(j).step; if (s.kind === "click") s.expect = { kind: "urlIncludes", text: "/thanks" }; })).not.toBe(BASE);
});

it("an end-state change changes the proof hash", () => {
  expect(edited((j) => { j.metadata.endState = []; })).not.toBe(BASE);
});

it("a success-criterion check change changes the proof hash", () => {
  expect(edited((j) => { j.metadata.successCriteria![0]!.check = { kind: "urlIncludes", text: "/done" }; })).not.toBe(BASE);
});

it("an anchor region change changes the proof hash", () => {
  expect(edited((j) => { j.metadata.anchors![0]!.region = "testId=checkout"; })).not.toBe(BASE);
});

it("an unknown (future) field is included by default", () => {
  expect(edited((j) => { (j.metadata as unknown as Record<string, unknown>).futureCheck = true; })).not.toBe(BASE);
});

it("a success criterion added in words only (annotate, no check) does not change the proof hash", () => {
  expect(edited((j) => { j.metadata.successCriteria!.push({ description: "A receipt is emailed" }); })).toBe(BASE);
});
