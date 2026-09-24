import { randomUUID } from "node:crypto";
import { validateInvariantSpec } from "@jevitate/recording";
import { MissionRequestSchema, type MissionRequest, type QueuedMission } from "./schema.js";
import { MISSION_BOUNDS_CEILING, type Budget } from "./bounds.js";
import { BudgetExceedsCeilingError } from "./errors.js";
import type { MissionTargetRegistry } from "./target-registry.js";
import type { MissionQueueStore } from "./queue-store.js";

/**
 * Resolves a request's optional partial budget against the hard ceiling.
 * Any provided field ABOVE the ceiling throws `BudgetExceedsCeilingError` —
 * never clamped down. Omitted fields default to the ceiling value itself
 * (the ceiling doubles as "as much as you're allowed to ask for by
 * default").
 */
function resolveBudget(partial: MissionRequest["budget"]): Budget {
  const maxActions = partial?.maxActions ?? MISSION_BOUNDS_CEILING.maxActions;
  const maxDecisions = partial?.maxDecisions ?? MISSION_BOUNDS_CEILING.maxDecisions;
  const maxCandidates = partial?.maxCandidates ?? MISSION_BOUNDS_CEILING.maxCandidates;

  if (maxActions > MISSION_BOUNDS_CEILING.maxActions) {
    throw new BudgetExceedsCeilingError(
      `budget.maxActions (${maxActions}) exceeds MISSION_BOUNDS_CEILING.maxActions (${MISSION_BOUNDS_CEILING.maxActions})`,
    );
  }
  if (maxDecisions > MISSION_BOUNDS_CEILING.maxDecisions) {
    throw new BudgetExceedsCeilingError(
      `budget.maxDecisions (${maxDecisions}) exceeds MISSION_BOUNDS_CEILING.maxDecisions (${MISSION_BOUNDS_CEILING.maxDecisions})`,
    );
  }
  if (maxCandidates > MISSION_BOUNDS_CEILING.maxCandidates) {
    throw new BudgetExceedsCeilingError(
      `budget.maxCandidates (${maxCandidates}) exceeds MISSION_BOUNDS_CEILING.maxCandidates (${MISSION_BOUNDS_CEILING.maxCandidates})`,
    );
  }

  return { maxActions, maxDecisions, maxCandidates };
}

/**
 * The ONE domain entrypoint for turning a raw MCP `queue_exploration` call
 * into a `QueuedMission` on disk. Order of checks matters — each is a
 * fail-closed gate BEFORE the next, so no partial work happens on refusal:
 *   1. schema shape (zod `.strict()` + exactly-one-of goal/feature/route)
 *   2. budget ceiling (never clamp, never silently downgrade)
 *   3. target resolution (promoted-only; never a raw URL), then declared-invariant probes
 *      authorized against that target's origin (#86)
 *   4. write (the queue store re-validates via QueuedMissionSchema)
 */
export async function enqueueMission(
  targets: MissionTargetRegistry,
  queue: MissionQueueStore,
  rawRequest: unknown,
  deps: { idGen?: () => string; clock?: () => string } = {},
): Promise<QueuedMission> {
  const request = MissionRequestSchema.parse(rawRequest); // schema refusal first — no I/O yet
  const budget = resolveBudget(request.budget); // throws BudgetExceedsCeilingError before any lookup
  const target = await targets.resolve(request.target); // throws UnknownOrUnpromotedMissionTargetError
  // Declared invariants (#86): a probe may only ever read the target's own authorized origin —
  // checked against the resolved target BEFORE the write (throws `InvariantSpecError`).
  if (request.invariants !== undefined) {
    validateInvariantSpec(request.invariants, { allowlist: [target.authorizedOrigin], baseUrl: target.baseUrl });
  }

  const mission: QueuedMission = {
    ...request,
    id: (deps.idGen ?? (() => randomUUID()))(),
    status: "queued",
    enqueuedAtIso: (deps.clock ?? (() => new Date().toISOString()))(),
    budget,
  };
  await queue.enqueue(mission); // FsMissionQueueStore re-validates via QueuedMissionSchema before writing
  return mission;
}
