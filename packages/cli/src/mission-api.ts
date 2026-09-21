import {
  FsMissionTargetStore,
  MissionTargetRegistry,
  type MissionTarget,
  type MissionTargetStore,
} from "@jevitate/missions";

/**
 * Distinct from `@jevitate/missions`' generic promote error so the CLI can map
 * "no such target to promote" to its own error code (E_UNKNOWN_MISSION_TARGET)
 * without string-matching an error message — mirrors `journey-api.ts`'s
 * `UnknownJourneyError`.
 */
export class UnknownMissionTargetError extends Error {}

/**
 * The store + registry pair the CLI operates on. Bundling them makes the
 * unit-testable seam a single injectable value: production wires the real
 * fs-backed pair via `missionTargetContext(dir)`, while tests can inject an
 * in-memory `MissionTargetStore`.
 */
export interface MissionTargetContext {
  store: MissionTargetStore;
  registry: MissionTargetRegistry;
}

/**
 * Builds the real fs-backed store + registry for a targets directory. This is
 * the ONE place the CLI locates the same on-disk store that `queue_exploration`
 * resolves against (via `MissionTargetRegistry.resolve`), so a target
 * registered/promoted here is exactly the one the MCP tool can resolve.
 */
export function missionTargetContext(dir: string): MissionTargetContext {
  const store = new FsMissionTargetStore(dir);
  return { store, registry: new MissionTargetRegistry(store) };
}

export interface AddMissionTargetInput {
  id: string;
  name: string;
  authorizedOrigin: string;
  baseUrl: string;
  description?: string;
}

/**
 * Registers a mission target. SECURITY: registering is NOT the same as
 * promoting — a freshly-added target is `promoted: false`, so
 * `queue_exploration` (`MissionTargetRegistry.resolve`) refuses it until a
 * separate `promote` flips the gate. `registry.put` re-validates against
 * `MissionTargetSchema` BEFORE any disk write (fail-closed: an invalid target
 * — e.g. a path-unsafe id — is never persisted).
 */
export async function addMissionTarget(
  ctx: MissionTargetContext,
  input: AddMissionTargetInput,
  nowIso: () => string = () => new Date().toISOString(),
): Promise<MissionTarget> {
  const target: MissionTarget = {
    id: input.id,
    name: input.name,
    authorizedOrigin: input.authorizedOrigin,
    baseUrl: input.baseUrl,
    ...(input.description !== undefined ? { description: input.description } : {}),
    promoted: false,
    createdAtIso: nowIso(),
  };
  await ctx.registry.put(target);
  return target;
}

/**
 * Lists ALL mission targets (promoted and unpromoted) straight from the store
 * — a local/dev-facing listing of everything on disk. This mirrors
 * `journey list` (store-direct, all) vs `journey find` (registry, promoted-
 * only): the promoted-only projection is what `queue_exploration` sees, not
 * this listing.
 */
export function listMissionTargets(ctx: MissionTargetContext): Promise<MissionTarget[]> {
  return ctx.store.list();
}

/**
 * Promotes a registered target so `queue_exploration` can resolve it. An
 * unknown id is refused with `UnknownMissionTargetError` (never silently
 * created). Returns the persisted, now-promoted target.
 */
export async function promoteMissionTarget(
  ctx: MissionTargetContext,
  id: string,
): Promise<MissionTarget> {
  const existing = await ctx.store.get(id);
  if (!existing) {
    throw new UnknownMissionTargetError(`unknown mission target '${id}'`);
  }
  await ctx.registry.promote(id);
  const promoted = await ctx.store.get(id);
  return promoted ?? { ...existing, promoted: true };
}
