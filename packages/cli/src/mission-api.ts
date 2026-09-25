import { existsSync } from "node:fs";
import type { Command } from "commander";
import { resolve as resolvePath } from "node:path";
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
  /** Extra origins the app talks to (its API on another origin) — the MCP analogue of a 2nd `--allow`. */
  apiOrigins?: string[];
  baseUrl: string;
  description?: string;
  /** #175: operator-declared session for queued missions (see `MissionTargetAuthInput`). */
  auth?: MissionTargetAuthInput;
}

/**
 * #175: the auth an operator sets on a mission target — CLI only (`mission target add|update`),
 * never an MCP argument. `storageState` must exist; paths are made absolute here.
 */
export interface MissionTargetAuthInput {
  storageState?: string;
  /** `true` = write the rotated session back to `storageState`; a string = another path. */
  saveStorageState?: true | string;
  secretFields?: string[];
  /** `update` only: drop every auth field first. */
  clear?: boolean;
}

export class MissionTargetAuthError extends Error {}

/** The CLI flags behind `MissionTargetAuthInput` (`mission target add|update`). */
export interface MissionTargetAuthFlags {
  storageState?: string;
  saveStorageState?: true | string;
  secretField?: string[];
}

/** Adds `--storage-state`, `--save-storage-state [file]` and `--secret-field` (repeatable). */
export function withMissionTargetAuthFlags(cmd: Command): Command {
  return cmd
    .option("--storage-state <file>", "#175: Playwright storageState JSON queued missions on this target start from (must exist; wins over targets.json)")
    .option(
      "--save-storage-state [file]",
      "#175: write the rotated session back after each queued mission — to --storage-state (no value) or to <file>; for rotating refresh tokens",
    )
    .option(
      "--secret-field <spec>",
      "#175: '<label|testId|type|id|name>=<value>=env:<VAR>' typed by queued goal missions (repeatable); the value is read from the environment at run time",
      (v: string, prev: string[] | undefined) => [...(prev ?? []), v],
    );
}

/** The auth input the flags ask for, or `undefined` when none was given. */
export function missionTargetAuth(f: MissionTargetAuthFlags): MissionTargetAuthInput | undefined {
  if (f.storageState === undefined && f.saveStorageState === undefined && (f.secretField ?? []).length === 0) return undefined;
  return {
    ...(f.storageState === undefined ? {} : { storageState: f.storageState }),
    ...(f.saveStorageState === undefined ? {} : { saveStorageState: f.saveStorageState }),
    ...((f.secretField ?? []).length === 0 ? {} : { secretFields: f.secretField }),
  };
}

function applyAuth(target: MissionTarget, auth: MissionTargetAuthInput | undefined): MissionTarget {
  if (auth === undefined) return target;
  const base: MissionTarget = { ...target };
  if (auth.clear === true) {
    delete base.storageState;
    delete base.saveStorageState;
    delete base.secretFields;
  }
  if (auth.storageState !== undefined) {
    const abs = resolvePath(auth.storageState);
    if (!existsSync(abs)) throw new MissionTargetAuthError(`storage state not found: ${abs}`);
    base.storageState = abs;
  }
  if (auth.saveStorageState !== undefined) base.saveStorageState = auth.saveStorageState === true ? true : resolvePath(auth.saveStorageState);
  if (auth.secretFields !== undefined && auth.secretFields.length > 0) base.secretFields = [...auth.secretFields];
  return base;
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
  const target: MissionTarget = applyAuth(
    {
      id: input.id,
      name: input.name,
      authorizedOrigin: input.authorizedOrigin,
      ...(input.apiOrigins !== undefined && input.apiOrigins.length > 0 ? { apiOrigins: [...input.apiOrigins] } : {}),
      baseUrl: input.baseUrl,
      ...(input.description !== undefined ? { description: input.description } : {}),
      promoted: false,
      createdAtIso: nowIso(),
    },
    input.auth,
  );
  await ctx.registry.put(target);
  return target;
}

/**
 * #175: sets (or clears) a registered target's operator-declared auth. Keeps its promotion state —
 * auth is not part of what promotion approved (origins are, and they cannot change here). An
 * unknown id is refused with `UnknownMissionTargetError`.
 */
export async function updateMissionTargetAuth(ctx: MissionTargetContext, id: string, auth: MissionTargetAuthInput): Promise<MissionTarget> {
  const existing = await ctx.store.get(id);
  if (!existing) throw new UnknownMissionTargetError(`unknown mission target '${id}'`);
  const next = applyAuth(existing, auth);
  await ctx.registry.put(next);
  return next;
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
