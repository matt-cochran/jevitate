import type { JourneyRegistry } from "@jevitate/journey";
import type { JourneyRunner, JourneyRunResult } from "@jevitate/runtime";
import type { RunPolicy } from "@jevitate/domain";

export interface Capability {
  id: string;
  name: string;
  description?: string;
  params: string[];
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
 * #788: where a Journey's approval stands. `current`: its approval matches its content (and nothing it
 * is linked to went stale). `stale`: what `review_journey`/`journey review --stale` report. `unrecorded`:
 * marked promoted with no approval on record (hand-edited), so nothing binds it to reviewed content.
 * `undetermined`: the state could not be read. Only `promoted` + `current` may run over MCP.
 */
export type JourneyApprovalState =
  | { readonly promoted: boolean; readonly approval: "current" | "unrecorded" | "undetermined" }
  | { readonly promoted: true; readonly approval: "stale"; readonly reason: string; readonly contentHash: string };

export type JourneyRunRefusalCode = "E_JOURNEY_NOT_PROMOTED" | "E_JOURNEY_APPROVAL_STALE" | "E_JOURNEY_APPROVAL_UNKNOWN";

/** #788: a Journey a served run refuses, before any browser: its code and the command that fixes it. Never carries a parameter value. */
export class JourneyRunRefusedError extends Error {
  override readonly name = "JourneyRunRefusedError";
  readonly retryable = false;
  constructor(
    readonly code: JourneyRunRefusalCode,
    message: string,
    /** The command that fixes it. */
    readonly fix: string,
    /** How to try a draft without promoting it (the CLI; an MCP run never does). */
    readonly tryDraft: string,
  ) {
    super(message);
  }
}

/**
 * #788: the one promotion gate of a served run. Throws `JourneyRunRefusedError` unless the Journey is
 * promoted and its approval current; fails closed when the state could not be determined.
 */
export function assertJourneyRunnable(id: string, state: JourneyApprovalState): void {
  const tryDraft = `jevitate journey run ${id}`;
  if (state.approval === "undetermined") {
    throw new JourneyRunRefusedError("E_JOURNEY_APPROVAL_UNKNOWN", `journey '${id}': its promotion or approval state could not be read, so it does not run over MCP. Check it with: jevitate journey review ${id}`, `jevitate journey review ${id}`, tryDraft);
  }
  if (!state.promoted) {
    const fix = `jevitate journey promote ${id}`;
    throw new JourneyRunRefusedError("E_JOURNEY_NOT_PROMOTED", `journey '${id}' is not promoted, and MCP runs only promoted Journeys. Promote it with the promote_journey tool or \`${fix}\`; to try a draft first, use the CLI: \`${tryDraft}\``, fix, tryDraft);
  }
  if (state.approval === "stale") {
    const fix = `jevitate journey promote ${id} --reviewed-hash ${state.contentHash}`;
    throw new JourneyRunRefusedError("E_JOURNEY_APPROVAL_STALE", `journey '${id}' changed after its approval: ${state.reason}. Review it (\`jevitate journey review ${id}\`), then re-approve it with \`${fix}\` or promote_journey with reviewedHash; to try it unapproved, use the CLI: \`${tryDraft}\``, fix, tryDraft);
  }
  if (state.approval === "unrecorded") {
    const fix = `jevitate journey promote ${id}`;
    throw new JourneyRunRefusedError("E_JOURNEY_APPROVAL_UNKNOWN", `journey '${id}' is marked promoted but has no approval on record, so nothing binds it to reviewed content. Approve it with the promote_journey tool or \`${fix}\`; to try it first, use the CLI: \`${tryDraft}\``, fix, tryDraft);
  }
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
