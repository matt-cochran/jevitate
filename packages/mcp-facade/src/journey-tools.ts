import type { JourneyRegistry } from "@jevitate/journey";
import type { JourneyRunner, JourneyRunResult } from "@jevitate/runtime";
import type { RunPolicy } from "@jevitate/domain";
import type { FederatedJourneyRegistry } from "@jevitate/sources";

export interface Capability {
  id: string;
  name: string;
  description?: string;
  params: string[];
}

export interface SourcedCapability extends Capability {
  source: string;
  pin?: string;
  riskClass: "read-only" | "risky";
  trusted: boolean;
}

/**
 * Federated counterpart to `findCapabilities` (new export; existing
 * `findCapabilities`/`runJourney`/`listNamedJourneyTools` are untouched).
 * Projects `FederatedJourneyRegistry.find` results — already promoted-only
 * via each `JourneySource.list()` — onto the MCP-facing shape, tagged with
 * `source`/`pin`/`riskClass`/`trusted` so a caller can apply its own
 * run-gate policy before running one.
 */
export async function findFederatedCapabilities(
  fed: FederatedJourneyRegistry,
  query: string,
): Promise<SourcedCapability[]> {
  const metas = await fed.find(query);
  return metas.map((m) => ({
    id: `${m.source}/${m.id}`,
    name: m.name,
    description: m.description,
    params: m.params,
    source: m.source,
    pin: m.pin,
    riskClass: m.riskClass,
    trusted: m.trusted,
  }));
}

export interface NamedJourneyTool {
  name: string;
  description?: string;
  inputSchema: { type: "object"; properties: Record<string, { type: "string" }>; required: string[] };
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

/**
 * Invariant #6: one MCP tool per PROMOTED journey only (unpromoted journeys
 * produce no tool). `name` = the journey's id; `inputSchema` is a JSON-schema
 * object whose properties come from `metadata.params` (each a string), all
 * required.
 */
export async function listNamedJourneyTools(reg: JourneyRegistry): Promise<NamedJourneyTool[]> {
  const metas = await reg.find("");   // promoted-only (JourneyRegistry.find already filters)
  return metas.map((m) => ({
    name: m.id,
    description: m.description,
    inputSchema: {
      type: "object",
      properties: Object.fromEntries(m.params.map((p) => [p, { type: "string" }])),
      required: [...m.params],
    },
  }));
}
