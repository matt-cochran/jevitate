import { describe, expect, it } from "vitest";
import { JourneySchema, anchorLintIssues, stampAnchorStepIds, stripStepIds, suggestAnchorName, type Journey } from "./index.js";

/** #466: the 0.10 anchor rules — reported for lint/promote, never at parse time. */

function journey(metadata: Partial<Journey["metadata"]> = {}, ids: readonly (string | undefined)[] = ["s-aaaaaa", "s-bbbbbb"]): Journey {
  const step = (i: number) => ({
    step: { kind: "click" as const, target: { testId: `b${i}` }, expect: { kind: "visible" as const, target: { testId: `r${i}` } } },
    ...(ids[i] === undefined ? {} : { stepId: ids[i] }),
  });
  return {
    metadata: { id: "order", name: "Order", promoted: false, params: [], createdAtIso: "2026-10-09T00:00:00.000Z", ...metadata },
    recording: { version: "1", site: "http://127.0.0.1:1", pages: [{ url: "/", steps: [step(0), step(1)] }] },
  };
}

const codes = (j: Journey) => anchorLintIssues(j).map((i) => i.code);

describe("#466 anchor rules (lint, not parse)", () => {
  it("a mixed-case name still parses", () => {
    expect(JourneySchema.safeParse(journey({ anchors: [{ name: "Review_Step", step: 1 }] })).success).toBe(true);
  });

  it("a name with a colon parses (the 0.10 name rule allows it)", () => {
    expect(JourneySchema.safeParse(journey({ anchors: [{ name: "cart:review", step: 1 }] })).success).toBe(true);
  });

  it("a mixed-case name is a warning", () => {
    expect(anchorLintIssues(journey({ anchors: [{ name: "Review_Step", step: 1, stepId: "s-aaaaaa" }] }))[0]?.severity).toBe("warning");
  });

  it("a mixed-case name's fix names the compliant spelling", () => {
    expect(anchorLintIssues(journey({ anchors: [{ name: "Review Step", step: 1, stepId: "s-aaaaaa" }] }))[0]?.fix).toContain("'review-step'");
  });

  it("enforcing makes a rule an error", () => {
    expect(anchorLintIssues(journey({ anchors: [{ name: "Review", step: 1, stepId: "s-aaaaaa" }] }), { enforce: true })[0]?.severity).toBe("error");
  });

  it("a compliant anchor has no issue", () => {
    expect(codes(journey({ job: "order", anchors: [{ name: "cart:review", step: 1, stepId: "s-aaaaaa" }] }))).toEqual([]);
  });

  it("a stepId the Journey does not have is reported", () => {
    expect(codes(journey({ anchors: [{ name: "review", step: 1, stepId: "s-zzzzzz" }] }))).toEqual(["anchor-step-id"]);
  });

  it("a stepId and a step number that disagree are reported", () => {
    expect(codes(journey({ anchors: [{ name: "review", step: 1, stepId: "s-bbbbbb" }] }))).toEqual(["anchor-step-mismatch"]);
  });

  it("an anchor without a stepId on a Journey with step ids is reported", () => {
    expect(codes(journey({ anchors: [{ name: "review", step: 2 }] }))).toEqual(["anchor-unstamped"]);
  });

  it("an anchor without a stepId on a Journey without step ids is fine (index fallback)", () => {
    expect(codes(journey({ anchors: [{ name: "review", step: 2 }] }, [undefined, undefined]))).toEqual([]);
  });

  it("a job-linked Journey without anchors is reported", () => {
    expect(codes(journey({ job: "order" }))).toEqual(["job-anchors"]);
  });

  it("suggests a compliant name", () => {
    expect(suggestAnchorName("Review Step #2")).toBe("review-step-2");
  });

  it("stamps the stepId of the step an anchor follows", () => {
    expect(stampAnchorStepIds(journey({ anchors: [{ name: "review", step: 2 }] })).metadata.anchors?.[0]?.stepId).toBe("s-bbbbbb");
  });

  it("stamping keeps the Journey itself when nothing changes", () => {
    const j = journey({ anchors: [{ name: "review", step: 2, stepId: "s-bbbbbb" }] });
    expect(stampAnchorStepIds(j)).toBe(j);
  });

  it("stripping step ids removes step and anchor ids alike", () => {
    const stripped = stripStepIds(journey({ anchors: [{ name: "review", step: 2, stepId: "s-bbbbbb" }] }));
    expect(stripped).toEqual(journey({ anchors: [{ name: "review", step: 2 }] }, [undefined, undefined]));
  });
});
