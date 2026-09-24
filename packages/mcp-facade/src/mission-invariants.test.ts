import { describe, it, expect } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  FsMissionTargetStore,
  MissionTargetRegistry,
  FsMissionQueueStore,
  UnknownOrUnpromotedMissionTargetError,
  BudgetExceedsCeilingError,
  type MissionTarget,
} from "@jevitate/missions";
import { queueExploration, ALLOWED_TOOLS, FORBIDDEN_TOOLS } from "./index.js";

/**
 * Ticket #8 — invariant refusal contract for `queue_exploration`.
 *
 * Mirrors `packages/runtime/src/slice1-invariants.test.ts`'s structure: one
 * readable file, one test per guardrail, reusing the REAL (not re-mocked)
 * `queueExploration` from `./index.js` — never a fresh copy of its logic.
 */

function mkTarget(id: string, promoted: boolean): MissionTarget {
  return {
    id,
    name: id,
    authorizedOrigin: "https://demo.example.com",
    baseUrl: "https://demo.example.com",
    promoted,
    createdAtIso: new Date().toISOString(),
  };
}

async function buildDeps() {
  const targetDir = mkdtempSync(join(tmpdir(), "mi-targets-"));
  const queueDir = mkdtempSync(join(tmpdir(), "mi-queue-"));
  const targets = new MissionTargetRegistry(new FsMissionTargetStore(targetDir));
  const queue = new FsMissionQueueStore(queueDir);
  await targets.put(mkTarget("demo-shop", true));
  await targets.put(mkTarget("staging-shop", false));
  return { targets, queue };
}

const baseRequest = {
  target: "demo-shop",
  goal: "verify checkout completes",
  successAssertion: { kind: "urlIncludes", text: "/checkout" },
  strategy: "goal-based",
};

describe("ticket #8 — queue_exploration invariant refusal contract", () => {
  it("1. unknown target refuses (UnknownOrUnpromotedMissionTargetError), queue store never written to", async () => {
    const { targets, queue } = await buildDeps();
    await expect(
      queueExploration(targets, queue, { ...baseRequest, target: "nonexistent" }),
    ).rejects.toBeInstanceOf(UnknownOrUnpromotedMissionTargetError);
    expect(await queue.list()).toEqual([]);
  });

  it("2. unpromoted target refuses, same error, same non-write assertion", async () => {
    const { targets, queue } = await buildDeps();
    await expect(
      queueExploration(targets, queue, { ...baseRequest, target: "staging-shop" }),
    ).rejects.toBeInstanceOf(UnknownOrUnpromotedMissionTargetError);
    expect(await queue.list()).toEqual([]);
  });

  it("3. out-of-schema param (extra top-level key) refuses (zod error), nothing written", async () => {
    const { targets, queue } = await buildDeps();
    await expect(
      queueExploration(targets, queue, { ...baseRequest, bogus: 1 }),
    ).rejects.toThrow();
    expect(await queue.list()).toEqual([]);
  });

  it("4. unsupported strategy value ('usability', 'induction') refuses (zod error) — only strategies a runner executes are queueable", async () => {
    const { targets, queue } = await buildDeps();
    for (const strategy of ["usability", "induction"]) {
      await expect(queueExploration(targets, queue, { ...baseRequest, strategy })).rejects.toThrow();
    }
    // A goal-shaped request cannot be relabelled adversarial: its goal/success assertion are refused.
    await expect(queueExploration(targets, queue, { ...baseRequest, strategy: "adversarial" })).rejects.toThrow();
    expect(await queue.list()).toEqual([]);
  });

  it("4b. coverage / adversarial / feature missions enqueue against a promoted target (#117)", async () => {
    const { targets, queue } = await buildDeps();
    const requests = [
      { target: baseRequest.target, strategy: "coverage", route: "/thread/**" },
      { target: baseRequest.target, strategy: "adversarial" },
      { target: baseRequest.target, strategy: "feature", feature: "checkout" },
    ];
    for (const req of requests) {
      await expect(queueExploration(targets, queue, req)).resolves.toMatchObject({ ok: true, status: "queued" });
    }
    expect((await queue.list()).map((m) => m.strategy).sort()).toEqual(["adversarial", "coverage", "feature"]);
  });

  it("5. budget above MISSION_BOUNDS_CEILING refuses (BudgetExceedsCeilingError), nothing written", async () => {
    const { targets, queue } = await buildDeps();
    await expect(
      queueExploration(targets, queue, { ...baseRequest, budget: { maxActions: 61 } }),
    ).rejects.toBeInstanceOf(BudgetExceedsCeilingError);
    expect(await queue.list()).toEqual([]);
  });

  it("6. queue_exploration is present in ALLOWED_TOOLS; no FORBIDDEN_TOOLS name is reachable from mcp-facade's exports at all", async () => {
    expect(ALLOWED_TOOLS).toContain("queue_exploration");
    const facade = (await import("./index.js")) as Record<string, unknown>;
    for (const forbiddenName of FORBIDDEN_TOOLS) {
      expect(typeof facade[forbiddenName]).toBe("undefined");
    }
  });
});
