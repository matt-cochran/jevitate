import { NotImplementedError } from "./not-implemented.js";

/**
 * #467b — `jevitate journey migrate --step-ids`: the one-time repo rewrite that mints a stable
 * `stepId` (short slug, e.g. `s-7f3k2a`, `[a-z0-9._:-]`, unique within a Journey) on every recorded
 * step that has none — every Journey in the journeys dir and every other recording under the project
 * dir — and points each anchor at its step by `stepId`. Ids already present are kept.
 *
 * It changes every promoted Journey's content hash, so each one needs re-approval afterwards: the
 * result lists them, and `jevitate journey review --stale` lists them later (labelled stepId-only).
 * It never approves. CLI only (a one-time rewrite of the repo the operator runs and commits; no MCP
 * tool — see EXCLUDED in mcp-cli-parity.test.ts).
 *
 * STUB (d-surface-0): the feature deliverable replaces the body of `migrateStepIds` and owns this file.
 */

export interface MigrateStepIdsRequest {
  /** The journeys dir (`--dir`, else the repo's `.jevitate/journeys`). */
  readonly journeysDir: string;
  /** The project data dir (`.jevitate/`) whose other recordings (regressions, recordings) are backfilled too; null outside a project. */
  readonly projectDir: string | null;
  /** `--dry-run`: report what would change, write nothing. */
  readonly dryRun: boolean;
}

export interface MigratedJourney {
  readonly id: string;
  /** Steps that received a new `stepId`. */
  readonly stepsMinted: number;
  /** Anchors re-pointed by `stepId`. */
  readonly anchorsLinked: number;
  /** True when it was promoted with an approval its new hash no longer matches. */
  readonly needsReapproval: boolean;
}

export interface MigratedRecording {
  readonly path: string;
  readonly stepsMinted: number;
}

export interface MigrateStepIdsResult {
  readonly dryRun: boolean;
  readonly journeys: readonly MigratedJourney[];
  readonly recordings: readonly MigratedRecording[];
  readonly totals: { readonly files: number; readonly stepsMinted: number; readonly needsReapproval: number };
}

export async function migrateStepIds(_req: MigrateStepIdsRequest): Promise<MigrateStepIdsResult> {
  throw new NotImplementedError("jevitate journey migrate --step-ids", "#467");
}

/** The human rendering (no `--json`). */
export function renderMigrateStepIds(r: MigrateStepIdsResult): string {
  const verb = r.dryRun ? "would mint" : "minted";
  return (
    `${verb} ${r.totals.stepsMinted} step id(s) in ${r.totals.files} file(s); ${r.totals.needsReapproval} promoted Journey(s) need re-approval\n` +
    (r.totals.needsReapproval > 0 ? "next: jevitate journey review --stale\n" : "")
  );
}
