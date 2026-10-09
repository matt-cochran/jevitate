import { FsJourneyStore, stampAnchorStepIds, type Journey } from "@jevitate/journey";
import { ensureStepIds } from "@jevitate/recording";

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
 * Scope: every local Journey (promoted or draft, namespace folders included) via the journey store,
 * so formatting and file mode match every other write. NOT migrated: the sources cache (remote
 * Journeys are content-hash-trusted and never rewritten), `.jevitate/logs` recordings (TTL run
 * output, regenerated), and regression captures (they replay by the ids they were captured with).
 * Never mints on read; idempotent (a second run finds nothing to change).
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

export async function migrateStepIds(req: MigrateStepIdsRequest): Promise<MigrateStepIdsResult> {
  const store = new FsJourneyStore(req.journeysDir);
  const journeys: MigratedJourney[] = [];
  for (const meta of await store.list()) {
    const before = await store.get(meta.id);
    if (before === null) continue;
    const withIds: Journey = { ...before, recording: ensureStepIds(before.recording) };
    const after = stampAnchorStepIds(withIds);
    const stepsMinted = countIds(after) - countIds(before);
    const anchorsLinked = countAnchorIds(after) - countAnchorIds(before);
    if (stepsMinted === 0 && anchorsLinked === 0) continue;
    if (!req.dryRun) await store.put(after);
    journeys.push({ id: meta.id, stepsMinted, anchorsLinked, needsReapproval: before.metadata.promoted });
  }
  return {
    dryRun: req.dryRun,
    journeys,
    recordings: [],
    totals: {
      files: journeys.length,
      stepsMinted: journeys.reduce((n, j) => n + j.stepsMinted, 0),
      needsReapproval: journeys.filter((j) => j.needsReapproval).length,
    },
  };
}

const countIds = (j: Journey): number => j.recording.pages.reduce((n, p) => n + p.steps.filter((s) => s.stepId !== undefined).length, 0);
const countAnchorIds = (j: Journey): number => (j.metadata.anchors ?? []).filter((a) => a.stepId !== undefined).length;

/** The human rendering (no `--json`). */
export function renderMigrateStepIds(r: MigrateStepIdsResult): string {
  const verb = r.dryRun ? "would mint" : "minted";
  return (
    `${verb} ${r.totals.stepsMinted} step id(s) in ${r.totals.files} file(s); ${r.totals.needsReapproval} promoted Journey(s) need re-approval\n` +
    (r.totals.needsReapproval > 0 ? "next: jevitate journey review --stale\n" : "")
  );
}
