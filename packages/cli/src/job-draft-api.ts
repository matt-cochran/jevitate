import type { DesiredOutcome } from "@jevitate/journey";
import type { CliDeps } from "./cli-shared.js";
import { NotImplementedError } from "./not-implemented.js";

/**
 * #465b — `jevitate job draft-outcomes <jobId>` / MCP `draft_job_outcomes`: draft 1–3 desired
 * outcomes for one catalog job with the generation model and write them into its jobs file marked
 * `provenance: "ai_draft"` for the team to review. It NEVER approves anything: the job's approval is
 * left as it was (editing the job makes an existing approval stale, as any edit does), and approving
 * stays a person's act (`jevitate job approve`, CLI only).
 *
 * STUB (d-surface-0): the feature deliverable replaces the body of `draftJobOutcomes` and owns this file.
 */

/** The fewest / most outcomes one call drafts (`--count`, default 1). */
export const DRAFT_OUTCOMES_MIN = 1;
export const DRAFT_OUTCOMES_MAX = 3;

export interface DraftJobOutcomesRequest {
  /** The project data dir holding jobs.json (`--dir`, else the repo's `.jevitate/`); null outside a project. */
  readonly catalogDir: string | null;
  /** The journeys dir the catalog's Journeys load from (anchor names a drafted metric may reference). */
  readonly journeysDir: string;
  /** The catalog job id (CATALOG_ID_RE; validated by the command). */
  readonly jobId: string;
  /** How many outcomes to draft: DRAFT_OUTCOMES_MIN..DRAFT_OUTCOMES_MAX. */
  readonly count: number;
  /** The generation gateway selection (`--real` live, `--fake-ai` deterministic); exactly one is true. */
  readonly ai: { readonly real: boolean; readonly fakeAi: boolean };
}

export interface DraftJobOutcomesResult {
  readonly jobId: string;
  /** The drafted outcomes, as written to the jobs file (schema-checked `DesiredOutcome`s). */
  readonly outcomes: readonly DesiredOutcome[];
  /** Always `ai_draft`: drafted content is the weakest provenance until the team reviews it. */
  readonly provenance: "ai_draft";
  /** The jobs file that was written. */
  readonly jobsFile: string;
  /** Always false: drafting never approves. */
  readonly approved: false;
  /** The job's approval state after the write (an approved job becomes `stale` = needs re-review). */
  readonly approvalStatus: "draft" | "approved" | "stale";
}

/** Drafts and writes the outcomes. `deps` gives the feature the CLI's gateway builders (buildExploreGateways). */
export async function draftJobOutcomes(_req: DraftJobOutcomesRequest, _deps: CliDeps): Promise<DraftJobOutcomesResult> {
  throw new NotImplementedError("jevitate job draft-outcomes", "#465");
}

/** The human rendering (no `--json`). */
export function renderDraftJobOutcomes(r: DraftJobOutcomesResult): string {
  const lines = r.outcomes.map((o) => `  - ${o.id}: ${o.direction} the ${o.measure} ${o.object}`);
  return `drafted ${r.outcomes.length} outcome(s) for job '${r.jobId}' (provenance ai_draft) in ${r.jobsFile}\n${lines.join("\n")}\nnext: review them, then a person approves: jevitate job review ${r.jobId} · jevitate job approve ${r.jobId}\n`;
}
