import { FsJourneyStore, JourneyReviewSchema, type Journey, type JourneyReview } from "@jevitate/journey";
import { buildJourneyReview } from "./journey-review.js";
import { readApprovedSnapshot, readVerifyRecord } from "./journey-review-store.js";
import { UnknownJourneyError } from "./journey-api.js";
import { loadCatalog, resolveCatalogDir } from "./catalog-api.js";
import { catalogJourney, journeyLinks } from "./catalog.js";
import { preApprovalFindings, type ApprovalAction } from "./pre-approval.js";
import { jevLayerOf, type JevSetup } from "./jev-advisor.js";
import { loadTargetsFile, resolveTargetConfig } from "./target-config.js";

/**
 * #432: loads one Journey and everything its review sheet needs — the targets.json safety config of
 * its site's origin, its approved snapshot, its last mutation-proof verdict — and builds the sheet.
 * An unknown id is `UnknownJourneyError`, exactly as `journey promote` refuses one. #433: also its
 * catalog links and the pre-approval findings (`catalogDir`: default the project's `.jevitate/`).
 */
export async function reviewJourneyById(
  journeysDir: string,
  id: string,
  opts: { readonly targetsFile?: string; readonly catalogDir?: string | null; readonly readiness?: boolean; readonly jev?: JevSetup; readonly action?: ApprovalAction } = {},
): Promise<{ journey: Journey; review: JourneyReview }> {
  const journey = await new FsJourneyStore(journeysDir).get(id);
  if (journey === null) throw new UnknownJourneyError(`unknown journey '${id}'`);
  let origin: string | null = null;
  try {
    origin = new URL(journey.recording.site).origin;
  } catch {
    origin = null;
  }
  const safety = origin === null ? undefined : resolveTargetConfig(loadTargetsFile(opts.targetsFile), origin).safety;
  // #433: the catalog links and the shared pre-approval findings, as `journey promote` gates on them.
  const catalog = await loadCatalog(opts.catalogDir === undefined ? resolveCatalogDir(undefined) : opts.catalogDir, journeysDir);
  const links = journeyLinks(catalog, catalogJourney(journey));
  const findings = await preApprovalFindings({ kind: "journey", id: journey.metadata.id }, catalog, {
    action: opts.action ?? "review",
    journey,
    ...(opts.readiness === true ? { readiness: true } : {}),
    ...(opts.jev === undefined ? {} : { jev: opts.jev }),
  });
  const review = buildJourneyReview(journey, {
    ...(safety === undefined ? {} : { safety }),
    catalog: { links, findings },
    approvedSnapshot: await readApprovedSnapshot(journeysDir, id),
    lastVerify: await readVerifyRecord(journeysDir, id),
  });
  // Fail closed: what is emitted always matches the published schema.
  return { journey, review: JourneyReviewSchema.parse(opts.jev === undefined ? review : { ...review, jev: jevLayerOf(opts.jev) }) };
}
