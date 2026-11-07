import { contentHash } from "@jevitate/domain";
import { JourneyReviewSchema, JobReviewSchema, PersonaReviewSchema, type Finding, type JobReview, type PersonaReview } from "@jevitate/journey";
import { z } from "zod";
import { reviewAnnotationCandidateById } from "./journey-review-api.js";
import { loadCatalog, resolveCatalogDir } from "./catalog-api.js";
import { buildJobReview, buildPersonaReview, isNativeCatalogOwnerFinding } from "./catalog-review.js";
import { AnnotationTransactionError } from "./journey-annotation-approval-store.js";
import { journeyContentHash, previewJourneyAnnotations } from "./journey-annotate-api.js";

const digest = z.string().regex(/^[a-f0-9]{64}$/);
const subject = z.object({ kind: z.enum(["journey", "job", "persona"]), id: z.string().min(1) }).strict();
const ProjectionSchema = z.object({
  kind: z.literal("journey-pre-approval"), version: z.literal(1), id: z.string().min(1),
  currentContentHash: digest, currentReviewHash: digest,
  candidate: z.object({ source: z.enum(["current", "annotation"]), contentHash: digest, reviewHash: digest, annotationTransactionHash: digest.nullable() }).strict(),
  readyForOwnerReview: z.boolean(),
  pendingActions: z.array(z.object({ kind: z.enum(["persona-approve", "job-approve", "annotation-approve", "annotation-resume", "journey-promote"]), id: z.string().min(1), reviewedHash: digest }).strict()),
  blockers: z.array(z.object({ code: z.enum(["annotation-state", "journey-attention", "catalog-finding", "catalog-reference"]), subject, index: z.number().int().nonnegative().nullable() }).strict()),
  review: JourneyReviewSchema,
  catalogReviews: z.object({ personas: z.array(PersonaReviewSchema), jobs: z.array(JobReviewSchema) }).strict(),
}).strict();
export type JourneyPreApproval = z.infer<typeof ProjectionSchema>;
type Pending = JourneyPreApproval["pendingActions"][number];
type Blocker = JourneyPreApproval["blockers"][number];

function needsHuman(item: { status: string; approval?: { provenance?: { channel: string } } }): boolean {
  return item.status !== "approved" || item.approval?.provenance?.channel !== "tty";
}

function ownerCatalogFinding(f: Finding, item: JobReview | PersonaReview, kind: "job" | "persona", personas: readonly PersonaReview[]): boolean {
  if (!isNativeCatalogOwnerFinding(item, f)) return false;
  if (f.requiresAcknowledgment || f.severity !== "warn" || f.analyzer !== "catalog-links") return false;
  if (f.code === `${kind}.changed`) return item.status === "stale";
  if (kind === "job" && f.code === "job.unvetted-persona" && f.items?.length === 1) {
    const match = personas.find((p) => f.items![0] === `persona:${p.id}`);
    return match !== undefined && match.status !== "approved" && "personas" in item && item.personas.some((p) => p.id === match.id);
  }
  return false;
}

async function collect(journeysDir: string, id: string, opts: { readonly targetsFile?: string; readonly catalogDir?: string | null }): Promise<JourneyPreApproval> {
  const { journey, review, annotation } = await reviewAnnotationCandidateById(journeysDir, id, opts);
  const catalog = await loadCatalog(opts.catalogDir === undefined ? resolveCatalogDir(undefined) : opts.catalogDir, journeysDir);
  const pendingActions: Pending[] = [];
  const blockers: Blocker[] = [];
  const add = (action: Pending): void => { if (!pendingActions.some((a) => a.kind === action.kind && a.id === action.id && a.reviewedHash === action.reviewedHash)) pendingActions.push(action); };
  const jobs: JobReview[] = [];
  const personas: PersonaReview[] = [];
  const linkedJob = review.catalog?.job;
  if (linkedJob !== undefined && linkedJob.status !== "unknown") jobs.push(await buildJobReview(catalog, linkedJob.id));
  const personaIds = new Set<string>(jobs.flatMap((j) => j.personas.filter((p) => p.status !== "unknown").map((p) => p.id)));
  const linkedPersona = review.catalog?.persona;
  if (linkedPersona !== undefined && linkedPersona.status !== "unknown") personaIds.add(linkedPersona.id);
  for (const pid of [...personaIds].sort()) personas.push(await buildPersonaReview(catalog, pid));
  for (const [kind, items] of [["persona", personas], ["job", jobs]] as const) {
    for (const item of items) {
      if (needsHuman(item)) add({ kind: kind === "persona" ? "persona-approve" : "job-approve", id: item.id, reviewedHash: item.contentHash });
      item.findings.forEach((f, index) => {
        if (f.severity !== "info" && !ownerCatalogFinding(f, item, kind, personas)) blockers.push({ code: "catalog-finding", subject: { kind, id: item.id }, index });
      });
      if ("refIssues" in item) (item.refIssues ?? []).forEach((_issue, index) => blockers.push({ code: "catalog-reference", subject: { kind, id: item.id }, index }));
    }
  }
  if (!["missing", "pending-human", "approved-pending-apply", "applied-current"].includes(annotation.state)) blockers.push({ code: "annotation-state", subject: { kind: "journey", id }, index: null });
  if ((annotation.state === "pending-human" || annotation.state === "approved-pending-apply") && annotation.transaction !== null) {
    add({ kind: annotation.state === "pending-human" ? "annotation-approve" : "annotation-resume", id, reviewedHash: annotation.transaction.hash });
  }
  const change = review.changeSinceApproval;
  const currentApproval = review.promoted && review.approval?.provenance?.channel === "tty" && (change.kind === "diff" || change.kind === "snapshot-missing") && !change.changed;
  if (!currentApproval) add({ kind: "journey-promote", id, reviewedHash: review.contentHash });
  (review.attention ?? []).forEach((attention, index) => {
    if (attention.severity !== "warn") return;
    const actions = attention.ownerActions;
    if (actions === undefined || actions.length === 0 || actions.some((action) => !pendingActions.some((p) => p.kind === action.kind && p.id === action.id))) {
      blockers.push({ code: "journey-attention", subject: { kind: "journey", id }, index });
    }
  });
  const order: Record<Pending["kind"], number> = { "persona-approve": 0, "job-approve": 1, "annotation-approve": 2, "annotation-resume": 2, "journey-promote": 3 };
  pendingActions.sort((a, b) => order[a.kind] - order[b.kind] || a.id.localeCompare(b.id));
  const annotationCandidate = annotation.state === "pending-human" || annotation.state === "approved-pending-apply";
  const checked = await previewJourneyAnnotations(journeysDir, id);
  const checkedCatalog = await loadCatalog(opts.catalogDir === undefined ? resolveCatalogDir(undefined) : opts.catalogDir, journeysDir);
  if (contentHash(checked.status) !== contentHash(annotation) || journeyContentHash(checked.candidate) !== journeyContentHash(journey) || contentHash(checkedCatalog) !== contentHash(catalog)) throw new AnnotationTransactionError();
  return ProjectionSchema.parse({
    kind: "journey-pre-approval", version: 1, id, currentContentHash: annotation.currentContentHash, currentReviewHash: annotation.currentReviewHash,
    candidate: { source: annotationCandidate ? "annotation" : "current", contentHash: journeyContentHash(journey), reviewHash: review.contentHash, annotationTransactionHash: annotationCandidate ? annotation.transaction?.hash ?? null : null },
    readyForOwnerReview: blockers.length === 0, pendingActions, blockers, review, catalogReviews: { personas, jobs },
  });
}

/** Repeat the native read-only projection to reject changes to any consumed identity or policy fact. */
export async function journeyPreApproval(journeysDir: string, id: string, opts: { readonly targetsFile?: string; readonly catalogDir?: string | null } = {}): Promise<JourneyPreApproval> {
  const before = await collect(journeysDir, id, opts);
  const after = await collect(journeysDir, id, opts);
  if (contentHash(before) !== contentHash(after)) throw new AnnotationTransactionError();
  return after;
}
