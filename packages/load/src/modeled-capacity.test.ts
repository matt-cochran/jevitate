import { describe, it, expect } from "vitest";
import { modeledCapacityReport } from "./modeled-capacity.js";
import { UnauthorizedLoadTargetError } from "./authorized-targets.js";
import { LoadHarnessSetupError } from "./types.js";
import type { InteractionPolicy, PlannedStep } from "@jevitate/domain";

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

  it("rejects a non-positive concurrency or iterationsPerActor with the same LoadHarnessSetupError runLoadTest uses (consistent error type across both producers)", () => {
    // NOTE: deliberately NOT `expect(() => ...).toThrow(LoadHarnessSetupError)`
    // — vitest/esbuild does not statically verify a named import actually
    // exists, so if `LoadHarnessSetupError` were ever undefined (e.g. a
    // broken re-export), `.toThrow(undefined)` degrades to "throws
    // something, whatever it is" and passes vacuously. `toBeInstanceOf`
    // throws a real TypeError against `instanceof undefined`, so this
    // fails loudly instead of silently if the import is ever broken.
    let caught: unknown;
    try {
      modeledCapacityReport({
        targetOrigin: "https://example.com",
        authorizedOrigins: ["https://example.com"],
        concurrency: 0,
        iterationsPerActor: 1,
        seed: 1,
        policy,
        script,
      });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(LoadHarnessSetupError);
  });
});
