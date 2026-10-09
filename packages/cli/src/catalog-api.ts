import { join } from "node:path";
import { clock } from "@jevitate/domain";
import type { CatalogApproval, Finding, Journey, JourneyApprovalWaiver, AcceptedFindings } from "@jevitate/journey";
import { CatalogLoader, catalogJourney, journeyLinks, requireJob, requirePersona, writeJobApproval, writePersonaApproval, type Catalog } from "./catalog.js";
import { assertJobRefs } from "./catalog-refs.js";
import { acknowledgeFindings, preApprovalFindings, type ApprovalAction } from "./pre-approval.js";
import { findProjectDir } from "./project-dir.js";
import type { JevSetup } from "./jev-advisor.js";
import { programmaticProvenance, type ApprovalConfirm } from "./approval-provenance.js";

/**
 * #433 — the approvals of the catalog (`persona approve`, `job approve`: a person's act, CLI only)
 * and the catalog gate every Journey approval (`journey promote`, `demo approve`) passes.
 */

/** The catalog's directory: `--dir`, else the CLI's seam, else the project's `.jevitate/` (null outside a project). */
export function resolveCatalogDir(seam: string | undefined, flag?: string): string | null {
  return flag ?? seam ?? findProjectDir();
}

/** Loads the catalog of a project data dir and a journeys dir. */
export function loadCatalog(catalogDir: string | null, journeysDir: string): Promise<Catalog> {
  return new CatalogLoader({ catalogDir, journeysDir }).load();
}

/** The journeys directory of a catalog `--dir` (its `journeys/`), else the CLI's default. */
export function catalogJourneysDir(flag: string | undefined, fallback: string): string {
  return flag === undefined ? fallback : join(flag, "journeys");
}

/** `persona|job approve --reviewed-hash`: the item changed after the reviewer's sheet was produced. */
export class StaleCatalogReviewError extends Error {
  readonly code = "E_CATALOG_REVIEW_STALE";
}

export interface CatalogApproveOptions {
  /** The content hash of the sheet the reviewer read; refused when the item changed since. */
  readonly reviewedHash?: string;
  /** `--accept-findings "<reason>"`: acknowledges findings that require it (recorded with the approval). */
  readonly acceptFindings?: string;
  /** #434/#435: the advisory Jev layer of the pre-approval readiness and analysis (`--real`), or why it is skipped. */
  readonly jev?: JevSetup;
  /**
   * #437: confirms the approval (after the findings gate, before the write) and returns its
   * provenance (the CLI's `makeApprovalConfirm`). Omitted: recorded as `non-interactive`.
   */
  readonly confirm?: ApprovalConfirm;
}

export interface CatalogApproveResult {
  readonly kind: "persona" | "job";
  readonly id: string;
  readonly approval: CatalogApproval;
  /** The status before this approval (`draft` or `stale` — or `approved`, re-approved unchanged). */
  readonly previousStatus: "draft" | "approved" | "stale";
  readonly findings: readonly Finding[];
  readonly file: string;
}

/**
 * #433: approves a persona or a job — bound to its content hash, after the shared pre-approval
 * pipeline (`preApprovalFindings` + the acknowledgment rule). A human act: never an MCP tool.
 */
export async function approveCatalogItem(kind: "persona" | "job", catalog: Catalog, id: string, opts: CatalogApproveOptions = {}): Promise<CatalogApproveResult> {
  const item = kind === "persona" ? requirePersona(catalog, id) : requireJob(catalog, id);
  const reviewed = opts.reviewedHash?.trim().toLowerCase();
  if (reviewed !== undefined && reviewed !== item.contentHash) {
    throw new StaleCatalogReviewError(`${kind} '${id}' changed after its review sheet was produced (reviewed ${reviewed}, now ${item.contentHash}) — review it again: jevitate ${kind} review ${id}`);
  }
  // #465: a job whose own references are structurally broken is refused (E_JOB_BROKEN_REF, exit 64);
  // gaps (an unmeasurable metric, a target unit) are the review sheet's warnings.
  if (kind === "job") assertJobRefs(catalog, id);
  const action: ApprovalAction = kind === "persona" ? "persona approve" : "job approve";
  // #434: every approval runs the readiness checks (the Jev layer only with --real and a key).
  const findings = await preApprovalFindings({ kind, id }, catalog, { action, readiness: true, ...(opts.jev === undefined ? {} : { jev: opts.jev }) });
  const acceptedFindings = acknowledgeFindings(`${kind} '${id}'`, findings, opts.acceptFindings);
  const provenance =
    opts.confirm === undefined
      ? programmaticProvenance()
      : await opts.confirm({
          kind,
          id,
          contentHash: item.contentHash,
          waivers: acceptedFindings === undefined ? [] : [{ flag: "--accept-findings", reason: acceptedFindings.reason, detail: acceptedFindings.findings.join(", ") }],
        });
  const approval: CatalogApproval = {
    contentHash: item.contentHash,
    at: clock.nowIso(),
    provenance,
    ...(acceptedFindings === undefined ? {} : { acceptedFindings: { ...acceptedFindings, provenance } }),
  };
  const file = kind === "persona" ? catalog.personasFile : catalog.jobsFile;
  // requirePersona/requireJob found the item, so its file was read.
  if (file === null) throw new Error(`${kind} '${id}' has no catalog file`);
  if (kind === "persona") await writePersonaApproval(file, id, approval);
  else await writeJobApproval(file, id, approval);
  return { kind, id, approval, previousStatus: item.status, findings, file };
}

/** #433: `journey promote` of a Journey whose linked job/persona is not approved, without `--accept-unvetted`. */
export class UnvettedLinksError extends Error {
  readonly code = "E_JOURNEY_UNVETTED";
  constructor(
    message: string,
    readonly unvetted: readonly string[],
  ) {
    super(message);
  }
}

export interface JourneyCatalogGateOptions {
  readonly catalogDir: string | null;
  readonly journeysDir: string;
  readonly action: "journey promote" | "demo approve";
  /** `--accept-unvetted "<reason>"`: promote although a linked job/persona is not approved (recorded). */
  readonly acceptUnvetted?: string;
  readonly acceptFindings?: string;
  /** #434/#435: the advisory Jev layer (`--real`), or why it is skipped. */
  readonly jev?: JevSetup;
}

export interface JourneyCatalogGate {
  readonly waivers?: JourneyApprovalWaiver[];
  readonly acceptedFindings?: AcceptedFindings;
  readonly findings: readonly Finding[];
}

/**
 * #433: the catalog gate of a Journey approval. A Journey linking a job or a catalog persona needs
 * each linked item approved (an unknown, draft or stale one is "unvetted"), or a recorded waiver
 * (`--accept-unvetted "<reason>"` → `approval.waivers`). An unlinked Journey passes (opt-in). Then
 * the shared pre-approval pipeline and its acknowledgment rule (`--accept-findings`).
 */
export async function journeyCatalogGate(journey: Journey, opts: JourneyCatalogGateOptions): Promise<JourneyCatalogGate> {
  const catalog = await loadCatalog(opts.catalogDir, opts.journeysDir);
  const links = journeyLinks(catalog, catalogJourney(journey));
  const id = journey.metadata.id;
  let waivers: JourneyApprovalWaiver[] | undefined;
  if (links.unvetted.length > 0) {
    const reason = opts.acceptUnvetted?.trim() ?? "";
    if (reason === "") {
      throw new UnvettedLinksError(
        `journey '${id}' links catalog items that are not approved: ${links.unvetted.join(", ")} — approve them first (jevitate job|persona review/approve <id>), ` +
          `or promote anyway with --accept-unvetted "<reason>" (recorded on the approval)`,
        links.unvetted,
      );
    }
    waivers = [{ kind: "unvetted", reason, items: [...links.unvetted] }];
  }
  const findings = await preApprovalFindings({ kind: "journey", id }, catalog, { action: opts.action, journey, readiness: true, ...(opts.jev === undefined ? {} : { jev: opts.jev }) });
  const acceptedFindings = acknowledgeFindings(`journey '${id}'`, findings, opts.acceptFindings);
  return { ...(waivers === undefined ? {} : { waivers }), ...(acceptedFindings === undefined ? {} : { acceptedFindings }), findings };
}
