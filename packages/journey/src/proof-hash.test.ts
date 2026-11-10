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

// Captured from the built v6 planner before the reconciliation; the same executable Journey
// must invalidate that receipt when ownership/horizon/unresolved-request semantics advance.
it("does not reuse a v6 receipt under the reconciled planner", () => {
  const legacy: Journey = {
    metadata: { id: "legacy-v6", name: "Legacy v6", promoted: false, params: [], createdAtIso: "2026-11-06T00:00:00Z" },
    recording: { version: "1", site: "http://fixture.test", pages: [{ url: "/", steps: [{ step: { kind: "navigate", url: "/", expect: { kind: "urlIncludes", text: "/" } } }] }] },
  };
  expect(journeyProofHash(legacy)).not.toBe("f81b21658e36a8765169ba6737bcaf16eceb3300eee8f356a458cfdb679e2b85");
});

it("versions only final-network observation semantics while retaining159 UI and step-only hashes", () => {
  const page = journey();
  expect(journeyProofHash(page)).toBe('fd1d9f04a4b08bd3748ab7a7313567abccc4d2c0ce5dc0866676b5885fe59cbe');
  const stepOnly = journey(); delete stepOnly.metadata.endState;
  stepOnly.recording.pages[0]!.steps[0]!.expectRequests = [{ kind: "requestMade", method: "POST", pathGlob: "/api/save" }];
  expect(journeyProofHash(stepOnly)).toBe('79078bdca03794b12add30b1a582a2331fa18343834530050740b66817cbe0de');
  const request = journey(); request.metadata.endState = [{ kind: "requestMade", method: "POST", pathGlob: "/api/save" }];
  expect(journeyProofHash(request)).not.toBe('f15b82731e4e1151e4ebac08a6ff47bed66bba1ade4f1b964c788bdbfd0a2706');
  const response = journey(); response.metadata.endState = [{ kind: "responseStatus", method: "POST", pathGlob: "/api/save", status: { class: 2 } }];
  expect(journeyProofHash(response)).not.toBe('f41fc58ca0b7b55ccf45263c0c54337ac2732f12d3b293f7485e910a37b2efdb');
  const legacy = journey(); delete legacy.metadata.endState; legacy.metadata.networkChecks = [{ kind: "requestMade", method: "POST", pathGlob: "/api/save" }];
  expect(journeyProofHash(legacy)).not.toBe('81ee908aca4ab31b0447dfd5c630173327033023b1ae5bda21547dbb971d5e6a');
});
