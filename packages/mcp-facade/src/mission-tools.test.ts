import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, expect } from "vitest";
import {
  FsMissionTargetStore,
  MissionTargetRegistry,
  FsMissionQueueStore,
  UnknownOrUnpromotedMissionTargetError,
  BudgetExceedsCeilingError,
  type MissionTarget,
} from "@jevitate/missions";
import { queueExploration } from "./index.js";

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
  const targetDir = mkdtempSync(join(tmpdir(), "mcp-mission-targets-"));
  const queueDir = mkdtempSync(join(tmpdir(), "mcp-mission-queue-"));
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

describe("queueExploration", () => {
  it("returns { ok: true, missionId, status: 'queued' } and the mission is present in the queue afterward", async () => {
    const { targets, queue } = await buildDeps();
    const result = await queueExploration(targets, queue, baseRequest);
    expect(result.ok).toBe(true);
    expect(result.status).toBe("queued");
    expect(await queue.get(result.missionId)).not.toBeNull();
  });

  it("propagates UnknownOrUnpromotedMissionTargetError for an unpromoted target", async () => {
    const { targets, queue } = await buildDeps();
    await expect(
      queueExploration(targets, queue, { ...baseRequest, target: "staging-shop" }),
    ).rejects.toBeInstanceOf(UnknownOrUnpromotedMissionTargetError);
  });

  it("propagates UnknownOrUnpromotedMissionTargetError for an unknown target", async () => {
    const { targets, queue } = await buildDeps();
    await expect(
      queueExploration(targets, queue, { ...baseRequest, target: "nonexistent" }),
    ).rejects.toBeInstanceOf(UnknownOrUnpromotedMissionTargetError);
  });

  it("propagates BudgetExceedsCeilingError for an over-ceiling budget", async () => {
    const { targets, queue } = await buildDeps();
    await expect(
      queueExploration(targets, queue, { ...baseRequest, budget: { maxActions: 61 } }),
    ).rejects.toBeInstanceOf(BudgetExceedsCeilingError);
  });
});
