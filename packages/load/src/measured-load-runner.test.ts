import { describe, it, expect, vi } from "vitest";
import { runLoadTest, LoadHarnessSetupError } from "./measured-load-runner.js";
import type { LoadActorRunner, LoadActorRunnerFactory } from "./types.js";

function fakeRunnerFactory(outcomes: Array<"ok" | "quarantined" | "throw">): LoadActorRunnerFactory {
  let i = 0;
  return () => {
    const runner: LoadActorRunner = {
      run: vi.fn().mockImplementation(async () => {
        const outcome = outcomes[i % outcomes.length];
        i++;
        if (outcome === "throw") throw new Error("boom");
        return outcome === "ok" ? { outcome: "ok", output: {} } : { outcome: "quarantined", reason: "x" };
      }),
    };
    return runner;
  };
}

describe("runLoadTest", () => {
  it("aggregates ok/quarantined/error counts, returns provenance 'measured'", async () => {
    const factory = fakeRunnerFactory(["ok", "ok", "quarantined", "throw"]);
    const report = await runLoadTest({
      targetOrigin: "https://example.com",
      authorizedOrigins: ["https://example.com"],
      concurrency: 2,
      iterationsPerActor: 2,
      seed: 1,
      runnerFactory: factory,
    });
    expect(report.provenance).toBe("measured");
    expect(report.totalRuns).toBe(4);
    expect(report.okRuns).toBe(2);
    expect(report.quarantinedRuns).toBe(1);
    expect(report.errorRuns).toBe(1);
    expect(report.concurrency).toBe(2);
    expect(report.seed).toBe(1);
    expect(report.startedAtIso).toBeDefined();
    expect(report.endedAtIso).toBeDefined();
    expect(report.latency.minMs).toBeGreaterThanOrEqual(0);
    // C5: the report makes explicit that `latency` covers only runs that
    // completed (ok + quarantined), never the thrown/errorRuns — so a
    // reader can't mistake a high-error run for a fast one.
    expect(report.latencyPercentilesOver).toBe("completedRuns");
  });

  it("calls the runner factory once per actor, run() iterationsPerActor times per actor", async () => {
    const factoryFn = vi.fn(fakeRunnerFactory(["ok"]));
    await runLoadTest({
      targetOrigin: "https://example.com",
      authorizedOrigins: ["https://example.com"],
      concurrency: 3,
      iterationsPerActor: 4,
      seed: 1,
      runnerFactory: factoryFn,
    });
    expect(factoryFn).toHaveBeenCalledTimes(3);
  });

  it("rejects the whole run (does not swallow) when a runner factory itself fails to set up", async () => {
    const factory: LoadActorRunnerFactory = () => {
      throw new Error("no browser available");
    };
    await expect(
      runLoadTest({
        targetOrigin: "https://example.com",
        authorizedOrigins: ["https://example.com"],
        concurrency: 1,
        iterationsPerActor: 1,
        seed: 1,
        runnerFactory: factory,
      }),
    ).rejects.toBeInstanceOf(LoadHarnessSetupError);
  });

  it("refuses an unauthorized target before calling the runner factory at all", async () => {
    const factoryFn = vi.fn(fakeRunnerFactory(["ok"]));
    await expect(
      runLoadTest({
        targetOrigin: "https://evil.example.com",
        authorizedOrigins: ["https://example.com"],
        concurrency: 1,
        iterationsPerActor: 1,
        seed: 1,
        runnerFactory: factoryFn,
      }),
    ).rejects.toThrow(/authorized-origins/);
    expect(factoryFn).not.toHaveBeenCalled();
  });

  it("rejects a non-positive concurrency or iterationsPerActor", async () => {
    const factoryFn = vi.fn(fakeRunnerFactory(["ok"]));
    await expect(
      runLoadTest({
        targetOrigin: "https://example.com",
        authorizedOrigins: ["https://example.com"],
        concurrency: 0,
        iterationsPerActor: 1,
        seed: 1,
        runnerFactory: factoryFn,
      }),
    ).rejects.toBeInstanceOf(LoadHarnessSetupError);
  });
});
