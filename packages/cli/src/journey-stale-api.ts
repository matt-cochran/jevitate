import { FsJourneyStore, type Journey } from "@jevitate/journey";
import { isStepIdOnlyChange } from "./journey-anchor-gate.js";
import { journeyReviewHash } from "./journey-review.js";
import { readApprovedSnapshot } from "./journey-review-store.js";
import { loadCatalog } from "./catalog-api.js";
import { catalogJourney, journeyLinks } from "./catalog.js";

/**
 * #467 (review sheet) — `jevitate journey review --stale` / MCP `review_journey {stale: true}`:
 * read-only. Every promoted Journey whose approval no longer matches its content hash, each labelled
 * with what changed — `stepIdOnly: true` when the only difference from the approved content is the
 * minted step ids (`journey migrate --step-ids`), so a reviewer can re-approve those quickly. It
 * never approves (re-approval is `jevitate journey promote <id>`).
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
  /** The commands to review and re-approve it. */
  readonly reviewCommand: string;
  readonly approveCommand: string;
}

export interface StaleJourneysResult {
  readonly journeys: readonly StaleJourney[];
  readonly total: number;
  /** How many of them changed only by step ids. */
  readonly stepIdOnly: number;
}

/** #467: true when the approval is stale and the only change since is minted step ids (against the snapshot, else the approved hash). */
export function isStepIdOnlyStale(journey: Journey, snapshot: Journey | null): boolean {
  const approval = journey.metadata.approval;
  if (approval === undefined || approval.contentHash === journeyReviewHash(journey)) return false;
  if (snapshot !== null && journeyReviewHash(snapshot) === approval.contentHash) return isStepIdOnlyChange(snapshot, journey);
  return isStepIdOnlyChange(approval.contentHash, journey);
}

export async function listStaleJourneys(req: StaleJourneysRequest): Promise<StaleJourneysResult> {
  const store = new FsJourneyStore(req.journeysDir);
  const catalog = await loadCatalog(req.catalogDir, req.journeysDir);
  const journeys: StaleJourney[] = [];
  for (const meta of await store.list()) {
    if (!meta.promoted) continue;
    const journey = await store.get(meta.id);
    if (journey === null) continue;
    const approval = journey.metadata.approval;
    if (approval === undefined) continue;
    const contentHash = journeyReviewHash(journey);
    const hashStale = approval.contentHash !== contentHash;
    const links = journeyLinks(catalog, catalogJourney(journey));
    const catalogStale = !hashStale && links.linked && [links.job?.status, links.persona?.status].includes("stale");
    if (!hashStale && !catalogStale) continue;
    const snapshot = await readApprovedSnapshot(req.journeysDir, meta.id);
    const stepIdOnly = hashStale && isStepIdOnlyStale(journey, snapshot);
    journeys.push({
      id: meta.id,
      name: journey.metadata.name,
      approvedHash: approval.contentHash,
      contentHash,
      stepIdOnly,
      reason: stepIdOnly ? "ids added only (warn path)" : hashStale ? "content changed since approval (steps, assertions or side effects)" : "a linked catalog job/persona changed since its approval",
      reviewCommand: `jevitate journey review ${meta.id}`,
      approveCommand: `jevitate journey promote ${meta.id} --reviewed-hash ${contentHash}`,
    });
  }
  return { journeys, total: journeys.length, stepIdOnly: journeys.filter((j) => j.stepIdOnly).length };
}

/** The human rendering (no `--json`). */
export function renderStaleJourneys(r: StaleJourneysResult): string {
  if (r.total === 0) return "no promoted Journey needs re-approval\n";
  const lines = r.journeys.map((j) => `${j.stepIdOnly ? "STEP-IDS" : "CHANGED "} ${j.id} — ${j.reason}\n           review: ${j.reviewCommand}\n           approve: ${j.approveCommand}`);
  return `${lines.join("\n")}\n${r.total} Journey(s) need re-approval (${r.stepIdOnly} step-id-only)\n`;
}
