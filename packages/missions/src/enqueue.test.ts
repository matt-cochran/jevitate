import { describe, it, expect, vi } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { enqueueMission } from "./enqueue.js";
import { FsMissionTargetStore } from "./target-store.js";
import { MissionTargetRegistry } from "./target-registry.js";
import { FsMissionQueueStore } from "./queue-store.js";
import { UnknownOrUnpromotedMissionTargetError, BudgetExceedsCeilingError } from "./errors.js";
import { SAFE_ID_RE } from "./schema.js";
import type { MissionTarget } from "./schema.js";

function mkTarget(id: string, promoted: boolean): MissionTarget {
  return {
    id,
    name: id,
    authorizedOrigin: "https://demo.example.com",
    baseUrl: "https://demo.example.com",
    promoted,
    createdAtIso: "2026-09-20T00:00:00Z",
  };
}

async function buildDeps() {
  const targetDir = mkdtempSync(join(tmpdir(), "eq-targets-"));
  const queueDir = mkdtempSync(join(tmpdir(), "eq-queue-"));
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

describe("enqueueMission", () => {
  it("happy path: no budget -> ceiling budget, generated SAFE_ID_RE id, retrievable from queue", async () => {
    const { targets, queue } = await buildDeps();
    const mission = await enqueueMission(targets, queue, baseRequest);
    expect(mission.status).toBe("queued");
    expect(mission.budget).toEqual({ maxActions: 60, maxDecisions: 120, maxCandidates: 250 });
    expect(SAFE_ID_RE.test(mission.id)).toBe(true);
    expect(await queue.get(mission.id)).toEqual(mission);
  });

  it("refuses an unknown target id; queue store never called", async () => {
    const { targets, queue } = await buildDeps();
    const enqueueSpy = vi.spyOn(queue, "enqueue");
    await expect(
      enqueueMission(targets, queue, { ...baseRequest, target: "nonexistent" }),
    ).rejects.toBeInstanceOf(UnknownOrUnpromotedMissionTargetError);
    expect(enqueueSpy).not.toHaveBeenCalled();
  });

  it("refuses an unpromoted target id; queue store never called", async () => {
    const { targets, queue } = await buildDeps();
    const enqueueSpy = vi.spyOn(queue, "enqueue");
    await expect(
      enqueueMission(targets, queue, { ...baseRequest, target: "staging-shop" }),
    ).rejects.toBeInstanceOf(UnknownOrUnpromotedMissionTargetError);
    expect(enqueueSpy).not.toHaveBeenCalled();
  });

  it("refuses budget.maxActions above ceiling before target resolution or any write", async () => {
    const { targets, queue } = await buildDeps();
    const resolveSpy = vi.spyOn(targets, "resolve");
    const enqueueSpy = vi.spyOn(queue, "enqueue");
    await expect(
      enqueueMission(targets, queue, { ...baseRequest, budget: { maxActions: 61 } }),
    ).rejects.toBeInstanceOf(BudgetExceedsCeilingError);
    expect(resolveSpy).not.toHaveBeenCalled();
    expect(enqueueSpy).not.toHaveBeenCalled();
  });

  it("refuses budget.maxDecisions above ceiling", async () => {
    const { targets, queue } = await buildDeps();
    const resolveSpy = vi.spyOn(targets, "resolve");
    await expect(
      enqueueMission(targets, queue, { ...baseRequest, budget: { maxDecisions: 121 } }),
    ).rejects.toBeInstanceOf(BudgetExceedsCeilingError);
    expect(resolveSpy).not.toHaveBeenCalled();
  });

  it("refuses budget.maxCandidates above ceiling", async () => {
    const { targets, queue } = await buildDeps();
    const resolveSpy = vi.spyOn(targets, "resolve");
    await expect(
      enqueueMission(targets, queue, { ...baseRequest, budget: { maxCandidates: 251 } }),
    ).rejects.toBeInstanceOf(BudgetExceedsCeilingError);
    expect(resolveSpy).not.toHaveBeenCalled();
  });

  it("refuses a schema-invalid request (two of goal/feature/route); registry and queue never called", async () => {
    const { targets, queue } = await buildDeps();
    const resolveSpy = vi.spyOn(targets, "resolve");
    const enqueueSpy = vi.spyOn(queue, "enqueue");
    await expect(
      enqueueMission(targets, queue, { ...baseRequest, feature: "checkout" }),
    ).rejects.toThrow();
    expect(resolveSpy).not.toHaveBeenCalled();
    expect(enqueueSpy).not.toHaveBeenCalled();
  });

  it("refuses a schema-invalid request (unknown top-level key); registry and queue never called", async () => {
    const { targets, queue } = await buildDeps();
    const resolveSpy = vi.spyOn(targets, "resolve");
    const enqueueSpy = vi.spyOn(queue, "enqueue");
    await expect(
      enqueueMission(targets, queue, { ...baseRequest, bogus: 1 }),
    ).rejects.toThrow();
    expect(resolveSpy).not.toHaveBeenCalled();
    expect(enqueueSpy).not.toHaveBeenCalled();
  });

  it("accepts a partial budget below ceiling; omitted fields default to the ceiling, not zero/undefined", async () => {
    const { targets, queue } = await buildDeps();
    const mission = await enqueueMission(targets, queue, {
      ...baseRequest,
      budget: { maxActions: 10 },
    });
    expect(mission.budget).toEqual({ maxActions: 10, maxDecisions: 120, maxCandidates: 250 });
  });
});
