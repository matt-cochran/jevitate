import { enqueueMission, type MissionTargetRegistry, type MissionQueueStore } from "@jevitate/missions";

export interface QueueExplorationResult {
  ok: true;
  missionId: string;
  status: "queued";
}

/**
 * Invariant #5/#6 analogue for missions: resolves a PROMOTED target by id
 * only, refuses out-of-schema params and over-ceiling budgets, and never
 * runs anything — it only enqueues. All validation is delegated to
 * `enqueueMission` (never duplicated here), matching `runJourney`'s shape.
 */
export async function queueExploration(
  targets: MissionTargetRegistry,
  queue: MissionQueueStore,
  args: unknown,
): Promise<QueueExplorationResult> {
  const mission = await enqueueMission(targets, queue, args);
  return { ok: true, missionId: mission.id, status: "queued" };
}
