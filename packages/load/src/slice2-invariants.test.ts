import { describe, it, expect, vi } from "vitest";
import { runLoadTest, LoadHarnessSetupError } from "./measured-load-runner.js";
import { UnauthorizedLoadTargetError } from "./authorized-targets.js";
import type { LoadActorRunnerFactory } from "./types.js";

/**
 * Slice 2 §9a — invariant refusal contract.
 *
 * Re-asserts invariants #9 and #10 (spec §9a) in one readable place. Adds NO
 * new production logic — `measured-load-runner.test.ts` and
 * `authorized-targets.test.ts` remain the exhaustive unit-test sources of
 * truth; this file exists so a reviewer can read one file and see both
 * invariants refuse.
 */
describe("Slice 2 §9a — invariant refusal contract", () => {
  it("#9 a real run that cannot even start ERRORS — never silently returns a 'modeled' report labeled measured", async () => {
    const unavailableRunnerFactory: LoadActorRunnerFactory = () => {
      throw new Error("no real browser/target available");
    };

    const outcome = await runLoadTest({
      targetOrigin: "https://example.com",
      authorizedOrigins: ["https://example.com"],
      concurrency: 1,
      iterationsPerActor: 1,
      seed: 1,
      runnerFactory: unavailableRunnerFactory,
    }).then(
      (report) => ({ settled: "resolved" as const, report }),
      (err) => ({ settled: "rejected" as const, err }),
    );

    expect(outcome.settled).toBe("rejected");
    if (outcome.settled === "rejected") {
      expect(outcome.err).toBeInstanceOf(LoadHarnessSetupError);
    }
    // The critical assertion: there is no world in which this call
    // *resolves* with `{ provenance: "modeled" }` — it either measures for
    // real or it throws. No third option.
  });

  it("#10 an unauthorized target is refused before any pool member is even created", async () => {
    const runnerFactory = vi.fn<LoadActorRunnerFactory>(() => {
      throw new Error("should never be reached");
    });

    await expect(
      runLoadTest({
        targetOrigin: "https://unauthorized.example.com",
        authorizedOrigins: ["https://example.com"],
        concurrency: 5,
        iterationsPerActor: 3,
        seed: 1,
        runnerFactory,
      }),
    ).rejects.toBeInstanceOf(UnauthorizedLoadTargetError);
    expect(runnerFactory).not.toHaveBeenCalled();
  });
});
