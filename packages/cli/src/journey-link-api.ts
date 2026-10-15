import { FsJourneyStore, JourneyRegistry, type CatalogItemStatus, type Journey } from "@jevitate/journey";
import { CatalogLoader, type CatalogJob, type CatalogPersona } from "./catalog.js";
import { UnknownJourneyError } from "./journey-api.js";
import { journeyReviewHash } from "./journey-review.js";

/**
 * #523 — `jevitate journey link <id> --job|--persona|--unlink-job|--unlink-persona` (MCP `journey_link`):
 * set or clear a Journey's catalog links (`metadata.job` / `metadata.persona`) without hand-editing
 * its file. Each id is checked against the catalog: an unknown id is refused (listing the known
 * ids); a DRAFT entry may be linked (that is what `catalog draft` is for) and the result says it
 * still needs a person's approval. Linking is never an approval. On a PROMOTED Journey the link
 * still changes, its approval goes stale (as an anchor edit does since #507) and the result carries
 * the re-approval command. A link is prose for the mutation proof (`journeyProofHash` excludes
 * `job` / `persona`), so it never stales a `journey verify --mutate` record.
 */

/** Unusable `journey link` arguments: none of the four, a set+unlink of one field, an unknown catalog id, no project. Exit 64. */
export class JourneyLinkArgsError extends Error {
  readonly code = "E_JOURNEY_LINK_ARGS";
}

export interface JourneyLinkInput {
  readonly job?: string;
  readonly persona?: string;
  readonly unlinkJob?: boolean;
  readonly unlinkPersona?: boolean;
}

export interface JourneyLinkResult {
  readonly journeyId: string;
  /** The Journey's links after the change (absent: not linked). */
  readonly job?: string;
  readonly persona?: string;
  /** The catalog state of an entry this call linked: `approved`, `draft` (never approved) or `stale` (edited since its approval). */
  readonly jobStatus?: CatalogItemStatus;
  readonly personaStatus?: CatalogItemStatus;
  /** False when the links were already as asked: nothing was written. */
  readonly changed: boolean;
  /** One line per linked entry that is not approved: a person reviews and approves it before `journey promote`. */
  readonly needsApproval: readonly string[];
  /** #507 semantics: true (only) when a promoted Journey's links changed — its approval is now stale. */
  readonly needsReapproval?: true;
  /** With `needsReapproval`: `jevitate journey promote <id> --reviewed-hash <new review hash>`, which only a person runs. */
  readonly reapproveCommand?: string;
}

function listIds(ids: readonly string[]): string {
  return ids.length === 0 ? "none" : ids.join(", ");
}

function checkArgs(input: JourneyLinkInput): void {
  const any = input.job !== undefined || input.persona !== undefined || input.unlinkJob === true || input.unlinkPersona === true;
  if (!any) throw new JourneyLinkArgsError("nothing to change: pass --job <jobId>, --persona <personaId>, --unlink-job and/or --unlink-persona");
  if (input.job !== undefined && input.unlinkJob === true) throw new JourneyLinkArgsError("--job and --unlink-job contradict each other: pass one");
  if (input.persona !== undefined && input.unlinkPersona === true) throw new JourneyLinkArgsError("--persona and --unlink-persona contradict each other: pass one");
}

function approvalNote(kind: "job" | "persona", id: string, status: CatalogItemStatus): string | null {
  if (status === "approved") return null;
  const what = status === "draft" ? "a draft (never approved)" : "edited since its approval (stale)";
  return `${kind} '${id}' is ${what}: a person reviews and approves it before journey promote (jevitate ${kind} review ${id}, then jevitate ${kind} approve ${id} --reviewed-hash <hash>)`;
}

/** Sets/clears the Journey's job and persona links. Throws `UnknownJourneyError`, `JourneyLinkArgsError`, `CatalogInputError`. */
export async function linkJourney(journeysDir: string, catalogDir: string | null, id: string, input: JourneyLinkInput): Promise<JourneyLinkResult> {
  checkArgs(input);
  const store = new FsJourneyStore(journeysDir);
  const journey = await new JourneyRegistry(store).get(id);
  if (journey === null) throw new UnknownJourneyError(`unknown journey '${id}'`);

  let jobs: readonly CatalogJob[] = [];
  let personas: readonly CatalogPersona[] = [];
  if (input.job !== undefined || input.persona !== undefined) {
    if (catalogDir === null) throw new JourneyLinkArgsError("no .jevitate/ project was found — run inside a project (jevitate init), or pass --dir");
    const loader = new CatalogLoader({ catalogDir, journeysDir });
    [{ jobs }, { personas }] = await Promise.all([loader.loadJobs(), loader.loadPersonas()]);
  }
  if (input.job !== undefined && !jobs.some((j) => j.id === input.job)) {
    throw new JourneyLinkArgsError(`unknown job '${input.job}' — the catalog's jobs: ${listIds(jobs.map((j) => j.id))} (add one: jevitate catalog draft job ${input.job} --name "<what the user wants to do>")`);
  }
  if (input.persona !== undefined && !personas.some((p) => p.id === input.persona)) {
    throw new JourneyLinkArgsError(`unknown persona '${input.persona}' — the catalog's personas: ${listIds(personas.map((p) => p.id))} (add one: jevitate catalog draft persona ${input.persona} --name "<who they are>")`);
  }

  const metadata: Journey["metadata"] = { ...journey.metadata };
  if (input.job !== undefined) metadata.job = input.job;
  if (input.unlinkJob === true) delete metadata.job;
  if (input.persona !== undefined) metadata.persona = input.persona;
  if (input.unlinkPersona === true) delete metadata.persona;
  const changed = metadata.job !== journey.metadata.job || metadata.persona !== journey.metadata.persona;

  let stored = journey;
  if (changed) {
    const next: Journey = { ...journey, metadata };
    await store.put(next);
    stored = (await store.get(id)) ?? next;
  }

  const jobEntry = input.job === undefined ? undefined : jobs.find((j) => j.id === input.job);
  const personaEntry = input.persona === undefined ? undefined : personas.find((p) => p.id === input.persona);
  const needsApproval = [
    jobEntry === undefined ? null : approvalNote("job", jobEntry.id, jobEntry.status),
    personaEntry === undefined ? null : approvalNote("persona", personaEntry.id, personaEntry.status),
  ].filter((n): n is string => n !== null);

  const m = stored.metadata;
  return {
    journeyId: id,
    ...(m.job === undefined ? {} : { job: m.job, ...(jobEntry === undefined ? {} : { jobStatus: jobEntry.status }) }),
    ...(m.persona === undefined ? {} : { persona: m.persona, ...(personaEntry === undefined ? {} : { personaStatus: personaEntry.status }) }),
    changed,
    needsApproval,
    ...(changed && m.promoted ? { needsReapproval: true as const, reapproveCommand: `jevitate journey promote ${id} --reviewed-hash ${journeyReviewHash(stored)}` } : {}),
  };
}

