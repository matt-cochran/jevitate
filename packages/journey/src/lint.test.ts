import { describe, it, expect } from "vitest";
import type { Recording, RecordedStep } from "@jevitate/recording";
import { lintJourney, type Journey } from "./index.js";

// #401 Part A — the pure assertion-strength lint. Fixtures are small inline Journeys (see
// assertions.test.ts / journey.test.ts for the shape).

const meta = { id: "lint", name: "Lint", promoted: false, params: [], createdAtIso: "2026-10-07T00:00:00Z" };

function rec(steps: RecordedStep[]): Recording {
  return { version: "1", site: "http://localhost:3000", pages: [{ url: "/editor", steps }] };
}

function j(steps: RecordedStep[], metadata: Partial<Journey["metadata"]> = {}): Journey {
  return { metadata: { ...meta, ...metadata }, recording: rec(steps) };
}

const publishWrite = ["POST /portal.v1.OwnerSiteEditService/PublishSiteEdits → 200"];
const publishResponse = [{ kind: "responseStatus", method: "POST", pathGlob: "/portal.v1.OwnerSiteEditService/PublishSiteEdits", status: { class: 2 } }] as const;
const reloadThen = [{ kind: "reloadThen", assertion: { kind: "textIncludes", target: { testId: "live" }, text: "published" } }] as const;

describe("#401 lintJourney", () => {
  it("flags own-target-visible for a step whose expect is its own target visible", () => {
    const journey = j([
      { step: { kind: "click", target: { testId: "publish" }, expect: { kind: "visible", target: { testId: "publish" } } } },
    ]);
    expect(lintJourney(journey).some((f) => f.rule === "own-target-visible" && f.step === 1)).toBe(true);
  });

  it("does not flag own-target-visible when the expect checks a changed result", () => {
    const journey = j([
      { step: { kind: "click", target: { testId: "publish" }, expect: { kind: "textIncludes", target: { role: "status" }, text: "Published" } } },
    ]);
    expect(lintJourney(journey).some((f) => f.rule === "own-target-visible")).toBe(false);
  });

  it("flags write-without-effect on the issue's publish step whose end state checks another request", () => {
    const journey = j(
      [
        {
          step: { kind: "click", target: { testId: "publish" }, expect: { kind: "visible", target: { testId: "publish" } } },
          delta: { verdict: "relevant-change", why: "published", changes: ["status"], requests: publishWrite, overheadMs: 1 },
        },
      ],
      { networkChecks: [{ kind: "requestMade", method: "POST", pathGlob: "/portal.v1.OwnerSiteEditService/PreviewSiteEdits" }] },
    );
    expect(lintJourney(journey).some((f) => f.rule === "write-without-effect" && f.step === 1)).toBe(true);
  });

  it("flags own-target-visible on the issue's publish step", () => {
    const journey = j(
      [
        {
          step: { kind: "click", target: { testId: "publish" }, expect: { kind: "visible", target: { testId: "publish" } } },
          delta: { verdict: "relevant-change", why: "published", changes: ["status"], requests: publishWrite, overheadMs: 1 },
        },
      ],
      { networkChecks: [{ kind: "requestMade", method: "POST", pathGlob: "/portal.v1.OwnerSiteEditService/PreviewSiteEdits" }] },
    );
    expect(lintJourney(journey).some((f) => f.rule === "own-target-visible" && f.step === 1)).toBe(true);
  });

  it("does not flag write-without-effect when the last write has a matching end-state network check", () => {
    const journey = j(
      [
        {
          step: { kind: "click", target: { testId: "publish" }, expect: { kind: "visible", target: { testId: "publish" } } },
          delta: { verdict: "relevant-change", why: "published", changes: ["status"], requests: publishWrite, overheadMs: 1 },
        },
      ],
      { networkChecks: [{ kind: "responseStatus", method: "POST", pathGlob: "/portal.v1.OwnerSiteEditService/PublishSiteEdits", status: { class: 2 } }] },
    );
    expect(lintJourney(journey).some((f) => f.rule === "write-without-effect")).toBe(false);
  });

  it("does not flag write-without-effect when the write step carries a step-request check", () => {
    const journey = j([
      {
        step: { kind: "click", target: { testId: "publish" }, expect: { kind: "visible", target: { testId: "publish" } } },
        delta: { verdict: "relevant-change", why: "published", changes: ["status"], requests: publishWrite, overheadMs: 1 },
        expectRequests: [...publishResponse],
      },
    ]);
    expect(lintJourney(journey).some((f) => f.rule === "write-without-effect")).toBe(false);
  });

  it("does not flag write-without-effect for the final write when the end state has a page effect", () => {
    const journey = j(
      [
        {
          step: { kind: "click", target: { testId: "publish" }, expect: { kind: "visible", target: { testId: "publish" } } },
          delta: { verdict: "relevant-change", why: "published", changes: ["status"], requests: publishWrite, overheadMs: 1 },
        },
      ],
      { endState: [{ kind: "page", assertion: { kind: "textIncludes", target: { testId: "live" }, text: "published" } }] },
    );
    expect(lintJourney(journey).some((f) => f.rule === "write-without-effect")).toBe(false);
  });

  it("flags visibility-only when a Journey asserts only visibility", () => {
    const journey = j([{ step: { kind: "navigate", url: "/editor", expect: { kind: "visible", target: { testId: "editor" } } } }]);
    expect(lintJourney(journey).some((f) => f.rule === "visibility-only" && f.step === undefined)).toBe(true);
  });

  it("does not flag visibility-only when a step asserts a concrete effect", () => {
    const journey = j([
      { step: { kind: "click", target: { testId: "publish" }, expect: { kind: "textIncludes", target: { role: "status" }, text: "Published" } } },
    ]);
    expect(lintJourney(journey).some((f) => f.rule === "visibility-only")).toBe(false);
  });

  it("flags nothing-after-last-write when no effect assertion follows the last write", () => {
    const journey = j([
      {
        step: { kind: "click", target: { testId: "publish" }, expect: { kind: "visible", target: { testId: "publish" } } },
        delta: { verdict: "relevant-change", why: "published", changes: ["status"], requests: publishWrite, overheadMs: 1 },
      },
    ]);
    expect(lintJourney(journey).some((f) => f.rule === "nothing-after-last-write")).toBe(true);
  });

  it("does not flag nothing-after-last-write when an effect assertion follows the last write", () => {
    const journey = j([
      {
        step: { kind: "click", target: { testId: "publish" }, expect: { kind: "visible", target: { testId: "publish" } } },
        delta: { verdict: "relevant-change", why: "published", changes: ["status"], requests: publishWrite, overheadMs: 1 },
      },
      { step: { kind: "assert", check: { kind: "textIncludes", target: { testId: "live" }, text: "published" } } },
    ]);
    expect(lintJourney(journey).some((f) => f.rule === "nothing-after-last-write")).toBe(false);
  });

  it("does not flag nothing-after-last-write when the end state checks the outcome", () => {
    const journey = j(
      [
        {
          step: { kind: "click", target: { testId: "publish" }, expect: { kind: "visible", target: { testId: "publish" } } },
          delta: { verdict: "relevant-change", why: "published", changes: ["status"], requests: publishWrite, overheadMs: 1 },
        },
      ],
      { endState: [...reloadThen] },
    );
    expect(lintJourney(journey).some((f) => f.rule === "nothing-after-last-write")).toBe(false);
  });

  it("flags no-persistence-check when a write has no reloadThen end-state check", () => {
    const journey = j([
      {
        step: { kind: "click", target: { testId: "publish" }, expect: { kind: "textIncludes", target: { role: "status" }, text: "Published" } },
        expectRequests: [...publishResponse],
      },
    ]);
    expect(lintJourney(journey).some((f) => f.rule === "no-persistence-check")).toBe(true);
  });

  it("does not flag no-persistence-check when the end state reloads and checks persistence", () => {
    const journey = j(
      [
        {
          step: { kind: "click", target: { testId: "publish" }, expect: { kind: "textIncludes", target: { role: "status" }, text: "Published" } },
          expectRequests: [...publishResponse],
        },
      ],
      { endState: [...reloadThen] },
    );
    expect(lintJourney(journey).some((f) => f.rule === "no-persistence-check")).toBe(false);
  });

  it("flags intent-uncovered for a documented expectedResult with no effect assertion", () => {
    const journey = j([
      {
        step: { kind: "click", target: { testId: "publish" }, expect: { kind: "visible", target: { testId: "publish" } } },
        expectedResult: "the site is live",
      },
    ]);
    expect(lintJourney(journey).some((f) => f.rule === "intent-uncovered" && f.step === 1)).toBe(true);
  });

  it("does not flag intent-uncovered when the step asserts its effect", () => {
    const journey = j([
      {
        step: { kind: "click", target: { testId: "publish" }, expect: { kind: "textIncludes", target: { role: "status" }, text: "Published" } },
        expectedResult: "the site is live",
      },
    ]);
    expect(lintJourney(journey).some((f) => f.rule === "intent-uncovered")).toBe(false);
  });

  it("returns no findings for a write step with a step-request check and a reloadThen end state", () => {
    const journey = j(
      [
        {
          step: { kind: "click", target: { testId: "publish" }, expect: { kind: "textIncludes", target: { role: "status" }, text: "Published" } },
          expectRequests: [...publishResponse],
        },
      ],
      { endState: [...reloadThen] },
    );
    expect(lintJourney(journey)).toEqual([]);
  });

  it("flags no-persistence-check for a relevant-change step with no recorded requests", () => {
    const journey = j([
      {
        step: { kind: "click", target: { testId: "publish" }, expect: { kind: "textIncludes", target: { role: "status" }, text: "Published" } },
        delta: { verdict: "relevant-change", why: "state changed", changes: ["status"], overheadMs: 1 },
      },
    ]);
    expect(lintJourney(journey).some((f) => f.rule === "no-persistence-check")).toBe(true);
  });

  it("flags no-persistence-check for a step whose expectRequests names a write request", () => {
    const journey = j([
      {
        step: { kind: "click", target: { testId: "save" }, expect: { kind: "textIncludes", target: { role: "status" }, text: "Saved" } },
        expectRequests: [{ kind: "requestMade", method: "POST", pathGlob: "/api/items" }],
      },
    ]);
    expect(lintJourney(journey).some((f) => f.rule === "no-persistence-check")).toBe(true);
  });

  it("does not treat a step as a write when opts.readRequests marks its request a read", () => {
    const journey = j([
      {
        step: { kind: "click", target: { testId: "estimate" }, expect: { kind: "textIncludes", target: { role: "status" }, text: "Estimated" } },
        delta: { verdict: "inconclusive", why: "read rpc", changes: [], requests: ["POST /pkg.Billing/EstimateCost → 200"], overheadMs: 1 },
      },
    ]);
    expect(lintJourney(journey, { readRequests: ["Estimate*"] }).some((f) => f.rule === "no-persistence-check")).toBe(false);
  });
});

describe("#466 lintJourney: the 0.10 anchor rules", () => {
  const click: RecordedStep = { step: { kind: "click", target: { testId: "go" }, expect: { kind: "textIncludes", target: { role: "status" }, text: "Done" } }, stepId: "s-aaaaaa" };

  it("reports a non-compliant anchor name as a warning", () => {
    const finding = lintJourney(j([click], { anchors: [{ name: "Review", step: 1, stepId: "s-aaaaaa" }] })).find((f) => f.rule === "anchor-name");
    expect(finding?.level).toBe("warning");
  });

  it("names the fix", () => {
    const finding = lintJourney(j([click], { anchors: [{ name: "Review", step: 1, stepId: "s-aaaaaa" }] })).find((f) => f.rule === "anchor-name");
    expect(finding?.fix).toContain("'review'");
  });

  it("reports a job-linked Journey without anchors", () => {
    expect(lintJourney(j([click], { job: "checkout" })).some((f) => f.rule === "job-anchors" && f.level === "warning")).toBe(true);
  });
});
