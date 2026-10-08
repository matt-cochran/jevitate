import { describeProvenance } from "./approval-provenance.js";
import {
  CatalogStatusSchema,
  GTWR_SET_CHARACTERISTICS,
  JobReviewSchema,
  PersonaReviewSchema,
  type CatalogStatusReport,
  type Finding,
  type JobReview,
  type PersonaReview,
} from "@jevitate/journey";
import { journeyLinks, journeysForJob, journeysForPersona, personaLinkId, requireJob, requirePersona, type Catalog, type CatalogJourney } from "./catalog.js";
import { preApprovalFindings, type ApprovalAction } from "./pre-approval.js";
import { jevLayerOf, type JevSetup } from "./jev-advisor.js";

/** #434/#435: what a review sheet asks of the pipeline beyond the defaults. */
export interface SheetOptions {
  /** #434: include the Readiness section (`--readiness`; every approval sets it). */
  readonly readiness?: boolean;
  /** #434/#435: the advisory Jev layer (`--real`), or why it is skipped. */
  readonly jev?: JevSetup;
}

function sheetCtx(action: ApprovalAction, opts: SheetOptions) {
  return { action, ...(opts.readiness === true ? { readiness: true } : {}), ...(opts.jev === undefined ? {} : { jev: opts.jev }) };
}

/**
 * #433 — the persona and job review sheets (`persona|job review <id>`, MCP `review_persona` /
 * `review_job`) and `catalog status`. Built from a loaded `Catalog`; the sheets carry the
 * pre-approval findings (`preApprovalFindings`), so what a reviewer reads is what `approve` gates on.
 */

function journeyRef(catalog: Catalog, j: CatalogJourney): { id: string; name: string; promoted: boolean; needsReReview: boolean } {
  return { id: j.id, name: j.name, promoted: j.promoted, needsReReview: journeyLinks(catalog, j).needsReReview.length > 0 };
}

export async function buildPersonaReview(catalog: Catalog, id: string, action: ApprovalAction = "review", opts: SheetOptions = {}): Promise<PersonaReview> {
  const p = requirePersona(catalog, id);
  const findings = await preApprovalFindings({ kind: "persona", id }, catalog, sheetCtx(action, opts));
  return PersonaReviewSchema.parse({
    id: p.id,
    ...(p.description === undefined ? {} : { description: p.description }),
    ...(p.role === undefined ? {} : { role: p.role }),
    status: p.status,
    needsReReview: p.status === "stale",
    session: { storageState: p.hasStorageState, login: p.hasLogin },
    jobs: catalog.jobs.filter((j) => j.personas.includes(id)).map((j) => ({ id: j.id, story: j.story, status: j.status })),
    journeys: journeysForPersona(catalog, id).map((j) => journeyRef(catalog, j)),
    findings,
    ...(opts.jev === undefined ? {} : { jev: jevLayerOf(opts.jev) }),
    ...(p.approval === undefined ? {} : { approval: p.approval }),
    contentHash: p.contentHash,
  });
}

export async function buildJobReview(catalog: Catalog, id: string, action: ApprovalAction = "review", opts: SheetOptions = {}): Promise<JobReview> {
  const job = requireJob(catalog, id);
  const findings = await preApprovalFindings({ kind: "job", id }, catalog, sheetCtx(action, opts));
  const journeys = journeysForJob(catalog, id);
  const personas = job.personas.map((pid) => {
    const mine = journeys.filter((j) => personaLinkId(catalog, j) === pid);
    return {
      id: pid,
      status: catalog.personas.find((p) => p.id === pid)?.status ?? ("unknown" as const),
      journeys: mine.map((j) => j.id),
      promotedJourneys: mine.filter((j) => j.promoted).map((j) => j.id),
    };
  });
  return JobReviewSchema.parse({
    id: job.id,
    story: job.story,
    trigger: job.job.trigger,
    motivation: job.job.motivation,
    outcome: job.job.outcome,
    ...(job.job.priority === undefined ? {} : { priority: job.job.priority }),
    status: job.status,
    needsReReview: job.status === "stale",
    personas,
    gaps: personas.filter((p) => p.promotedJourneys.length === 0).map((p) => p.id),
    journeys: journeys.map((j) => {
      const persona = personaLinkId(catalog, j);
      return { ...journeyRef(catalog, j), ...(persona === undefined ? {} : { persona }) };
    }),
    findings,
    ...(opts.jev === undefined ? {} : { jev: jevLayerOf(opts.jev) }),
    ...(job.approval === undefined ? {} : { approval: job.approval }),
    contentHash: job.contentHash,
  });
}

/** #433: `catalog status` — the jobs × personas matrix, gaps, unlinked Journeys, dangling links, stale approvals. */
export function buildCatalogStatus(catalog: Catalog): CatalogStatusReport {
  const personaIds = catalog.personas.map((p) => p.id);
  const unknownPersonas = [...new Set(catalog.jobs.flatMap((j) => j.personas))].filter((id) => !personaIds.includes(id));
  const columns = [...personaIds, ...unknownPersonas];
  const gaps: { job: string; persona: string }[] = [];
  const matrix = catalog.jobs.map((job) => {
    const journeys = journeysForJob(catalog, job.id);
    const cells: Record<string, { state: "n/a" | "promoted" | "draft" | "missing"; journeys: string[] }> = {};
    for (const pid of columns) {
      if (!job.personas.includes(pid)) {
        cells[pid] = { state: "n/a", journeys: [] };
        continue;
      }
      const mine = journeys.filter((j) => personaLinkId(catalog, j) === pid);
      const state = mine.some((j) => j.promoted) ? "promoted" : mine.length > 0 ? "draft" : "missing";
      if (state !== "promoted") gaps.push({ job: job.id, persona: pid });
      cells[pid] = { state, journeys: mine.map((j) => j.id) };
    }
    return { job: job.id, cells };
  });
  const stale: CatalogStatusReport["stale"] = [
    ...catalog.personas.filter((p) => p.status === "stale").map((p) => ({ kind: "persona" as const, id: p.id, reason: "edited since its approval" })),
    ...catalog.jobs.filter((j) => j.status === "stale").map((j) => ({ kind: "job" as const, id: j.id, reason: "edited since its approval" })),
    ...catalog.journeys.flatMap((j) => {
      const why = journeyLinks(catalog, j).needsReReview;
      return why.length === 0 ? [] : [{ kind: "journey" as const, id: j.id, reason: why.join("; ") }];
    }),
  ];
  const danglingLinks = catalog.journeys.flatMap((j) => {
    const links = journeyLinks(catalog, j);
    return [
      ...(links.job?.status === "unknown" ? [{ journey: j.id, kind: "job" as const, id: links.job.id }] : []),
      ...(links.persona?.status === "unknown" ? [{ journey: j.id, kind: "persona" as const, id: links.persona.id }] : []),
    ];
  });
  return CatalogStatusSchema.parse({
    personas: catalog.personas.map((p) => ({ id: p.id, status: p.status, ...(p.role === undefined ? {} : { role: p.role }) })),
    jobs: catalog.jobs.map((j) => ({ id: j.id, story: j.story, status: j.status, ...(j.job.priority === undefined ? {} : { priority: j.job.priority }), personas: [...j.personas] })),
    matrix,
    approvedJobsWithoutPromotedJourney: catalog.jobs.filter((j) => j.status === "approved" && !journeysForJob(catalog, j.id).some((x) => x.promoted)).map((j) => j.id),
    gaps,
    unlinkedJourneys: catalog.journeys.filter((j) => !journeyLinks(catalog, j).linked).map((j) => j.id),
    danglingLinks,
    stale,
    files: { personas: catalog.personasFile, jobs: catalog.jobsFile },
  });
}

// ── Rendering ─────────────────────────────────────────────────────────────────────────────────

type Style = "markdown" | "text";

function helpers(style: Style) {
  const md = style === "markdown";
  return {
    md,
    code: (s: string): string => (md ? `\`${s.replace(/`/g, "'")}\`` : s),
    h1: (s: string): string => (md ? `# ${s}` : `${s}\n${"=".repeat(Math.min(s.length, 80))}`),
    h2: (s: string): string => (md ? `## ${s}` : s.toUpperCase()),
    em: (s: string): string => (md ? `_${s}_` : s),
    li: (s: string, depth = 0): string => `${"  ".repeat(md ? depth : depth + 1)}- ${s}`,
  };
}

const STATUS_WORDS = { draft: "draft (not approved)", approved: "approved", stale: "STALE — edited since its approval: needs re-review", unknown: "UNKNOWN — not declared in the catalog" } as const;

function findingLine(f: Finding, code: (s: string) => string): string {
  return `${f.requiresAcknowledgment ? "⚠ NEEDS ACKNOWLEDGMENT " : ""}${f.severity} ${code(`${f.analyzer}/${f.code}`)}: ${f.message}${f.probability === undefined ? "" : ` (p=${f.probability.toFixed(2)})`}${f.characteristic === undefined ? "" : ` [GtWR: ${f.characteristic}]`}${f.fix === undefined ? "" : ` — fix: ${f.fix}`}`;
}

/** #435: catalog-analysis findings, one sub-section per INCOSE GtWR set characteristic (non-empty ones, in the guide's order). */
export function renderAnalysisGroups(findings: readonly Finding[], style: Style): string[] {
  const { md, li, code } = helpers(style);
  const h3 = (s: string): string => (md ? `### ${s}` : `${s}:`);
  const out: string[] = [];
  for (const characteristic of GTWR_SET_CHARACTERISTICS) {
    const mine = findings.filter((f) => f.characteristic === characteristic);
    if (mine.length > 0) out.push(h3(`GtWR: ${characteristic}`), "", ...mine.map((f) => li(findingLine(f, code))), "");
  }
  const other = findings.filter((f) => !(GTWR_SET_CHARACTERISTICS as readonly string[]).includes(f.characteristic ?? ""));
  if (other.length > 0) out.push(h3("Other"), "", ...other.map((f) => li(findingLine(f, code))), "");
  return out;
}

/** The analyzers whose findings get their own section of the sheet (#434 readiness, #435 catalog analysis). */
const READINESS_ANALYZER = "readiness";
const READINESS_JEV_ANALYZER = "readiness-jev";
const CATALOG_ANALYSIS_ANALYZER = "catalog-analysis";

/**
 * #433: the pre-approval findings every review sheet shows before an approval. #434: the readiness
 * findings form their own Readiness section, its two layers apart (deterministic checks; the
 * advisory Jev review). #435: the catalog analysis forms its own section, grouped by GtWR set
 * characteristic. The acknowledgment line counts every section.
 */
export function renderFindings(findings: readonly Finding[], style: Style): string[] {
  const { h2, li, em, code, md } = helpers(style);
  const h3 = (s: string): string => (md ? `### ${s}` : `${s}:`);
  const blocking = findings.filter((f) => f.requiresAcknowledgment).length;
  const of = (id: string) => findings.filter((f) => f.analyzer === id);
  const readiness = of(READINESS_ANALYZER);
  const jev = of(READINESS_JEV_ANALYZER);
  const analysis = of(CATALOG_ANALYSIS_ANALYZER);
  const rest = findings.filter((f) => f.analyzer !== READINESS_ANALYZER && f.analyzer !== READINESS_JEV_ANALYZER && f.analyzer !== CATALOG_ANALYSIS_ANALYZER);
  const lines = (fs: readonly Finding[]) => (fs.length === 0 ? [li(em("none"))] : fs.map((f) => li(findingLine(f, code))));
  return [
    ...(readiness.length + jev.length === 0
      ? []
      : [
          h2("Readiness"),
          "",
          h3("Deterministic checks (pass / warn / fail, with INCOSE GtWR rules)"),
          "",
          ...lines(readiness),
          "",
          h3("Jev review (advisory: never blocks, never changes an exit code)"),
          "",
          ...lines(jev),
          "",
        ]),
    ...(analysis.length === 0 ? [] : [h2("Catalog analysis (against the rest of the catalog)"), "", ...renderAnalysisGroups(analysis, style)]),
    h2("Pre-approval findings"),
    "",
    ...lines(rest),
    ...(blocking === 0 ? [] : ["", `${blocking} finding(s) need an acknowledgment: approving refuses (E_APPROVAL_FINDINGS) unless you pass --accept-findings "<reason>".`]),
  ];
}

function finish(out: string[]): string {
  return `${out.join("\n").replace(/\n{3,}/g, "\n\n").trimEnd()}\n`;
}

export function renderPersonaReview(r: PersonaReview, style: Style): string {
  const { h1, h2, li, em, code } = helpers(style);
  const out = [
    h1(`Persona review: ${r.id}`),
    "",
    `Content hash: ${code(r.contentHash)}`,
    `Status: ${STATUS_WORDS[r.status]}${r.approval === undefined ? "" : ` · last approved ${r.approval.at} — ${describeProvenance(r.approval.provenance)}`}`,
    "",
    h2("Who"),
    "",
    li(`Description: ${r.description ?? em("none")}`),
    li(`Account role: ${r.role ?? em("none")}`),
    li(`Session: ${r.session.storageState ? "storage state declared" : "no storage state"}${r.session.login ? ", login parameters declared" : ""}`),
    "",
    h2("Jobs it serves"),
    "",
    ...(r.jobs.length === 0 ? [li(em("none"))] : r.jobs.map((j) => li(`${code(j.id)} (${j.status}): ${j.story}`))),
    "",
    h2("Journeys linked to it"),
    "",
    ...(r.journeys.length === 0 ? [li(em("none"))] : r.journeys.map((j) => li(`${code(j.id)} — ${j.name} (${j.promoted ? "promoted" : "not promoted"})${j.needsReReview ? " — needs re-review" : ""}`))),
    "",
    ...renderFindings(r.findings, style),
    "",
    h2("Approve"),
    "",
    `Approve exactly this version: ${code(`jevitate persona approve ${r.id} --reviewed-hash ${r.contentHash}`)}`,
  ];
  return finish(out);
}

export function renderJobReview(r: JobReview, style: Style): string {
  const { h1, h2, li, em, code } = helpers(style);
  const out = [
    h1(`Job review: ${r.id}`),
    "",
    `Content hash: ${code(r.contentHash)}`,
    `Status: ${STATUS_WORDS[r.status]}${r.approval === undefined ? "" : ` · last approved ${r.approval.at} — ${describeProvenance(r.approval.provenance)}`}`,
    "",
    h2("Job story"),
    "",
    r.story,
    "",
    li(`Trigger (when): ${r.trigger}`),
    li(`Motivation (I want to): ${r.motivation}`),
    li(`Outcome (so I can): ${r.outcome}`),
    ...(r.priority === undefined ? [] : [li(`Priority: ${r.priority}`)]),
    "",
    h2("Personas"),
    "",
    ...(r.personas.length === 0
      ? [li(em("none"))]
      : r.personas.map((p) => li(`${code(p.id)} (${STATUS_WORDS[p.status]}): ${p.promotedJourneys.length > 0 ? `promoted Journey(s) ${p.promotedJourneys.map(code).join(", ")}` : p.journeys.length > 0 ? `only unpromoted Journey(s) ${p.journeys.map(code).join(", ")}` : "no Journey"}`))),
    "",
    h2("Gaps"),
    "",
    ...(r.gaps.length === 0 ? [li(em("none — every persona it serves has a promoted Journey"))] : r.gaps.map((g) => li(`no promoted Journey for persona ${code(g)}`))),
    "",
    h2("Journeys"),
    "",
    ...(r.journeys.length === 0
      ? [li(em("none"))]
      : r.journeys.map((j) => li(`${code(j.id)} — ${j.name}${j.persona === undefined ? "" : ` as ${j.persona}`} (${j.promoted ? "promoted" : "not promoted"})${j.needsReReview ? " — needs re-review" : ""}`))),
    "",
    ...renderFindings(r.findings, style),
    "",
    h2("Approve"),
    "",
    `Approve exactly this version: ${code(`jevitate job approve ${r.id} --reviewed-hash ${r.contentHash}`)}`,
  ];
  return finish(out);
}

const CELL = { "n/a": "·", promoted: "✓", draft: "draft", missing: "MISSING" } as const;

export function renderCatalogStatus(r: CatalogStatusReport): string {
  const out: string[] = ["Catalog status", "=============="];
  if (r.files.personas === null && r.files.jobs === null && r.unlinkedJourneys.length === 0 && r.stale.length === 0) {
    out.push("", "No personas or jobs declared (.jevitate/personas.json, .jevitate/jobs.json) — see docs/catalog.md.");
  }
  out.push("", `Personas: ${r.personas.length === 0 ? "none" : r.personas.map((p) => `${p.id} (${p.status})`).join(", ")}`);
  out.push(`Jobs: ${r.jobs.length === 0 ? "none" : r.jobs.map((j) => `${j.id} (${j.status})`).join(", ")}`);
  if (r.matrix.length > 0) {
    const cols = Object.keys(r.matrix[0]!.cells);
    const rows = [["job \\ persona", ...cols], ...r.matrix.map((m) => [m.job, ...cols.map((c) => CELL[m.cells[c]!.state])])];
    const widths = rows[0]!.map((_, i) => Math.max(...rows.map((row) => row[i]!.length)));
    out.push("", "Jobs × personas (✓ promoted Journey · draft: only unpromoted · MISSING: none · '·' not served):");
    for (const row of rows) out.push(`  ${row.map((cell, i) => cell.padEnd(widths[i]!)).join("  ")}`.trimEnd());
  }
  const section = (title: string, items: readonly string[]): void => {
    out.push("", `${title}:`, ...(items.length === 0 ? ["  - none"] : items.map((i) => `  - ${i}`)));
  };
  section("Approved jobs with no promoted Journey", r.approvedJobsWithoutPromotedJourney);
  section("Gaps (job × persona with no promoted Journey)", r.gaps.map((g) => `${g.job} × ${g.persona}`));
  section("Journeys linked to nothing", r.unlinkedJourneys);
  section("Dangling links", r.danglingLinks.map((d) => `journey ${d.journey} → ${d.kind} '${d.id}' (not declared)`));
  section("Stale approvals (needs re-review)", r.stale.map((s) => `${s.kind} ${s.id}: ${s.reason}`));
  return `${out.join("\n")}\n`;
}
