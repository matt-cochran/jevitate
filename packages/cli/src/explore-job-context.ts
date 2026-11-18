import { loadCatalog } from "./catalog-api.js";
import { findJob } from "./catalog.js";
import type { GuidanceClaim, JobGuidance } from "@jevitate/journey";

/**
 * #873: `explore --job <id> --job-context` — the approved job's story, `context` and `constraints`
 * become the goal run's mission brief, so what a team wrote and approved in the catalog informs the
 * runs that test the job. Rules:
 *  - opt-in: `--job` alone adds nothing (existing runs and baselines are unchanged);
 *  - approved content only: a draft or stale job is refused before any run;
 *  - bounded: a brief over `JOB_CONTEXT_MAX_CHARS` is refused, never truncated;
 *  - navigation only: the brief never satisfies or relaxes `--success` or the done check (the
 *    goal mission already tells the model its `done` is only a proposal, and code decides).
 */
export const JOB_CONTEXT_MAX_CHARS = 2000;

export interface JobContextInput {
  /** The job story in the catalog template's words ("When …, I want to …, so I can …."). */
  readonly story: string;
  readonly context?: readonly string[] | undefined;
  readonly constraints?: readonly string[] | undefined;
  /** #874: only the navigation parts (aliases, expected states) reach the brief; claims never do. */
  readonly guidance?: Pick<JobGuidance, "aliases" | "expectedStates"> | undefined;
}

export type JobContextBrief = { readonly ok: true; readonly brief: string } | { readonly ok: false; readonly message: string };

/** The mission brief for a job, or why it cannot be one (over the cap). */
export function jobContextBrief(job: JobContextInput): JobContextBrief {
  const parts = [`the user's job (an approved catalog job story): ${job.story}`];
  const context = (job.context ?? []).filter((c) => c.trim() !== "");
  const constraints = (job.constraints ?? []).filter((c) => c.trim() !== "");
  if (context.length > 0) parts.push(`job context: ${context.join(" | ")}`);
  if (constraints.length > 0) parts.push(`job constraints (respect them): ${constraints.join(" | ")}`);
  const aliases = job.guidance?.aliases ?? [];
  if (aliases.length > 0) {
    parts.push(`UI vocabulary: ${aliases.map((a) => `"${a.term}" may appear as ${a.uiTerms.map((u) => `"${u}"`).join(" or ")}`).join("; ")}`);
  }
  const states = job.guidance?.expectedStates ?? [];
  if (states.length > 0) parts.push(`screens the job passes through: ${states.join(" | ")}`);
  const brief = parts.join("; ");
  if (brief.length > JOB_CONTEXT_MAX_CHARS) {
    return {
      ok: false,
      message: `the job context is ${brief.length} characters, longer than the ${JOB_CONTEXT_MAX_CHARS} allowed for --job-context: shorten the job's context or constraints`,
    };
  }
  return { ok: true, brief };
}

export type PreparedJobContext =
  | {
      readonly ok: true;
      readonly jobId: string;
      readonly brief: string;
      readonly contentHash: string;
      /** #874: the job's claims, checked after the run (never part of the brief). */
      readonly claims: readonly GuidanceClaim[];
    }
  | { readonly ok: false; readonly code: string; readonly message: string };

/** Resolves `--job-context` for `--job <id>` from the project catalog; refused unless the job is approved. */
export async function prepareJobContext(req: {
  readonly jobId: string | undefined;
  readonly catalogDir: string | null;
  readonly journeysDir: string;
}): Promise<PreparedJobContext> {
  if (req.jobId === undefined) {
    return { ok: false, code: "E_EXPLORE_ARGS", message: "--job-context needs --job <id>: it supplies that catalog job's approved context" };
  }
  const id = req.jobId;
  let job;
  try {
    job = findJob(await loadCatalog(req.catalogDir, req.journeysDir), id);
  } catch (err) {
    return { ok: false, code: "E_EXPLORE_JOB", message: `--job-context: the catalog could not be read: ${err instanceof Error ? err.message : String(err)}` };
  }
  if (job === undefined) {
    return { ok: false, code: "E_EXPLORE_JOB", message: `--job-context: no job '${id}' in ${req.catalogDir ?? "a .jevitate/ project (none found)"}/jobs.json` };
  }
  if (job.status === "draft") {
    return {
      ok: false,
      code: "E_EXPLORE_JOB",
      message: `--job-context: job '${id}' is not approved, so its context is not used: review and approve it first (jevitate job review ${id}, then jevitate job approve ${id})`,
    };
  }
  if (job.status === "stale") {
    return {
      ok: false,
      code: "E_EXPLORE_JOB",
      message: `--job-context: job '${id}' changed since its approval, so its context is not used: re-review it first (jevitate job review ${id})`,
    };
  }
  const brief = jobContextBrief({ story: job.story, context: job.job.context, constraints: job.job.constraints, guidance: job.job.guidance });
  if (!brief.ok) return { ok: false, code: "E_EXPLORE_JOB", message: `--job-context: ${brief.message}` };
  return { ok: true, jobId: id, brief: brief.brief, contentHash: job.contentHash, claims: job.job.guidance?.claims ?? [] };
}
