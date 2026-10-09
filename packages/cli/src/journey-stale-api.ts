import { NotImplementedError } from "./not-implemented.js";

/**
 * #467 (review sheet) — `jevitate journey review --stale` / MCP `review_journey {stale: true}`:
 * read-only. Every promoted Journey whose approval no longer matches its content hash, each labelled
 * with what changed — `stepIdOnly: true` when the only difference from the approved content is the
 * minted step ids (`journey migrate --step-ids`), so a reviewer can re-approve those quickly. It
 * never approves (re-approval is `jevitate journey promote <id>`).
 *
 * STUB (d-surface-0): the feature deliverable replaces the body of `listStaleJourneys` and owns this file.
 */

export interface StaleJourneysRequest {
  /** The journeys dir (`--dir`, else the repo's `.jevitate/journeys`). */
  readonly journeysDir: string;
  /** The catalog dir (linked personas/jobs whose approvals also make a Journey stale); null outside a project. */
  readonly catalogDir: string | null;
}

export interface StaleJourney {
  readonly id: string;
  readonly name: string;
  /** The content hash the approval was bound to. */
  readonly approvedHash: string;
  /** The Journey's content hash now (bind a re-approval to it: `journey promote <id> --reviewed-hash`). */
  readonly contentHash: string;
  /** True when the only change since approval is minted step ids (#467). */
  readonly stepIdOnly: boolean;
  /** One line: what changed (steps, assertions, linked catalog items, step ids only, …). */
  readonly reason: string;
}

export interface StaleJourneysResult {
  readonly journeys: readonly StaleJourney[];
  readonly total: number;
  /** How many of them changed only by step ids. */
  readonly stepIdOnly: number;
}

export async function listStaleJourneys(_req: StaleJourneysRequest): Promise<StaleJourneysResult> {
  throw new NotImplementedError("jevitate journey review --stale", "#467");
}

/** The human rendering (no `--json`). */
export function renderStaleJourneys(r: StaleJourneysResult): string {
  if (r.total === 0) return "no promoted Journey needs re-approval\n";
  const lines = r.journeys.map((j) => `${j.stepIdOnly ? "STEP-IDS" : "CHANGED "} ${j.id} — ${j.reason}`);
  return `${lines.join("\n")}\n${r.total} Journey(s) need re-approval (${r.stepIdOnly} step-id-only)\nnext: jevitate journey review <id> · jevitate journey promote <id>\n`;
}
