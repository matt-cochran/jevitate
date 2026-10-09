import { readFile, writeFile } from "node:fs/promises";
import { CATALOG_ID_RE, DesiredOutcomeSchema, JobSchema, type DesiredOutcome } from "@jevitate/journey";
import { buildGenerationGateway, type CliDeps } from "./cli-shared.js";
import { CatalogInputError, UnknownCatalogItemError, catalogJobOf, requireJob } from "./catalog.js";
import { loadCatalog } from "./catalog-api.js";
import { assertJobRefs } from "./catalog-refs.js";

/**
 * #465b — `jevitate job draft-outcomes <jobId>` / MCP `draft_job_outcomes`: draft 1–3 desired
 * outcomes for one catalog job with the generation model and write them into its jobs file marked
 * `provenance: "ai_draft"` for the team to review. It NEVER approves anything: the job's approval is
 * left as it was (editing the job makes an existing approval stale, as any edit does), and approving
 * stays a person's act (`jevitate job approve`, CLI only).
 *
 * Provenance: the catalog schema carries `provenance` on the JOB only (a desired outcome is a strict
 * object with no provenance field), so the draft is marked two ways: the job's `provenance` becomes
 * `ai_draft` when it had none (a stronger one — team_hypothesis, customer_evidenced — is never
 * downgraded), and `extensions["jevitate-draft"].outcomes` lists the ids of the drafted, not yet
 * team-reviewed outcomes (a per-outcome trail the team deletes as it reviews).
 */
export const DRAFT_EXTENSION = "jevitate-draft";

/** The fewest / most outcomes one call drafts (`--count`, default 3). */
export const DRAFT_OUTCOMES_MIN = 1;
export const DRAFT_OUTCOMES_MAX = 3;
export const DRAFT_OUTCOMES_DEFAULT = 3;

export interface DraftJobOutcomesRequest {
  /** The project data dir holding jobs.json (`--dir`, else the repo's `.jevitate/`); null outside a project. */
  readonly catalogDir: string | null;
  /** The journeys dir the catalog's Journeys load from (anchor names a drafted metric may reference). */
  readonly journeysDir: string;
  /** The catalog job id (CATALOG_ID_RE; validated by the command). */
  readonly jobId: string;
  /** How many outcomes to draft: DRAFT_OUTCOMES_MIN..DRAFT_OUTCOMES_MAX. */
  readonly count: number;
  /** The generation gateway selection (`--real` live, `--fake-ai` deterministic); exactly one is true. */
  readonly ai: { readonly real: boolean; readonly fakeAi: boolean };
}

export interface DraftJobOutcomesResult {
  readonly jobId: string;
  /** The drafted outcomes, as written to the jobs file (schema-checked `DesiredOutcome`s). */
  readonly outcomes: readonly DesiredOutcome[];
  /** Always `ai_draft`: drafted content is the weakest provenance until the team reviews it. */
  readonly provenance: "ai_draft";
  /** The jobs file that was written. */
  readonly jobsFile: string;
  /** Always false: drafting never approves. */
  readonly approved: false;
  /** The job's approval state after the write (an approved job becomes `stale` = needs re-review). */
  readonly approvalStatus: "draft" | "approved" | "stale";
}

const outcomeText = (o: Pick<DesiredOutcome, "direction" | "measure" | "object">): string => `${o.direction} the ${o.measure} ${o.object}`.toLowerCase().replace(/\s+/g, " ").trim();

function slug(o: Pick<DesiredOutcome, "direction" | "measure" | "object">): string {
  const base = `${o.direction}-${o.measure}-${o.object}`.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 48).replace(/-+$/, "");
  return base === "" ? "outcome" : base;
}

/** Drafts and writes the outcomes. `deps` gives the CLI's generation gateway builder. */
export async function draftJobOutcomes(req: DraftJobOutcomesRequest, deps: CliDeps): Promise<DraftJobOutcomesResult> {
  if (!Number.isInteger(req.count) || req.count < DRAFT_OUTCOMES_MIN || req.count > DRAFT_OUTCOMES_MAX) {
    throw new CatalogInputError(`count must be a whole number from ${DRAFT_OUTCOMES_MIN} to ${DRAFT_OUTCOMES_MAX}, got ${req.count}`);
  }
  const catalog = await loadCatalog(req.catalogDir, req.journeysDir);
  const entry = requireJob(catalog, req.jobId);
  const file = catalog.jobsFile;
  if (file === null) throw new UnknownCatalogItemError("job", `no jobs file for job '${req.jobId}'`);
  const job = entry.job;
  const existing = job.desiredOutcomes ?? [];

  const { gen } = await buildGenerationGateway(deps, req.ai);
  const generated = await gen.generate("catalog.outcomes", {
    jobId: job.id,
    story: entry.story,
    personas: [...entry.personas],
    steps: (job.steps ?? []).map((s) => ({ id: s.id, name: s.name })),
    existingOutcomes: existing.map(outcomeText),
    count: req.count,
  });

  const stepIds = new Set((job.steps ?? []).map((s) => s.id));
  const seenText = new Set(existing.map(outcomeText));
  const usedIds = new Set(existing.map((o) => o.id));
  const drafted: DesiredOutcome[] = [];
  for (const o of generated.output.outcomes) {
    if (drafted.length >= req.count) break;
    const text = outcomeText(o);
    if (seenText.has(text)) continue; // never a duplicate of an existing (or already drafted) outcome
    let id = slug(o);
    for (let n = 2; usedIds.has(id); n++) id = `${slug(o).slice(0, 56)}-${n}`;
    const candidate = DesiredOutcomeSchema.parse({
      id,
      ...(o.step !== null && stepIds.has(o.step) ? { step: o.step } : {}),
      direction: o.direction,
      measure: o.measure,
      object: o.object.trim(),
      ...(o.clarifier === null ? {} : { clarifier: o.clarifier.trim() }),
      ...(o.gulf === null ? {} : { gulf: o.gulf }),
    });
    if (!CATALOG_ID_RE.test(candidate.id)) continue;
    seenText.add(text);
    usedIds.add(candidate.id);
    drafted.push(candidate);
  }
  if (drafted.length === 0) throw new CatalogInputError(`the model drafted no new outcome for job '${req.jobId}' (every suggestion repeated an existing one)`);

  const priorMarked = (job.extensions?.[DRAFT_EXTENSION] as { outcomes?: unknown } | undefined)?.outcomes;
  const marked = [...(Array.isArray(priorMarked) ? (priorMarked as string[]) : []), ...drafted.map((o) => o.id)];
  const next = JobSchema.parse({
    ...job,
    desiredOutcomes: [...existing, ...drafted],
    provenance: job.provenance ?? "ai_draft",
    extensions: { ...(job.extensions ?? {}), [DRAFT_EXTENSION]: { outcomes: marked } },
  });
  assertJobRefs({ ...catalog, jobs: catalog.jobs.map((j) => (j.id === job.id ? catalogJobOf(next) : j)) }, job.id);

  // Write the job back in place; its approval is left untouched, so an approved job turns stale.
  const raw = JSON.parse(await readFile(file, "utf8")) as unknown;
  const list = (Array.isArray(raw) ? [...raw] : [...((raw as { jobs: unknown[] }).jobs)]) as Array<Record<string, unknown>>;
  const index = list.findIndex((e) => e.id === job.id);
  list[index] = next as unknown as Record<string, unknown>;
  await writeFile(file, `${JSON.stringify(Array.isArray(raw) ? list : { ...(raw as Record<string, unknown>), jobs: list }, null, 2)}\n`);

  return {
    jobId: job.id,
    outcomes: drafted,
    provenance: "ai_draft",
    jobsFile: file,
    approved: false,
    approvalStatus: catalogJobOf(next).status,
  };
}

/** The human rendering (no `--json`). */
export function renderDraftJobOutcomes(r: DraftJobOutcomesResult): string {
  const lines = r.outcomes.map((o) => `  - ${o.id}: ${o.direction} the ${o.measure} ${o.object}`);
  return `drafted ${r.outcomes.length} outcome(s) for job '${r.jobId}' (provenance ai_draft) in ${r.jobsFile}\n${lines.join("\n")}\nnext: review them, then a person approves: jevitate job review ${r.jobId} · jevitate job approve ${r.jobId}\n`;
}
