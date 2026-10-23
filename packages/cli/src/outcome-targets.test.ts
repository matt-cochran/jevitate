import { describe, expect, it } from "vitest";
import type { DesiredOutcome } from "@jevitate/journey";
import type { CheckBaseline } from "./check-types.js";
import { evaluateOutcomeTargets } from "./outcome-targets.js";

// #643: desired-outcome targets against a replay's machine baseline — a one-sided test.

const baseline: CheckBaseline = {
  steps: 6,
  totalMs: 12_000,
  anchors: [
    { name: "job_start", step: 1, atMs: 0 },
    { name: "mapped", step: 3, atMs: 4_000 },
    { name: "job_end", step: 6, atMs: 12_000 },
  ],
};

const outcome = (over: Partial<DesiredOutcome>): DesiredOutcome =>
  ({ id: "fast-import", direction: "minimize", measure: "time", object: "the time it takes to import contacts", ...over }) as DesiredOutcome;

const duration = (to: string, stat: "p50" | "p75" | "share_under" = "p50", threshold?: number) =>
  ({ kind: "duration", from: "job_start", to, stat, ...(threshold === undefined ? {} : { threshold }) }) as DesiredOutcome["metric"];

const one = (o: DesiredOutcome) => evaluateOutcomeTargets([o], baseline)[0]!;

describe("#643 duration upper bounds", () => {
  it("is a miss when the replay floor already exceeds a <= target", () => {
    expect(one(outcome({ metric: duration("job_end"), target: { op: "<=", value: 10, unit: "s" } })).status).toBe("miss");
  });

  it("reports the floor in seconds on a miss", () => {
    expect(one(outcome({ metric: duration("job_end"), target: { op: "<=", value: 10, unit: "s" } })).floorSeconds).toBe(12);
  });

  it("is a miss when the floor equals a strict < target", () => {
    expect(one(outcome({ metric: duration("job_end"), target: { op: "<", value: 12, unit: "s" } })).status).toBe("miss");
  });

  it("is not decidable when the floor is within the target", () => {
    expect(one(outcome({ metric: duration("mapped"), target: { op: "<=", value: 10, unit: "s" } })).status).toBe("not-decidable");
  });
});

describe("#643 share under a threshold", () => {
  it("is a miss when the floor is over the threshold and the target wants a share under it", () => {
    expect(one(outcome({ metric: duration("job_end", "share_under", 8), target: { op: ">=", value: 80, unit: "percent" } })).status).toBe("miss");
  });

  it("is not decidable when the floor is within the threshold", () => {
    expect(one(outcome({ metric: duration("job_end", "share_under", 20), target: { op: ">=", value: 80, unit: "percent" } })).status).toBe("not-decidable");
  });
});

describe("#643 what a replay cannot decide", () => {
  it("is unmeasured when an anchor is missing from the baseline", () => {
    expect(one(outcome({ metric: duration("confirmed"), target: { op: "<=", value: 10, unit: "s" } })).reason).toContain("'confirmed'");
  });

  it("leaves a human-evidence metric to real users", () => {
    expect(one(outcome({ metric: { kind: "abandon", at: "mapped" }, target: { op: "<=", value: 5, unit: "percent" } })).status).toBe("not-decidable-by-replay");
  });

  it("leaves an outcome without a target undecided", () => {
    expect(one(outcome({ metric: duration("job_end") })).status).toBe("not-decidable-by-replay");
  });

  it("leaves a lower-bound duration target undecided", () => {
    expect(one(outcome({ metric: duration("job_end"), target: { op: ">=", value: 5, unit: "s" } })).status).toBe("not-decidable-by-replay");
  });
});
