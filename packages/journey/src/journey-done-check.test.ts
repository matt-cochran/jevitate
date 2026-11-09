import { describe, expect, it } from "vitest";
import type { RecordedStep } from "@jevitate/recording";
import { JourneySchema, lintJourneyDoneCheck, type Journey } from "./index.js";

/**
 * 0.30.0 design §3.1: "a Journey with no linked job may carry [a done check] itself in `metadata.done`".
 * The shape is the jobs.json one, and the lint is the same rules as the job's (`lintDoneCheck`).
 */

const valid = { version: 1, at: "/invoices", check: "textIncludes:testId=row|${invoiceNo}" } as const;
const writeStep: RecordedStep = {
  step: { kind: "click", target: { testId: "save" } },
  delta: { verdict: "relevant-change", why: "saved", changes: ["row"], requests: ["POST /api/invoices → 201"], overheadMs: 1 },
};
const readStep: RecordedStep = { step: { kind: "click", target: { testId: "open" } } };
/** A step the Journey schema accepts (every replayable step names its expectation). */
const checkedStep = { step: { kind: "click", target: { testId: "open" }, expect: { kind: "visible", target: { testId: "row" } } } } as RecordedStep;
function journey(steps: RecordedStep[], metadata: Record<string, unknown> = {}): Journey {
  return {
    metadata: { id: "pay", name: "Pay", promoted: true, params: ["invoiceNo"], createdAtIso: "2026-11-01T00:00:00Z", ...metadata },
    recording: { version: "1", site: "http://localhost:3000", pages: [{ url: "/invoices", steps }] },
  } as Journey;
}

describe("Journey metadata.done (schema)", () => {
  it("accepts a done check of the jobs.json shape", () => {
    const r = JourneySchema.safeParse(journey([checkedStep], { done: valid }));
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.metadata.done).toEqual(valid);
  });

  it("refuses a shape the jobs.json done check refuses (an unknown key, a wrong version)", () => {
    expect(JourneySchema.safeParse(journey([checkedStep], { done: { ...valid, extra: 1 } })).success).toBe(false);
    expect(JourneySchema.safeParse(journey([checkedStep], { done: { ...valid, version: 2 } })).success).toBe(false);
  });
});

describe("lintJourneyDoneCheck", () => {
  it("has nothing to say about a Journey without metadata.done", () => {
    expect(lintJourneyDoneCheck(journey([writeStep]))).toEqual([]);
  });

  it("is clean for a valid check whose distinguishedBy names the created value", () => {
    expect(lintJourneyDoneCheck(journey([writeStep], { done: { ...valid, distinguishedBy: ["invoiceNo"] } }))).toEqual([]);
  });

  it("warns done-check-cannot-be-false on a write Journey whose check names no distinguishedBy", () => {
    expect(lintJourneyDoneCheck(journey([writeStep], { done: valid }))).toEqual([
      expect.objectContaining({ rule: "done-check-cannot-be-false", level: "warning", journey: "pay" }),
    ]);
  });

  it("reports parse issues as done-check-invalid errors, with the code (path-bound, secret, unbound)", () => {
    expect(lintJourneyDoneCheck(journey([readStep], { done: { ...valid, check: "textIncludes:testId=row|step:3" } }))).toEqual([
      expect.objectContaining({ rule: "done-check-invalid", level: "error", journey: "pay", code: "E_DONE_CHECK_PATH_BOUND" }),
    ]);
    expect(lintJourneyDoneCheck(journey([readStep], { done: { ...valid, check: "textIncludes:testId=row|${password}" } }))).toContainEqual(
      expect.objectContaining({ rule: "done-check-invalid", code: "E_DONE_CHECK_SECRET_REF" }),
    );
    expect(lintJourneyDoneCheck(journey([readStep], { params: [], done: valid }))).toEqual([
      expect.objectContaining({ rule: "done-check-invalid", code: "E_DONE_CHECK_REF_UNBOUND", journey: "pay" }),
    ]);
  });

  it("is an error on a Journey that also links a job: the job's check is the one read", () => {
    const findings = lintJourneyDoneCheck(journey([readStep], { job: "pay-invoice", done: { ...valid, distinguishedBy: ["invoiceNo"] } }));
    expect(findings).toEqual([expect.objectContaining({ rule: "done-check-invalid", level: "error", journey: "pay", job: "pay-invoice" })]);
    expect(findings[0]!.message).toContain("metadata.done");
  });
});
