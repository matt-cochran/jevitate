import { join } from "node:path";
import type { Journey, JourneyLintFinding } from "@jevitate/journey";
import { CatalogLoader, catalogJourney, findJob, personaLinkId, type Catalog } from "./catalog.js";

/**
 * #523 — a Journey with no job or no persona link is flagged on the promote review sheet; these
 * warnings surface the same gap earlier (`journey lint`, `explore-author-journey`), each with the
 * exact way out: link an existing catalog id (listed when the catalog has some) or create a draft
 * (`jevitate catalog draft job|persona …`). Advisory: a warning, never a failure. The rule lives in
 * the CLI because it reads the catalog; `lintJourney` stays pure.
 */

/** How many catalog ids a fix hint lists before "…". */
const MAX_LISTED = 10;

function listed(ids: readonly string[]): string {
  return ids.length <= MAX_LISTED ? ids.join(", ") : `${ids.slice(0, MAX_LISTED).join(", ")}, … (${ids.length - MAX_LISTED} more: jevitate catalog status)`;
}

/** The catalog's personas and jobs (no Journeys), or an empty catalog when it cannot be read — a hint never fails its command. */
export async function loadLinkCatalog(catalogDir: string | null): Promise<Catalog> {
  const empty: Catalog = { dir: catalogDir, personasFile: null, jobsFile: null, personas: [], jobs: [], journeys: [] };
  if (catalogDir === null) return empty;
  try {
    const loader = new CatalogLoader({ catalogDir, journeysDir: join(catalogDir, "journeys") });
    const [{ file: personasFile, personas }, { file: jobsFile, jobs }] = await Promise.all([loader.loadPersonas(), loader.loadJobs()]);
    return { ...empty, personasFile, jobsFile, personas, jobs };
  } catch {
    return empty; // a broken catalog file is `catalog status`'s refusal, not this hint's
  }
}

/** #523: `missing-job` / `missing-persona` warnings for a Journey that links no job / no catalog persona. */
export function missingLinkFindings(catalog: Catalog, journey: Journey): JourneyLintFinding[] {
  const j = catalogJourney(journey);
  const id = j.id;
  const out: JourneyLintFinding[] = [];
  if (j.job === undefined) {
    const jobIds = catalog.jobs.map((x) => x.id);
    const draft = `jevitate catalog draft job ${id} --name "<what the user wants to do>"`;
    out.push({
      rule: "missing-job",
      level: "warning",
      message: `journey '${id}' links no job (metadata.job) — the promote review sheet flags it`,
      fix:
        jobIds.length > 0
          ? `set metadata.job in the Journey's file to an existing job (${listed(jobIds)}), or create a draft: ${draft} and set metadata.job to "${id}"`
          : `create a draft job: ${draft}, then set metadata.job to "${id}" in the Journey's file`,
    });
  }
  if (personaLinkId(catalog, j) === undefined) {
    const linkedJob = j.job === undefined ? undefined : findJob(catalog, j.job);
    const served = linkedJob?.personas.filter((p) => catalog.personas.some((x) => x.id === p)) ?? [];
    const personaIds = served.length > 0 ? served : catalog.personas.map((p) => p.id);
    const freeText = j.personaText?.trim();
    const draft = `jevitate catalog draft persona <persona-id> --name "<who they are>"`;
    out.push({
      rule: "missing-persona",
      level: "warning",
      message: `journey '${id}' links no catalog persona (metadata.persona${freeText === undefined || freeText === "" ? " is not set" : ` "${freeText}" names no catalog persona`}) — the promote review sheet flags it`,
      fix:
        personaIds.length > 0
          ? `set metadata.persona in the Journey's file to an existing persona (${listed(personaIds)}), or create a draft: ${draft} and set metadata.persona to its id`
          : `create a draft persona: ${draft}, then set metadata.persona to its id in the Journey's file`,
    });
  }
  return out;
}

/** #523: the warnings for a Journey, against the catalog in `catalogDir` (advisory; never throws on the catalog). */
export async function journeyLinkWarnings(catalogDir: string | null, journey: Journey): Promise<JourneyLintFinding[]> {
  return missingLinkFindings(await loadLinkCatalog(catalogDir), journey);
}
