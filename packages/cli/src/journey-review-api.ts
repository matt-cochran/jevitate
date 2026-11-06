import { FsJourneyStore, JourneyReviewSchema, type Journey, type JourneyReview } from "@jevitate/journey";
import { buildJourneyReview, type JourneyAnnotationDraft } from "./journey-review.js";
import { AnnotationDraftNotFoundError, annotationDraftPath, journeyContentHash, readAnnotationDraft } from "./journey-annotate-api.js";
import { readApprovedSnapshot, readVerifyRecord, readProofWaiver } from "./journey-review-store.js";
import { UnknownJourneyError } from "./journey-api.js";
import { loadCatalog, resolveCatalogDir } from "./catalog-api.js";
import { catalogJourney, journeyLinks } from "./catalog.js";
import { preApprovalFindings, type ApprovalAction } from "./pre-approval.js";
import { readinessAnalyzer } from "./readiness.js";
import { jevLayerOf, type JevSetup } from "./jev-advisor.js";
import { checkProposal, readJourneyProposal } from "./journey-proposal-store.js";
import { journeyAnchorIssues } from "./journey-anchor-gate.js";
import { journeyLocatorHealth, testIdAttributesOrDefault } from "./locator-health-api.js";
import { isStepIdOnlyStale } from "./journey-stale-api.js";
import { findProjectDir } from "./project-dir.js";
import { journeyTargetSafety } from "./journey-target-policy.js";
import { loadProjectConfig } from "./project-config.js";

/**
 * #765: the status of a Journey's pending annotation draft — `current` when the Journey is
 * unchanged since the draft (the same `journeyContentHash` comparison `approveJourneyAnnotations`
 * makes), `stale` otherwise. No draft is `undefined`. An unreadable or invalid draft is reported
 * stale, never thrown: review always renders.
 */
async function loadAnnotationDraft(journeysDir: string, id: string, journey: Journey): Promise<JourneyAnnotationDraft | undefined> {
  const path = annotationDraftPath(journeysDir, id);
  try {
    const { draft } = await readAnnotationDraft(journeysDir, id);
    const current = journeyContentHash(journey) === draft.journeyHash;
    return { status: current ? "current" : "stale", path, next: current ? `jevitate journey annotate ${id} --approve` : `jevitate journey annotate ${id}` };
  } catch (err) {
    if (err instanceof AnnotationDraftNotFoundError) return undefined;
    return { status: "stale", path, next: `jevitate journey annotate ${id}` };
  }
}

/**
 * #432: loads one Journey and everything its review sheet needs — the targets.json safety config of
 * its site's origin, its approved snapshot, its last mutation-proof verdict — and builds the sheet.
 * An unknown id is `UnknownJourneyError`, exactly as `journey promote` refuses one. #433: also its
 * catalog links and the pre-approval findings (`catalogDir`: default the project's `.jevitate/`).
 */
export async function reviewJourneyById(
  journeysDir: string,
  id: string,
  opts: { readonly targetsFile?: string; readonly catalogDir?: string | null; readonly readiness?: boolean; readonly strict?: boolean; readonly jev?: JevSetup; readonly action?: ApprovalAction } = {},
): Promise<{ journey: Journey; review: JourneyReview }> {
  const journey = await new FsJourneyStore(journeysDir).get(id);
  if (journey === null) throw new UnknownJourneyError(`unknown journey '${id}'`);
  // #765: the pending annotation draft (if any) — its status is part of the review output.
  const annotationDraft = await loadAnnotationDraft(journeysDir, id, journey);
  const safety = journeyTargetSafety(journey, opts.targetsFile);
  // #433: the catalog links and the shared pre-approval findings, as `journey promote` gates on them.
  const catalog = await loadCatalog(opts.catalogDir === undefined ? resolveCatalogDir(undefined) : opts.catalogDir, journeysDir);
  const links = journeyLinks(catalog, catalogJourney(journey));
  const findings = await preApprovalFindings({ kind: "journey", id: journey.metadata.id }, catalog, {
    action: opts.action ?? "review",
    journey,
    ...(opts.readiness === true ? { readiness: true } : {}),
    ...(opts.jev === undefined ? {} : { jev: opts.jev }),
  });
  // #523 --strict: the code-only readiness link checks (missing job / persona) run even without --readiness,
  // so "done" matches what the owner sees; the rest of readiness (and Jev) stays opt-in and advisory.
  if (opts.strict === true && opts.readiness !== true) {
    const linkFindings = await preApprovalFindings({ kind: "journey", id: journey.metadata.id }, catalog, { action: opts.action ?? "review", journey, readiness: true }, [readinessAnalyzer]);
    findings.push(...linkFindings.filter((f) => f.code === "readiness.links" && f.severity !== "info"));
  }
  // #453: a pending self-heal proposal, re-checked against the stored Journey (stale, or its proof touched).
  const pending = await readJourneyProposal(journeysDir, id);
  const proposalProblem = pending === null ? null : checkProposal(journey, pending);
  const approvedSnapshot = await readApprovedSnapshot(journeysDir, id);
  const review = buildJourneyReview(journey, {
    ...(opts.strict === true ? { strict: true } : {}),
    anchorIssues: await journeyAnchorIssues(journey, { catalogDir: opts.catalogDir === undefined ? resolveCatalogDir(undefined) : opts.catalogDir, journeysDir, catalog }),
    locatorHealth: journeyLocatorHealth(journey, testIdAttributesOrDefault(findProjectDir())),
    stepIdOnly: isStepIdOnlyStale(journey, approvedSnapshot),
    ...(pending === null
      ? {}
      : { proposal: { proposal: pending, stale: proposalProblem?.code === "E_JOURNEY_PROPOSAL_STALE", ...(proposalProblem === null ? {} : { problem: proposalProblem.message }) } }),
    ...(safety === undefined ? {} : { safety }),
    catalog: { links, findings },
    approvedSnapshot,
    lastVerify: await readVerifyRecord(journeysDir, id),
    proofPolicy: loadProjectConfig(opts.catalogDir ?? findProjectDir()).mutationProofPolicy ?? "advisory",
    proofWaiver: await readProofWaiver(journeysDir, id),
    ...(annotationDraft === undefined ? {} : { annotationDraft }),
  });
  // Fail closed: what is emitted always matches the published schema.
  return { journey, review: JourneyReviewSchema.parse(opts.jev === undefined ? review : { ...review, jev: jevLayerOf(opts.jev) }) };
}
