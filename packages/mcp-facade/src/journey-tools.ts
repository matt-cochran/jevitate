import type { JourneyRegistry } from "@doit/journey";
import type { JourneyRunner, JourneyRunResult } from "@doit/runtime";
import type { RunPolicy } from "@doit/domain";

export interface Capability {
  id: string;
  name: string;
  description?: string;
  params: string[];
}

/**
 * Invariant #6: lists ONLY promoted Journeys. `JourneyRegistry.find` already
 * filters to `metadata.promoted === true` — this is a thin, promoted-only
 * projection onto the shape the MCP facade exposes, never a raw passthrough
 * of internal registry/store types.
 */
export async function findCapabilities(reg: JourneyRegistry, query: string): Promise<Capability[]> {
  const metas = await reg.find(query);
  return metas.map((m) => ({ id: m.id, name: m.name, description: m.description, params: m.params }));
}

/**
 * Invariant #5/#6: resolves a PUBLISHED (promoted) journey id from the
 * registry only — never accepts inline steps. An unknown or unpromoted id
 * fails closed. Param validation and `RunPolicy` enforcement are entirely
 * delegated to `JourneyRunner.run` (invariants #5/#1) — this function never
 * duplicates that logic.
 *
 * RULING 1: `policy` is an EXPLICIT, required parameter — the caller (the
 * MCP server wiring) must thread the session's `RunPolicy` in. This never
 * reads a global and never defaults the policy.
 */
export async function runJourney(
  reg: JourneyRegistry,
  runner: JourneyRunner,
  id: string,
  params: Record<string, string>,
  policy: RunPolicy,
): Promise<JourneyRunResult> {
  const journey = await reg.get(id);
  if (!journey || !journey.metadata.promoted) {
    throw new Error(`unknown or unpublished journey '${id}'`);
  }
  return runner.run({ journey, params, policy });
}
