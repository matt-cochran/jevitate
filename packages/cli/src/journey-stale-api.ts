import { FsJourneyStore, type Journey } from "@jevitate/journey";
import { assertJourneyRunnable, JourneyRunRefusedError, type JourneyApprovalState } from "@jevitate/mcp-facade";
import { isStepIdOnlyChange } from "./journey-anchor-gate.js";
import { journeyApprovalMatches, journeyLegacyReviewHash, journeyReviewHash } from "./journey-review.js";
import { readApprovedSnapshot } from "./journey-review-store.js";
import { loadCatalog, resolveCatalogDir } from "./catalog-api.js";
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
  if (approval === undefined || journeyApprovalMatches(journey)) return false;
  if (snapshot !== null && [journeyReviewHash(snapshot), journeyLegacyReviewHash(snapshot)].includes(approval.contentHash)) return isStepIdOnlyChange(snapshot, journey);
  return isStepIdOnlyChange(approval.contentHash, journey);
}

type LoadedCatalog = Awaited<ReturnType<typeof loadCatalog>>;

/** #467/#788: why this promoted Journey's approval is stale, or null when it is not: the one definition, for the list and for the run gate. */
function staleness(journey: Journey, catalog: LoadedCatalog): { readonly hashStale: boolean; readonly reason: string } | null {
  if (!journeyApprovalMatches(journey)) return { hashStale: true, reason: "content changed since approval (steps, assertions or side effects)" };
  const links = journeyLinks(catalog, catalogJourney(journey));
  if (links.linked && [links.job?.status, links.persona?.status].includes("stale")) return { hashStale: false, reason: "a linked catalog job/persona changed since its approval" };
  return null;
}

/** #788: where a stored Journey's approval stands. Fails closed: anything that cannot be read is `undetermined`, never `current`. */
export async function journeyApprovalState(journey: Journey, req: StaleJourneysRequest): Promise<JourneyApprovalState> {
  try {
    if (journey.metadata.promoted !== true) return { promoted: false, approval: "unrecorded" };
    if (journey.metadata.approval === undefined) return { promoted: true, approval: "unrecorded" };
    const stale = staleness(journey, await loadCatalog(req.catalogDir, req.journeysDir));
    return stale === null ? { promoted: true, approval: "current" } : { promoted: true, approval: "stale", reason: stale.reason, contentHash: journeyReviewHash(journey) };
  } catch {
    return { promoted: journey.metadata.promoted === true, approval: "undetermined" };
  }
}

/** #788: refuses a Journey an MCP run may not replay (`JourneyRunRefusedError`), before any browser. */
export async function assertMcpRunnable(journey: Journey, journeysDir: string, catalogDir: string | null = resolveCatalogDir(undefined)): Promise<void> {
  assertJourneyRunnable(journey.metadata.id, await journeyApprovalState(journey, { journeysDir, catalogDir }));
}

/** #788: the one stderr line `journey run` adds for a Journey MCP would refuse (none for an unknown id or a current approval). */
export async function journeyDraftWarning(journeysDir: string, id: string, catalogDir: string | null): Promise<string | undefined> {
  let state: JourneyApprovalState;
  try {
    const journey = await new FsJourneyStore(journeysDir).get(id);
    if (journey === null) return undefined;
    state = await journeyApprovalState(journey, { journeysDir, catalogDir });
    assertJourneyRunnable(id, state);
    return undefined;
  } catch (err) {
    if (err instanceof JourneyRunRefusedError) return `warning: ${err.code}: running anyway; MCP run_journey refuses this. Fix: ${err.fix}\n`;
    return `warning: journey '${id}': could not read its approval; running anyway; MCP run_journey would refuse it\n`;
  }
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
    const stale = staleness(journey, catalog);
    if (stale === null) continue;
    const { hashStale, reason } = stale;
    const snapshot = await readApprovedSnapshot(req.journeysDir, meta.id);
    const stepIdOnly = hashStale && isStepIdOnlyStale(journey, snapshot);
    journeys.push({
      id: meta.id,
      name: journey.metadata.name,
      approvedHash: approval.contentHash,
      contentHash,
      stepIdOnly,
      reason: stepIdOnly ? "ids added only (warn path)" : reason,
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
