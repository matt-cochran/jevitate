import { FsJourneyStore, JourneyReviewSchema, type Journey, type JourneyReview } from "@jevitate/journey";
import { buildJourneyReview } from "./journey-review.js";
import { readApprovedSnapshot, readVerifyRecord } from "./journey-review-store.js";
import { UnknownJourneyError } from "./journey-api.js";
import { loadTargetsFile, resolveTargetConfig } from "./target-config.js";

/**
 * #432: loads one Journey and everything its review sheet needs — the targets.json safety config of
 * its site's origin, its approved snapshot, its last mutation-proof verdict — and builds the sheet.
 * An unknown id is `UnknownJourneyError`, exactly as `journey promote` refuses one.
 */
export async function reviewJourneyById(
  journeysDir: string,
  id: string,
  opts: { readonly targetsFile?: string } = {},
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
  const review = buildJourneyReview(journey, {
    ...(safety === undefined ? {} : { safety }),
    approvedSnapshot: await readApprovedSnapshot(journeysDir, id),
    lastVerify: await readVerifyRecord(journeysDir, id),
  });
  // Fail closed: what is emitted always matches the published schema.
  return { journey, review: JourneyReviewSchema.parse(review) };
}
