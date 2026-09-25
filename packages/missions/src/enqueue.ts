import { randomUUID } from "node:crypto";
import { InvariantSpecError, invariantAuthSecretRefs, validateInvariantSpec } from "@jevitate/recording";
import { MissionRequestSchema, targetAllowlist, type MissionRequest, type QueuedMission } from "./schema.js";
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
  // Declared invariants (#86): a probe may only ever read the target's own authorized origins (its
  // app origin and declared API origins) — checked against the resolved target BEFORE the write
  // (throws `InvariantSpecError`).
  if (request.invariants !== undefined) {
    validateInvariantSpec(request.invariants, { allowlist: targetAllowlist(target), baseUrl: target.baseUrl });
    // An `authFrom.secret` (`env:VAR`) would let the caller choose which of the operator's
    // environment variables is sent to the target — never from a queued request. Refused here,
    // rather than run with probes that silently never authenticate.
    const refs = invariantAuthSecretRefs(request.invariants);
    if (refs.length > 0) {
      throw new InvariantSpecError([
        `authFrom.secret (${refs.join(", ")}) is not accepted in a queued mission: a request never chooses which environment variable is sent; use authFrom.localStorage or authFrom.cookie (the target's own session)`,
      ]);
    }
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
