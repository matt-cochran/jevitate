import { describe, it, expect } from "vitest";
import type { Recording } from "@jevitate/recording";
import { JourneySchema, journeyAssertions, journeyEndState, isOwnTargetVisible, isNoClaimExpect, type Journey } from "./index.js";

const meta = { id: "publish", name: "Publish", promoted: false, params: [], createdAtIso: "2026-10-07T00:00:00Z" };

const recording: Recording = {
  version: "1",
  site: "http://localhost:3000",
  pages: [
    {
      url: "/editor",
      steps: [
        { step: { kind: "navigate", url: "/editor", expect: { kind: "urlIncludes", text: "/editor" } } },
        {
          step: { kind: "click", target: { testId: "publish" }, expect: { kind: "textIncludes", target: { role: "status" }, text: "Published" } },
          expectRequests: [{ kind: "responseStatus", method: "POST", pathGlob: "/portal.v1.OwnerSiteEditService/PublishSiteEdits", status: { class: 2 } }],
        },
        { step: { kind: "assert", check: { kind: "visible", target: { text: "Live" } } } },
      ],
    },
  ],
};

describe("#400 Journey outcome assertions (schema)", () => {
  it("accepts every success-check kind as an end-state assertion", () => {
    const j = {
      metadata: {
        ...meta,
        endState: [
          { kind: "page", assertion: { kind: "textIncludes", target: { css: "main" }, text: "Hello" } },
          { kind: "page", assertion: { kind: "valueEquals", target: { label: "Title" }, value: "Hi" } },
          { kind: "page", assertion: { kind: "count", target: { role: "listitem" }, min: 2 } },
          { kind: "page", assertion: { kind: "attr", target: { testId: "x" }, name: "aria-busy", absent: true } },
          { kind: "page", assertion: { kind: "flashed", target: { role: "status" }, className: "toast" } },
          { kind: "reloadThen", assertion: { kind: "textIncludes", target: { css: "main" }, text: "Hello" } },
          { kind: "requestMade", method: "POST", pathGlob: "/api/save" },
          { kind: "responseStatus", method: "POST", pathGlob: "/api/save", status: { class: 2 } },
          { kind: "responseStatus", method: "PUT", pathGlob: "/api/x/*", status: { code: 204 } },
        ],
      },
      recording,
    };
    expect(JourneySchema.safeParse(j).success).toBe(true);
  });

  it("accepts a step's expectRequests and refuses a page/reloadThen check there", () => {
    expect(JourneySchema.safeParse({ metadata: meta, recording }).success).toBe(true);
    const bad = structuredClone(recording) as unknown as { pages: { steps: Record<string, unknown>[] }[] };
    bad.pages[0]!.steps[1]!.expectRequests = [{ kind: "reloadThen", assertion: { kind: "visible", target: { text: "x" } } }];
    expect(JourneySchema.safeParse({ metadata: meta, recording: bad }).success).toBe(false);
  });

  it("still loads a pre-#400 Journey (networkChecks, no endState, no expectRequests)", () => {
    const old = {
      metadata: { ...meta, networkChecks: [{ kind: "requestMade", method: "POST", pathGlob: "/api/save" }] },
      recording: { version: "1", site: "x", pages: [{ url: "/", steps: [{ step: { kind: "click", target: { testId: "a" }, expect: { kind: "visible", target: { testId: "a" } } } }] }] },
    };
    expect(JourneySchema.safeParse(old).success).toBe(true);
  });

  it("refuses an unknown end-state kind", () => {
    const j = { metadata: { ...meta, endState: [{ kind: "eventually", assertion: { kind: "visible", target: { text: "x" } } }] }, recording };
    expect(JourneySchema.safeParse(j).success).toBe(false);
  });
});

describe("#400 journeyAssertions / journeyEndState (the #401 lint and #402 mutate hooks)", () => {
  const journey: Journey = {
    metadata: {
      ...meta,
      endState: [{ kind: "reloadThen", assertion: { kind: "textIncludes", target: { css: "main" }, text: "Hello" } }],
      networkChecks: [{ kind: "requestMade", method: "POST", pathGlob: "/api/legacy" }],
    },
    recording,
  };

  it("lists every assertion with the 1-based step it belongs to, then the end state (endState, then legacy networkChecks)", () => {
    const sites = journeyAssertions(journey);
    expect(sites.map((s) => [s.where, "step" in s ? s.step : s.index, s.check.kind])).toEqual([
      ["step", 1, "page"],
      ["step", 2, "page"],
      ["step-request", 2, "responseStatus"],
      ["step", 3, "page"],
      ["end-state", 0, "reloadThen"],
      ["end-state", 1, "requestMade"],
    ]);
    expect(sites[0]).toMatchObject({ field: "expect" });
    expect(sites[3]).toMatchObject({ field: "check" });
    expect(sites[5]).toMatchObject({ source: "networkChecks" });
  });

  it("journeyEndState merges endState and the legacy networkChecks, endState first", () => {
    expect(journeyEndState(journey).map((c) => c.kind)).toEqual(["reloadThen", "requestMade"]);
    expect(journeyEndState({ metadata: meta, recording })).toEqual([]);
  });

  it("isOwnTargetVisible spots the vacuous 'my own target is visible' expect, key order aside", () => {
    expect(isOwnTargetVisible({ kind: "click", target: { role: "button", name: "Publish" }, expect: { kind: "visible", target: { name: "Publish", role: "button" } } })).toBe(true);
    expect(isOwnTargetVisible({ kind: "click", target: { testId: "publish" }, expect: { kind: "visible", target: { testId: "other" } } })).toBe(false);
    expect(isOwnTargetVisible({ kind: "navigate", url: "/", expect: { kind: "urlIncludes", text: "/" } })).toBe(false);
  });

  it("isNoClaimExpect spots the explicit 'no claim' postconditions (count min 0, urlIncludes \"\")", () => {
    expect(isNoClaimExpect({ kind: "click", target: { testId: "a" }, expect: { kind: "count", target: { testId: "a" }, min: 0 } })).toBe(true);
    expect(isNoClaimExpect({ kind: "click", target: { testId: "a" }, expect: { kind: "urlIncludes", text: "" } })).toBe(true);
    expect(isNoClaimExpect({ kind: "click", target: { testId: "a" }, expect: { kind: "count", target: { testId: "a" }, min: 1 } })).toBe(false);
  });
});
