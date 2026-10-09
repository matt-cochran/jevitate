import { anchorLintIssues, stripStepIds, type AnchorLintIssue, type CatalogRefIssue, type Journey, type JourneyLintFinding } from "@jevitate/journey";
import { CatalogInputError, catalogJourney, type Catalog } from "./catalog.js";
import { loadCatalog } from "./catalog-api.js";
import { journeyRefIssues } from "./catalog-refs.js";
import { journeyReviewHash } from "./journey-review.js";

/**
 * #466 — the anchor rules at approval time. The #466 ruling: new and re-promoted Journeys follow
 * the 0.10 anchor rules (`anchorLintIssues`, plus the catalog's `jobStep`/`serves` references,
 * `journeyRefIssues`); existing ones still load and run, and lint and the review sheet warn with the
 * fix. So `journey promote` ENFORCES on a new promotion (no prior approval) and on a re-promotion
 * whose content changed beyond step ids, and WARNS (passes) otherwise — including the #467 backfill:
 * a re-approval whose only change since the approved content is step ids added (`isStepIdOnlyChange`).
 */

/** #466: a promotion refused for the 0.10 anchor rules. A catalog-input refusal: exit 64, fix the Journey. */
export class AnchorRulesError extends CatalogInputError {
  override readonly code: string = "E_JOURNEY_ANCHOR_RULES";
  constructor(
    message: string,
    readonly anchorIssues: readonly AnchorLintIssue[],
    readonly refIssues: readonly CatalogRefIssue[],
  ) {
    super(message);
  }
}

/**
 * #466: whether `next` differs from the previously approved content only by step ids (its steps'
 * and its anchors' `stepId`s) — the #467 backfill. `prev` is the approved Journey (the `.approved/`
 * snapshot) or the approval's content hash (`journeyReviewHash`, of a Journey that had no ids then).
 * True also when nothing changed at all.
 */
export function isStepIdOnlyChange(prev: Journey | string, next: Journey): boolean {
  const nextBare = journeyReviewHash(stripStepIds(next));
  if (typeof prev !== "string") return journeyReviewHash(stripStepIds(prev)) === nextBare;
  // A hash cannot be stripped: it matches `next` with every id stripped (approved before ids), or
  // with only the anchors' (approved with step ids, before promote stamped anchors).
  const hash = prev.trim().toLowerCase();
  return hash === nextBare || hash === journeyReviewHash(stripAnchorStepIds(next));
}

function stripAnchorStepIds(j: Journey): Journey {
  const anchors = j.metadata.anchors;
  return anchors === undefined ? j : { ...j, metadata: { ...j.metadata, anchors: anchors.map(({ stepId: _id, ...rest }) => rest) } };
}

/** #466: how a promotion treats the anchor rules — enforce them, or only warn (lint/review sheet). */
export type AnchorRuleMode = "enforce" | "warn";

/**
 * #466: the mode for promoting `subject` (as it would be stored: ids minted, anchors stamped) given
 * the Journey's prior approval and approved snapshot. No prior approval: enforce. Unchanged, or
 * changed only by step ids: warn. Otherwise: enforce.
 */
export function anchorRuleMode(subject: Journey, prior: { readonly approvedHash?: string; readonly approvedSnapshot?: Journey | null }): AnchorRuleMode {
  if (prior.approvedHash === undefined) return "enforce";
  if (prior.approvedHash === journeyReviewHash(subject)) return "warn";
  if (isStepIdOnlyChange(prior.approvedHash, subject)) return "warn";
  if (prior.approvedSnapshot != null && journeyReviewHash(prior.approvedSnapshot) === prior.approvedHash && isStepIdOnlyChange(prior.approvedSnapshot, subject)) return "warn";
  return "enforce";
}

/** Whether a Journey references the catalog in a way `journeyRefIssues` checks (so the catalog is worth loading). */
function needsCatalog(j: Journey): boolean {
  const m = j.metadata;
  return m.job !== undefined || (m.serves ?? []).length > 0 || (m.anchors ?? []).some((a) => a.jobStep !== undefined);
}

/** #466: the 0.10 anchor-rule problems of `journey` — its own and its catalog references (loaded only when it has some). */
export async function journeyAnchorIssues(
  journey: Journey,
  opts: { readonly catalogDir: string | null; readonly journeysDir: string; readonly enforce?: boolean; readonly catalog?: Catalog },
): Promise<{ anchorIssues: AnchorLintIssue[]; refIssues: CatalogRefIssue[] }> {
  const enforce = opts.enforce === true;
  const anchorIssues = anchorLintIssues(journey, { enforce });
  if (!needsCatalog(journey)) return { anchorIssues, refIssues: [] };
  const catalog = opts.catalog ?? (await loadCatalog(opts.catalogDir, opts.journeysDir));
  return { anchorIssues, refIssues: journeyRefIssues(catalog, catalogJourney(journey), { enforce }) };
}

/** One problem as one line: `metadata.anchors[0].name: … — fix: …`. */
function line(path: string, message: string, fix: string | undefined): string {
  return `${path}: ${message}${fix === undefined ? "" : ` — fix: ${fix}`}`;
}

/** #466: refuses the promotion when an enforced anchor rule fails (an `error`); warnings pass. */
export function assertAnchorRules(id: string, issues: { readonly anchorIssues: readonly AnchorLintIssue[]; readonly refIssues: readonly CatalogRefIssue[] }): void {
  const anchors = issues.anchorIssues.filter((i) => i.severity === "error");
  const refs = issues.refIssues.filter((i) => i.severity === "error");
  if (anchors.length + refs.length === 0) return;
  const lines = [...anchors.map((i) => line(i.path, i.message, i.fix)), ...refs.map((i) => line(i.path, i.message, i.fix))];
  throw new AnchorRulesError(
    `journey '${id}' does not follow the anchor rules (#466), which a new or changed Journey must: ${lines.join("; ")} — fix the Journey, then review it again (jevitate journey review ${id})`,
    anchors,
    refs,
  );
}

/** #466: the catalog anchor/serves reference problems as lint warnings (`anchor-job-step`, `serves-outcome`). */
export function refLintFindings(issues: readonly CatalogRefIssue[]): JourneyLintFinding[] {
  return issues
    .filter((i) => i.code.startsWith("journey."))
    .map((i) => {
      const anchorMatch = /^metadata\.anchors\[(\d+)\]/.exec(i.path);
      return {
        rule: anchorMatch === null ? ("serves-outcome" as const) : ("anchor-job-step" as const),
        level: "warning" as const,
        message: `${i.path}: ${i.message}`,
        ...(i.fix === undefined ? {} : { fix: i.fix }),
      };
    });
}
