import type { CatalogRefIssue, Finding, GtwrSetCharacteristic, Metric, OutcomeTarget } from "@jevitate/journey";
import { BrokenJobRefsError, findJob, journeysForJob, type Catalog, type CatalogJob, type CatalogJourney } from "./catalog.js";

/**
 * #465 — the catalog's reference checks (jtbd-data-model §7.4, catalog-bundle-v1 §9.5). Within a
 * job: step ids are unique, an outcome's `step` is a step of the job, outcome ids are unique, a
 * metric's `from`/`to`/`at` is `job_start`/`job_end` or an anchor some Journey linked to the job
 * declares, a target's unit fits its metric, and `parent` names a declared job with no cycle. On a
 * Journey: `serves[]` names desired outcomes of its own job, and an anchor's `jobStep` a step of it.
 *
 * Severity (#466 ruling): a problem in the data as loaded is a `warning` — nothing here blocks a
 * load, a run, `catalog status` or a review sheet. An approval enforces (`enforce: true`): the
 * STRUCTURAL problems — the ones a catalog bundle refuses — become `error`s, and `job approve`
 * refuses a job that has one (`assertJobRefs`, E_JOB_BROKEN_REF, exit 64). Gaps (an unmeasurable
 * metric, a target unit that does not fit) stay warnings: the spec calls them gaps, not errors.
 * A Journey linking an undeclared job is the dangling-link report's, not checked here.
 */

export { BrokenJobRefsError };

/** The anchors every job has: the start and the end of the job itself. */
export const RESERVED_ANCHORS = ["job_start", "job_end"] as const;

export type CatalogRefCode =
  | "job.duplicate-step"
  | "job.unknown-outcome-step"
  | "job.duplicate-outcome"
  | "job.unknown-parent"
  | "job.parent-cycle"
  | "job.unmeasurable-metric"
  | "job.target-unit-mismatch"
  | "journey.unknown-serves"
  | "journey.serves-without-job"
  | "journey.unknown-job-step"
  | "journey.job-step-without-job";

/** The problems a catalog bundle refuses (catalog-bundle-v1 §9.5); the others are gaps. */
export const STRUCTURAL_REF_CODES: ReadonlySet<CatalogRefCode> = new Set<CatalogRefCode>([
  "job.duplicate-step",
  "job.unknown-outcome-step",
  "job.duplicate-outcome",
  "job.unknown-parent",
  "job.parent-cycle",
  "journey.unknown-serves",
  "journey.serves-without-job",
  "journey.unknown-job-step",
  "journey.job-step-without-job",
]);

export interface RefCheckOptions {
  /** An approval: structural problems are `error`s. Default: every problem is a `warning`. */
  readonly enforce?: boolean;
}

type Owner = { readonly jobId: string } | { readonly journeyId: string };

function issue(owner: Owner, path: string, code: CatalogRefCode, message: string, fix: string, opts: RefCheckOptions): CatalogRefIssue {
  const structural = STRUCTURAL_REF_CODES.has(code);
  return { ...owner, path, code, structural, severity: structural && opts.enforce === true ? "error" : "warning", message, fix };
}

const list = (ids: readonly string[]): string => (ids.length === 0 ? "none" : ids.join(", "));

/** The units a target can have for a metric (a duration's percentile is seconds; a share is a percent). */
function unitsFor(m: Metric): readonly OutcomeTarget["unit"][] {
  if (m.kind === "duration") return m.stat === "share_under" ? ["percent"] : ["s"];
  if (m.kind === "error") return ["count", "percent"];
  return ["percent"];
}

function metricAnchors(m: Metric): [field: "from" | "to" | "at", name: string][] {
  if (m.kind === "duration" || m.kind === "completion") return [["from", m.from], ["to", m.to]];
  if (m.kind === "answer") return [];
  return [["at", m.at]];
}

/** The anchor names the Journeys linked to a job declare. */
export function jobAnchorNames(catalog: Catalog, jobId: string): Set<string> {
  return new Set(journeysForJob(catalog, jobId).flatMap((j) => (j.journey.metadata.anchors ?? []).map((a) => a.name)));
}

function parentCycle(catalog: Catalog, start: CatalogJob): boolean {
  const seen = new Set<string>([start.id]);
  let next = start.job.parent;
  while (next !== undefined) {
    if (next === start.id) return true;
    if (seen.has(next)) return false; // a cycle further up, not through this job
    seen.add(next);
    next = findJob(catalog, next)?.job.parent;
  }
  return false;
}

/** #465: the reference problems of one job (its own fields; a Journey's are `journeyRefIssues`). */
export function jobRefIssues(catalog: Catalog, jobId: string, opts: RefCheckOptions = {}): CatalogRefIssue[] {
  const cj = findJob(catalog, jobId);
  if (cj === undefined) return [];
  const { job } = cj;
  const owner = { jobId };
  const out: CatalogRefIssue[] = [];
  const steps = job.steps ?? [];
  const stepIds = steps.map((s) => s.id);
  steps.forEach((s, i) => {
    if (stepIds.indexOf(s.id) !== i) out.push(issue(owner, `steps[${i}].id`, "job.duplicate-step", `step id '${s.id}' is declared twice`, "give each step its own id", opts));
  });
  const outcomes = job.desiredOutcomes ?? [];
  const outcomeIds = outcomes.map((o) => o.id);
  const anchors = jobAnchorNames(catalog, jobId);
  outcomes.forEach((o, i) => {
    const at = `desiredOutcomes[${i}]`;
    if (outcomeIds.indexOf(o.id) !== i) out.push(issue(owner, `${at}.id`, "job.duplicate-outcome", `desired outcome id '${o.id}' is declared twice`, "give each desired outcome its own id", opts));
    if (o.step !== undefined && !stepIds.includes(o.step)) {
      out.push(issue(owner, `${at}.step`, "job.unknown-outcome-step", `desired outcome '${o.id}' names step '${o.step}', which is not a step of job '${jobId}' (steps: ${list(stepIds)})`, "name one of the job's step ids, or leave `step` out (the whole job)", opts));
    }
    if (o.metric === undefined) return;
    for (const [field, name] of metricAnchors(o.metric)) {
      if ((RESERVED_ANCHORS as readonly string[]).includes(name) || anchors.has(name)) continue;
      out.push(
        issue(
          owner,
          `${at}.metric.${field}`,
          "job.unmeasurable-metric",
          `desired outcome '${o.id}': metric ${field} '${name}' is an anchor no Journey of job '${jobId}' declares — unmeasurable until one does`,
          `add an anchor named '${name}' to a Journey linked to '${jobId}', or use job_start / job_end`,
          opts,
        ),
      );
    }
    if (o.target !== undefined) {
      const units = unitsFor(o.metric);
      if (!units.includes(o.target.unit)) {
        out.push(issue(owner, `${at}.target.unit`, "job.target-unit-mismatch", `desired outcome '${o.id}': a ${o.metric.kind} metric is measured in ${units.join(" or ")}, not ${o.target.unit}`, `set target.unit to ${units.join(" or ")}`, opts));
      }
    }
  });
  if (job.parent !== undefined) {
    if (findJob(catalog, job.parent) === undefined) {
      out.push(issue(owner, "parent", "job.unknown-parent", `parent '${job.parent}' is not a declared job`, "name a job in jobs.json, or leave `parent` out", opts));
    } else if (parentCycle(catalog, cj)) {
      out.push(issue(owner, "parent", "job.parent-cycle", `parent '${job.parent}' leads back to job '${jobId}' (a parent cycle)`, "break the cycle: a job cannot be its own ancestor", opts));
    }
  }
  return out;
}

/** #465: the reference problems of one Journey (`serves`, anchors' `jobStep`). */
export function journeyRefIssues(catalog: Catalog, j: CatalogJourney, opts: RefCheckOptions = {}): CatalogRefIssue[] {
  const m = j.journey.metadata;
  const owner = { journeyId: j.id };
  const out: CatalogRefIssue[] = [];
  const anchors = m.anchors ?? [];
  if (j.job === undefined) {
    if (m.serves !== undefined && m.serves.length > 0) {
      out.push(issue(owner, "metadata.serves", "journey.serves-without-job", `serves ${list(m.serves)}, but the Journey links no job (metadata.job)`, "link the job whose outcomes it serves, or remove `serves`", opts));
    }
    anchors.forEach((a, i) => {
      if (a.jobStep !== undefined) {
        out.push(issue(owner, `metadata.anchors[${i}].jobStep`, "journey.job-step-without-job", `anchor '${a.name}' names job step '${a.jobStep}', but the Journey links no job`, "link the job (metadata.job), or remove the anchor's jobStep", opts));
      }
    });
    return out;
  }
  const job = findJob(catalog, j.job);
  if (job === undefined) return out; // a dangling job link: `catalog status` reports it
  const outcomeIds = (job.job.desiredOutcomes ?? []).map((o) => o.id);
  const stepIds = (job.job.steps ?? []).map((s) => s.id);
  (m.serves ?? []).forEach((id, i) => {
    if (!outcomeIds.includes(id)) {
      out.push(issue(owner, `metadata.serves[${i}]`, "journey.unknown-serves", `serves '${id}', which is not a desired outcome of job '${job.id}' (outcomes: ${list(outcomeIds)})`, "name one of the job's desired outcome ids", opts));
    }
  });
  anchors.forEach((a, i) => {
    if (a.jobStep !== undefined && !stepIds.includes(a.jobStep)) {
      out.push(issue(owner, `metadata.anchors[${i}].jobStep`, "journey.unknown-job-step", `anchor '${a.name}' names job step '${a.jobStep}', which is not a step of job '${job.id}' (steps: ${list(stepIds)})`, "name one of the job's step ids", opts));
    }
  });
  return out;
}

/** #465: every reference problem in the catalog — the jobs' (in file order), then the Journeys'. */
export function catalogRefIssues(catalog: Catalog, opts: RefCheckOptions = {}): CatalogRefIssue[] {
  return [...catalog.jobs.flatMap((j) => jobRefIssues(catalog, j.id, opts)), ...catalog.journeys.flatMap((j) => journeyRefIssues(catalog, j, opts))];
}

/** #465: the problems a job review sheet shows — the job's own, then those of the Journeys linked to it. */
export function jobSheetRefIssues(catalog: Catalog, jobId: string): CatalogRefIssue[] {
  return [...jobRefIssues(catalog, jobId), ...journeysForJob(catalog, jobId).flatMap((j) => journeyRefIssues(catalog, j))];
}

/** One issue as one line: `job invite · steps[2].id: step id 'send' is declared twice — fix: …`. */
export function describeRefIssue(i: CatalogRefIssue): string {
  const who = i.jobId !== undefined ? `job ${i.jobId}` : `journey ${i.journeyId ?? "?"}`;
  return `${who} · ${i.path}: ${i.message}${i.fix === undefined ? "" : ` — fix: ${i.fix}`}`;
}

/** #465: refuses approving a job whose own references are structurally broken (gaps pass). */
export function assertJobRefs(catalog: Catalog, jobId: string): void {
  const errors = jobRefIssues(catalog, jobId, { enforce: true }).filter((i) => i.severity === "error");
  if (errors.length === 0) return;
  throw new BrokenJobRefsError(
    `job '${jobId}' has ${errors.length} broken reference(s), so it cannot be approved: ${errors.map(describeRefIssue).join("; ")} — fix the jobs file, then review it again (jevitate job review ${jobId})`,
    errors,
  );
}

function characteristicOf(i: CatalogRefIssue): GtwrSetCharacteristic {
  if (i.code === "job.unmeasurable-metric") return "able to be validated";
  return "consistent";
}

/** #465: reference problems as catalog-analysis findings (warnings; never an acknowledgment). */
export function refIssueFindings(issues: readonly CatalogRefIssue[], analyzer = "catalog-analysis"): Finding[] {
  return issues.map((i) => ({
    analyzer,
    code: `ref.${i.code}:${i.jobId ?? i.journeyId ?? ""}:${i.path}`,
    severity: "warn",
    message: `${i.jobId !== undefined ? `job '${i.jobId}'` : `journey '${i.journeyId ?? ""}'`} ${i.path}: ${i.message}`,
    ...(i.fix === undefined ? {} : { fix: i.fix }),
    requiresAcknowledgment: false,
    items: [i.jobId !== undefined ? `job:${i.jobId}` : `journey:${i.journeyId ?? ""}`],
    characteristic: characteristicOf(i),
  }));
}
