import type { ServerLogDefect } from "./log-correlation.js";

/**
 * The versioned result schema every explore strategy's result follows (#195 part 5) — defined in
 * `@jevitate/domain` (zod + TS) and re-exported here as part of the CLI's published surface. See
 * `mission-result.ts` there for the contract; this module holds the helpers the runners fill the
 * common fields with, so every strategy fills them the same way.
 */
export {
  MISSION_RESULT_SCHEMA_VERSION,
  MissionResultSchema,
  PersistedMissionResultSchema,
  RESULT_STRATEGIES,
  RESULT_MISSION_OUTCOMES,
  ResultDefectSchema,
  type MissionResult,
  type MissionResultCore,
  type PersistedMissionResult,
  type ResultDefect,
  type ResultMissionOutcome,
  type ResultStrategy,
} from "@jevitate/domain";

/** A `server-log` defect a strategy reports but never gates on (usability: every UX finding is advisory). */
export type AdvisoryServerLogDefect = ServerLogDefect & { readonly advisory: true };

/**
 * All of a run's defects in ONE list (#195): the strategy's own (hard-signal / declared-invariant)
 * defects first, then its `server-log` defects — each fingerprint once. What `defects` holds on every
 * strategy's result; `serverLogDefects` remains only as a deprecated alias of the server-log subset.
 */
export function unifiedDefects<D extends { readonly fingerprint: string }>(
  own: readonly D[] | undefined,
  serverLog: readonly ServerLogDefect[] | undefined,
): Array<D | ServerLogDefect> {
  const seen = new Set<string>();
  const out: Array<D | ServerLogDefect> = [];
  for (const d of [...(own ?? []), ...(serverLog ?? [])]) {
    if (seen.has(d.fingerprint)) continue;
    seen.add(d.fingerprint);
    out.push(d);
  }
  return out;
}

/** A usability run's `server-log` defects, marked advisory: reported in `defects`, never gating its outcome. */
export function advisoryDefects(serverLog: readonly ServerLogDefect[] | undefined): AdvisoryServerLogDefect[] {
  return unifiedDefects([], serverLog).map((d) => ({ ...d, advisory: true as const }));
}
