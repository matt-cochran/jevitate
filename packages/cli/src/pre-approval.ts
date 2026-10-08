import type { AcceptedFindings, Finding, Journey } from "@jevitate/journey";
import type { JevSetup } from "./jev-advisor.js";
import { findJob, findPersona, journeyLinks, journeysForJob, journeysForPersona, personaLinkId, catalogJourney, type Catalog, type CatalogJourney } from "./catalog.js";

/**
 * #433 — THE pre-approval pipeline. Every human approval — `persona approve`, `job approve`,
 * `journey promote`, `demo approve` — asks `preApprovalFindings(subject, catalog, ctx)` for the
 * findings about the item being approved, renders them in its review sheet before approving, and
 * passes them through `acknowledgeFindings`: when any finding `requiresAcknowledgment`, the approval
 * is refused (`ApprovalFindingsError`, E_APPROVAL_FINDINGS, exit 1) unless the approver gives
 * `--accept-findings "<reason>"`, which is recorded with the approval (`acceptedFindings`).
 *
 * ── Writing an analyzer (#434 readiness / GtWR checks + Jev, #435 conflicts / duplicates) ──────
 *
 *   import { registerPreApprovalAnalyzer, type PreApprovalAnalyzer } from "./pre-approval.js";
 *   const readiness: PreApprovalAnalyzer = {
 *     id: "readiness",                          // unique; prefixes every finding's acknowledgment key
 *     appliesTo: ["job", "persona", "journey"], // the subject kinds it analyzes
 *     async analyze(subject, catalog, ctx) {    // the item, the whole catalog, the approval context
 *       return [{ analyzer: "readiness", code: "job.vague-term", severity: "warn", message: "…",
 *                 requiresAcknowledgment: false, characteristic: "unambiguous" }];
 *     },
 *   };
 *   registerPreApprovalAnalyzer(readiness);     // once, at startup (program wiring)
 *
 * Rules an analyzer keeps:
 *  - It only READS: it never changes the catalog, a Journey or an approval.
 *  - Advisory judgments (Jev) report a probability and leave `requiresAcknowledgment` to a rule in
 *    code over the typed answer (e.g. #435: a `conflicting` / `duplicate` classification) — the
 *    model never decides an approval. Without a judgment key it returns its deterministic findings
 *    (and an `info` "skipped" finding), never an error.
 *  - It is cheap to re-run: the review sheets (`journey|persona|job review`, MCP `review_*`) run
 *    the same pipeline, so an expensive analyzer caches by the items' content hashes.
 *  - A thrown error does not wave the approval through: it becomes a finding that requires an
 *    acknowledgment (fail closed), naming the analyzer.
 */

/** What is being approved: a catalog persona or job, or a Journey (promote / demo approve). */
export type ApprovalSubject =
  | { readonly kind: "persona"; readonly id: string }
  | { readonly kind: "job"; readonly id: string }
  | { readonly kind: "journey"; readonly id: string };

/** The approval path asking. */
export type ApprovalAction = "persona approve" | "job approve" | "journey promote" | "demo approve" | "review";

export interface PreApprovalContext {
  readonly action: ApprovalAction;
  /**
   * The Journey as it will be approved, when it differs from the catalog's copy (demo approve
   * applies its annotations first). Absent: the catalog's copy.
   */
  readonly journey?: Journey;
  /**
   * #434: include the readiness section (deterministic checks + GtWR rules, and the advisory Jev
   * questions). Every approval sets it; a review sheet sets it with `--readiness`.
   */
  readonly readiness?: boolean;
  /**
   * #434/#435: the advisory Jev layer — an advisor (the command was given `--real` and a judgment
   * key is configured), or why it was skipped. Absent: skipped ("pass --real").
   */
  readonly jev?: JevSetup;
}

export interface PreApprovalAnalyzer {
  /** Unique. Each finding's `analyzer` is this id. */
  readonly id: string;
  /** The subject kinds it analyzes (it is not called for the others). */
  readonly appliesTo: readonly ApprovalSubject["kind"][];
  analyze(subject: ApprovalSubject, catalog: Catalog, ctx: PreApprovalContext): readonly Finding[] | Promise<readonly Finding[]>;
}

const registry: PreApprovalAnalyzer[] = [];

/**
 * Registers an analyzer for every approval path and review sheet. Returns its unregister (tests).
 * A second analyzer with the same id is refused (one id, one meaning in recorded acknowledgments).
 */
export function registerPreApprovalAnalyzer(analyzer: PreApprovalAnalyzer): () => void {
  if (registry.some((a) => a.id === analyzer.id)) throw new Error(`a pre-approval analyzer '${analyzer.id}' is already registered`);
  registry.push(analyzer);
  return () => {
    const i = registry.indexOf(analyzer);
    if (i !== -1) registry.splice(i, 1);
  };
}

/** The analyzers every approval runs: the built-in deterministic catalog-link checks, then the registered ones. */
export function preApprovalAnalyzers(): readonly PreApprovalAnalyzer[] {
  return [catalogLinkAnalyzer, ...registry];
}

const SEVERITY_ORDER = { fail: 0, warn: 1, info: 2 } as const;

/** #433: the findings about `subject` from every analyzer that applies — acknowledgment-requiring first. */
export async function preApprovalFindings(
  subject: ApprovalSubject,
  catalog: Catalog,
  ctx: PreApprovalContext,
  analyzers: readonly PreApprovalAnalyzer[] = preApprovalAnalyzers(),
): Promise<Finding[]> {
  const out: Finding[] = [];
  for (const analyzer of analyzers) {
    if (!analyzer.appliesTo.includes(subject.kind)) continue;
    try {
      out.push(...(await analyzer.analyze(subject, catalog, ctx)));
    } catch (err) {
      out.push({
        analyzer: analyzer.id,
        code: "analyzer.error",
        severity: "fail",
        message: `the ${analyzer.id} analysis could not run: ${err instanceof Error ? err.message : String(err)}`,
        fix: "fix the cause and review again, or acknowledge with --accept-findings \"<reason>\"",
        requiresAcknowledgment: true,
      });
    }
  }
  return out
    .map((f, i) => ({ f, i }))
    .sort((a, b) => Number(b.f.requiresAcknowledgment) - Number(a.f.requiresAcknowledgment) || SEVERITY_ORDER[a.f.severity] - SEVERITY_ORDER[b.f.severity] || a.i - b.i)
    .map(({ f }) => f);
}

/** The key an acknowledgment records a finding by: `<analyzer>/<code>`. */
export function findingKey(f: Finding): string {
  return `${f.analyzer}/${f.code}`;
}

/** #433: findings that require an acknowledgment were present and no `--accept-findings` reason was given. */
export class ApprovalFindingsError extends Error {
  readonly code = "E_APPROVAL_FINDINGS";
  constructor(
    message: string,
    readonly findings: readonly Finding[],
  ) {
    super(message);
  }
}

/**
 * #433: the acknowledgment rule, in code. Findings requiring an acknowledgment refuse the approval
 * unless `acceptFindings` (a non-empty reason) is given; then they are what the approval records.
 * Returns undefined when nothing needed acknowledging.
 */
export function acknowledgeFindings(what: string, findings: readonly Finding[], acceptFindings: string | undefined): AcceptedFindings | undefined {
  const blocking = findings.filter((f) => f.requiresAcknowledgment);
  if (blocking.length === 0) return undefined;
  const reason = acceptFindings?.trim() ?? "";
  if (reason === "") {
    throw new ApprovalFindingsError(
      `${what}: ${blocking.length} pre-approval finding(s) need an acknowledgment — ${blocking.map((f) => `${findingKey(f)}: ${f.message}`).join("; ")}. ` +
        `Fix them, or approve anyway with --accept-findings "<reason>" (recorded with the approval)`,
      blocking,
    );
  }
  return { reason, findings: [...new Set(blocking.map(findingKey))] };
}

// ── The built-in analyzer: deterministic catalog links and staleness ──────────────────────────

const ANALYZER = "catalog-links";

function finding(code: string, severity: Finding["severity"], message: string, opts: { fix?: string; ack?: boolean; items?: string[] } = {}): Finding {
  return {
    analyzer: ANALYZER,
    code,
    severity,
    message,
    ...(opts.fix === undefined ? {} : { fix: opts.fix }),
    requiresAcknowledgment: opts.ack === true,
    ...(opts.items === undefined || opts.items.length === 0 ? {} : { items: opts.items }),
  };
}

function personaFindings(id: string, catalog: Catalog): Finding[] {
  const persona = findPersona(catalog, id);
  if (persona === undefined) return [];
  const out: Finding[] = [];
  if (persona.status === "stale") out.push(finding("persona.changed", "warn", `persona '${id}' changed since its approval; approving re-vets it and clears "needs re-review" on its Journeys`));
  const jobs = catalog.jobs.filter((j) => j.personas.includes(id));
  if (jobs.length === 0) out.push(finding("persona.no-job", "info", `no job in the catalog serves persona '${id}'`, { fix: `list it in a job's "personas" (.jevitate/jobs.json)` }));
  const stale = journeysForPersona(catalog, id).filter((j) => j.promoted && persona.status === "stale");
  if (stale.length > 0) out.push(finding("persona.journeys-need-re-review", "info", `${stale.length} promoted Journey(s) linked to it show "needs re-review" until it is approved again`, { items: stale.map((j) => `journey:${j.id}`) }));
  return out;
}

function jobFindings(id: string, catalog: Catalog): Finding[] {
  const job = findJob(catalog, id);
  if (job === undefined) return [];
  const out: Finding[] = [];
  if (job.status === "stale") out.push(finding("job.changed", "warn", `job '${id}' changed since its approval; approving re-vets it and clears "needs re-review" on its Journeys`));
  if (job.personas.length === 0) out.push(finding("job.no-persona", "warn", `job '${id}' serves no persona`, { fix: `add the persona ids it serves to its "personas"` }));
  for (const pid of job.personas) {
    const persona = findPersona(catalog, pid);
    if (persona === undefined) {
      out.push(
        finding("job.unknown-persona", "fail", `job '${id}' serves persona '${pid}', which .jevitate/personas.json does not declare`, {
          fix: `declare persona '${pid}' in .jevitate/personas.json, or remove it from the job's "personas"`,
          ack: true,
          items: [`persona:${pid}`],
        }),
      );
    } else if (persona.status !== "approved") {
      out.push(finding("job.unvetted-persona", "warn", `job '${id}' serves persona '${pid}', which is ${persona.status === "draft" ? "not approved yet" : "stale (changed since its approval)"}`, { fix: `jevitate persona review ${pid}, then persona approve ${pid}`, items: [`persona:${pid}`] }));
    }
  }
  const journeys = journeysForJob(catalog, id);
  for (const pid of job.personas) {
    if (!journeys.some((j) => j.promoted && personaLinkId(catalog, j) === pid)) {
      out.push(finding("job.gap", "info", `no promoted Journey does job '${id}' as persona '${pid}'`, { items: [`persona:${pid}`] }));
    }
  }
  return out;
}

function journeyFindings(j: CatalogJourney, catalog: Catalog): Finding[] {
  const links = journeyLinks(catalog, j);
  if (!links.linked) {
    return [finding("journey.unlinked", "info", `not linked to a job/persona — it promotes as before (opt-in: set metadata.job and metadata.persona to catalog ids)`)];
  }
  const out: Finding[] = [];
  if (links.job?.status === "unknown") out.push(finding("journey.unknown-job", "fail", `links job '${links.job.id}', which the catalog does not declare`, { fix: "fix metadata.job, or declare the job in .jevitate/jobs.json", items: [`job:${links.job.id}`] }));
  if (links.persona?.status === "unknown") {
    out.push(finding("journey.unknown-persona", "fail", `links persona '${links.persona.id}', which .jevitate/personas.json does not declare (a Journey with a job names a catalog persona id)`, { fix: "set metadata.persona to a persona id, or declare it", items: [`persona:${links.persona.id}`] }));
  }
  if (links.job !== undefined && links.persona === undefined) out.push(finding("journey.no-persona", "warn", `links job '${links.job.id}' but no persona`, { fix: "set metadata.persona to the id of the persona doing the job" }));
  if (links.unvetted.length > 0) {
    out.push(finding("journey.unvetted", "warn", `its links are not approved: ${links.unvetted.join(", ")} — promote needs them approved, or --accept-unvetted "<reason>"`, { items: links.unvetted.map((u) => u.replace(/ \(.*\)$/, "")) }));
  }
  const job = links.job === undefined ? undefined : findJob(catalog, links.job.id);
  if (job !== undefined && links.persona !== undefined && links.persona.status !== "unknown" && !job.personas.includes(links.persona.id)) {
    out.push(
      finding("journey.persona-not-served", "fail", `persona '${links.persona.id}' does the job, but job '${job.id}' does not list that persona (it serves: ${job.personas.join(", ") || "none"})`, {
        fix: `add '${links.persona.id}' to the job's "personas", or link the persona the job serves`,
        ack: true,
        items: [`job:${job.id}`, `persona:${links.persona.id}`],
      }),
    );
  }
  for (const why of links.needsReReview) out.push(finding("journey.needs-re-review", "warn", `needs re-review: ${why}`));
  return out;
}

/** #433: the deterministic link and staleness checks every approval starts with. */
export const catalogLinkAnalyzer: PreApprovalAnalyzer = {
  id: ANALYZER,
  appliesTo: ["persona", "job", "journey"],
  analyze(subject, catalog, ctx) {
    if (subject.kind === "persona") return personaFindings(subject.id, catalog);
    if (subject.kind === "job") return jobFindings(subject.id, catalog);
    const j = ctx.journey === undefined ? catalog.journeys.find((x) => x.id === subject.id) : catalogJourney(ctx.journey);
    return j === undefined ? [] : journeyFindings(j, catalog);
  },
};
