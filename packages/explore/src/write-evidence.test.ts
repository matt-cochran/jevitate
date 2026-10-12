import { describe, expect, it } from "vitest";
import { groundDone, WRITES_DONE_NOTE } from "./conversation.js";
import { jobWriteEvidence } from "./write-evidence.js";
import type { SideEffect } from "./side-effects.js";

/**
 * #514 — a job whose writes all succeeded but left the page looking unchanged (the same CSV
 * imported again: no new contact appears) is done: code weighs the job's own write evidence when
 * the page judgment says the goal is not observably met.
 */

const write = (status: number | null, extra: Partial<SideEffect> = {}): SideEffect => ({
  step: 2,
  control: "Import",
  request: { method: "POST", endpoint: "/api/v1/tool/crm-upload/sessions", status },
  ...extra,
});
const evidence = (effects: SideEffect[], blocked = 0) => jobWriteEvidence(effects, { truncated: 0, blocked });

describe("#514 groundDone — the job's succeeded writes", () => {
  it("accepts a done whose every write succeeded although the page judgment says not met", () => {
    const v = groundDone({ unsubmitted: [], goalMetProbability: 0.24, writes: evidence([write(201), write(200)]) });
    expect(v).toEqual({ accept: true, outcome: { status: "completed", verifiedBy: "succeeded-writes", note: WRITES_DONE_NOTE } });
  });

  it("rejects a done when one of the job's writes failed", () => {
    const v = groundDone({ unsubmitted: [], goalMetProbability: 0.24, writes: evidence([write(201), write(500)]) });
    expect(v).toEqual({ accept: false, reason: "the goal is not observably achieved on this page (p=0.24)" });
  });

  it("rejects a done when the job made no writes", () => {
    const v = groundDone({ unsubmitted: [], goalMetProbability: 0.24, writes: evidence([]) });
    expect(v).toEqual({ accept: false, reason: "the goal is not observably achieved on this page (p=0.24)" });
  });

  it("rejects a done when a write was blocked by jevitate's guard (it never succeeded)", () => {
    const v = groundDone({ unsubmitted: [], goalMetProbability: 0.24, writes: evidence([write(204)], 1) });
    expect(v).toMatchObject({ accept: false });
  });

  it("a declared success check that fails still fails, whatever the writes", () => {
    const v = groundDone({ unsubmitted: [], successCheck: false, writes: evidence([write(201)]) });
    expect(v).toMatchObject({ accept: false, reason: /success condition/ });
  });

  it("typed text never submitted still rejects, whatever the writes", () => {
    const v = groundDone({ unsubmitted: ["Name"], goalMetProbability: 0.24, writes: evidence([write(201)]) });
    expect(v).toMatchObject({ accept: false });
  });

  it("an unavailable page judgment is no license: writes are weighed only against a judged page", () => {
    const v = groundDone({ unsubmitted: [], goalMetProbability: null, writes: evidence([write(201)]) });
    expect(v).toMatchObject({ accept: false, reason: /could not be judged/ });
  });

  it("a page-observed done keeps its own proof (the judgment), not the writes", () => {
    const v = groundDone({ unsubmitted: [], goalMetProbability: 0.9, writes: evidence([write(201)]) });
    expect(v).toMatchObject({ outcome: { verifiedBy: "grounded-judgment" } });
  });
});

describe("#514 jobWriteEvidence — only the job's own actions' writes count", () => {
  it("a write still in flight (or ended without a response) is not a succeeded write", () => {
    expect(evidence([write(201), write(null)]).unsucceeded).toEqual(["POST /api/v1/tool/crm-upload/sessions → no response"]);
  });

  it("a background write (page load, token refresh) is not the job's", () => {
    expect(evidence([write(200, { background: true })]).succeeded).toBe(0);
  });

  it("a third-party write (a vendor beacon) is not the job's", () => {
    expect(evidence([write(200, { thirdParty: true })]).succeeded).toBe(0);
  });

  it("a bookkeeping write (an analytics event) is not the job's", () => {
    expect(evidence([write(200, { request: { method: "POST", endpoint: "/api/analytics/events", status: 200 } })]).succeeded).toBe(0);
  });

  it("a blocked write is named as one that never succeeded", () => {
    expect(evidence([], 2).unsucceeded).toEqual(["2 write(s) blocked by jevitate's write guard"]);
  });

  it("writes past the listed cap are unknown, so not succeeded", () => {
    expect(jobWriteEvidence([write(201)], { truncated: 3, blocked: 0 }).unsucceeded).toEqual(["3 more write(s) not listed"]);
  });
});
