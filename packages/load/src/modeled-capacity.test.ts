import { describe, it, expect } from "vitest";
import { modeledCapacityReport } from "./modeled-capacity.js";
import { UnauthorizedLoadTargetError } from "./authorized-targets.js";
import type { InteractionPolicy, PlannedStep } from "@doit/domain";

const policy: InteractionPolicy = {
  typing: { charsPerSecond: 5, perKeyJitter: 0.1 },
  thinkBeforeActionMs: { mean: 200, sd: 50 },
  interInteractionMs: { mean: 100, sd: 20 },
};
const script: PlannedStep[] = [
  { kind: "navigate", label: "open" },
  { kind: "type", label: "email", text: "a@b.com" },
  { kind: "click", label: "submit" },
];

describe("modeledCapacityReport", () => {
  it("returns provenance 'modeled' and totalRuns = concurrency * iterationsPerActor", () => {
    const report = modeledCapacityReport({
      targetOrigin: "https://example.com",
      authorizedOrigins: ["https://example.com"],
      concurrency: 3,
      iterationsPerActor: 2,
      seed: 42,
      policy,
      script,
    });
    expect(report.provenance).toBe("modeled");
    expect(report.totalRuns).toBe(6);
    expect(report.okRuns).toBe(6);
    expect(report.quarantinedRuns).toBe(0);
    expect(report.errorRuns).toBe(0);
    expect(report.startedAtIso).toBeUndefined(); // no real clock to bound
    expect(report.latency.meanMs).toBeGreaterThan(0);
    expect(report.throughputPerSecond).toBeGreaterThan(0);
  });

  it("is fully deterministic given the same seed", () => {
    const config = {
      targetOrigin: "https://example.com",
      authorizedOrigins: ["https://example.com"],
      concurrency: 4,
      iterationsPerActor: 3,
      seed: 7,
      policy,
      script,
    };
    expect(modeledCapacityReport(config)).toEqual(modeledCapacityReport(config));
  });

  it("refuses an unauthorized target — the offline/modeled path is NOT an escape hatch around invariant #10", () => {
    expect(() =>
      modeledCapacityReport({
        targetOrigin: "https://unauthorized.example.com",
        authorizedOrigins: ["https://example.com"],
        concurrency: 1,
        iterationsPerActor: 1,
        seed: 1,
        policy,
        script,
      }),
    ).toThrow(UnauthorizedLoadTargetError);
  });
});
