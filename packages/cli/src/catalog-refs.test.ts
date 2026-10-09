import { describe, expect, it } from "vitest";
import { JobSchema, type Job, type Journey } from "@jevitate/journey";
import { catalogJobOf, catalogJourney, type Catalog } from "./catalog.js";
import { BrokenJobRefsError, assertJobRefs, catalogRefIssues, jobRefIssues, journeyRefIssues, refIssueFindings } from "./catalog-refs.js";

/** #465 — the catalog reference checks: steps, desired outcomes, metric anchors, parents, `serves`, anchor `jobStep`. */

const BASE_JOB = {
  id: "invite",
  trigger: "a colleague joins",
  motivation: "invite them by email",
  outcome: "work together",
  steps: [
    { id: "choose", name: "Choose who to invite", stage: "define" },
    { id: "send", name: "Send the invitation", stage: "execute" },
  ],
  desiredOutcomes: [
    {
      id: "invite-fast",
      step: "send",
      direction: "minimize",
      measure: "time",
      object: "the time to invite a teammate",
      metric: { kind: "duration", from: "members-open", to: "invite-sent", stat: "p50" },
      target: { op: "<=", value: 60, unit: "s" },
    },
  ],
};

function job(patch: Record<string, unknown> = {}): Job {
  return JobSchema.parse({ ...BASE_JOB, ...patch });
}

function journey(id: string, meta: Record<string, unknown> = {}): Journey {
  return {
    metadata: {
      id,
      name: `Journey ${id}`,
      promoted: false,
      params: [],
      createdAtIso: "2026-10-09T00:00:00Z",
      job: "invite",
      anchors: [
        { name: "members-open", step: 1, jobStep: "choose", boundary: "start" },
        { name: "invite-sent", step: 1, jobStep: "send", boundary: "end" },
      ],
      serves: ["invite-fast"],
      ...meta,
    },
    recording: { version: "1.0.0", site: "https://example.test", pages: [{ url: "/", steps: [{ step: { kind: "navigate", url: "/", expect: { kind: "urlIncludes", text: "/" } } }] }] },
  } as Journey;
}

function catalog(jobs: Job[], journeys: Journey[] = [journey("invite-admin")]): Catalog {
  return { dir: null, personasFile: null, jobsFile: null, personas: [], jobs: jobs.map(catalogJobOf), journeys: journeys.map(catalogJourney) };
}

const codes = (c: Catalog, opts = {}) => catalogRefIssues(c, opts).map((i) => `${i.jobId ?? i.journeyId} ${i.path} ${i.code}`);

describe("#465 job references", () => {
  it("a job whose steps, outcomes and metric anchors all resolve has no issues", () => {
    expect(codes(catalog([job()]))).toEqual([]);
  });

  it("a duplicate step id", () => {
    expect(codes(catalog([job({ steps: [...BASE_JOB.steps, { id: "send", name: "Send it again" }] })]))).toEqual(["invite steps[2].id job.duplicate-step"]);
  });

  it("an outcome's step that is not a step of the job", () => {
    expect(codes(catalog([job({ desiredOutcomes: [{ ...BASE_JOB.desiredOutcomes[0], step: "nope" }] })]))).toEqual(["invite desiredOutcomes[0].step job.unknown-outcome-step"]);
  });

  it("a duplicate outcome id", () => {
    expect(codes(catalog([job({ desiredOutcomes: [BASE_JOB.desiredOutcomes[0], { ...BASE_JOB.desiredOutcomes[0], step: undefined }] })]))).toEqual([
      "invite desiredOutcomes[1].id job.duplicate-outcome",
    ]);
  });

  it("job_start and job_end are anchors of every job", () => {
    expect(codes(catalog([job({ desiredOutcomes: [{ ...BASE_JOB.desiredOutcomes[0], metric: { kind: "completion", from: "job_start", to: "job_end" }, target: undefined }] })], []))).toEqual([]);
  });

  it("a metric anchor no Journey of the job has is unmeasurable", () => {
    expect(codes(catalog([job({ desiredOutcomes: [{ ...BASE_JOB.desiredOutcomes[0], metric: { kind: "abandon", at: "gone" }, target: undefined }] })]))).toEqual([
      "invite desiredOutcomes[0].metric.at job.unmeasurable-metric",
    ]);
  });

  it("an anchor on a Journey of another job does not make the metric measurable", () => {
    expect(codes(catalog([job()], [journey("other", { job: "something-else", serves: undefined })]))).toEqual([
      "invite desiredOutcomes[0].metric.from job.unmeasurable-metric",
      "invite desiredOutcomes[0].metric.to job.unmeasurable-metric",
    ]);
  });

  it("a target unit that does not fit its metric", () => {
    expect(codes(catalog([job({ desiredOutcomes: [{ ...BASE_JOB.desiredOutcomes[0], target: { op: "<=", value: 60, unit: "percent" } }] })]))).toEqual([
      "invite desiredOutcomes[0].target.unit job.target-unit-mismatch",
    ]);
  });

  it("a parent that is not a declared job", () => {
    expect(codes(catalog([job({ parent: "nobody" })]))).toEqual(["invite parent job.unknown-parent"]);
  });

  it("a parent cycle flags every job on it", () => {
    expect(codes(catalog([job({ parent: "b" }), job({ id: "b", parent: "invite", steps: undefined, desiredOutcomes: undefined })]))).toEqual([
      "invite parent job.parent-cycle",
      "b parent job.parent-cycle",
    ]);
  });

  it("a job that is its own parent is a cycle", () => {
    expect(codes(catalog([job({ parent: "invite" })]))).toEqual(["invite parent job.parent-cycle"]);
  });

  it("a legacy job (no jtbd fields) has no issues", () => {
    expect(codes(catalog([job({ steps: undefined, desiredOutcomes: undefined })], []))).toEqual([]);
  });
});

describe("#465 Journey references", () => {
  it("a served id that is not an outcome of the Journey's job", () => {
    expect(codes(catalog([job()], [journey("j", { serves: ["invite-fast", "nope"] })]))).toEqual(["j metadata.serves[1] journey.unknown-serves"]);
  });

  it("serves on a Journey linked to no job", () => {
    expect(codes(catalog([job({ desiredOutcomes: undefined })], [journey("j", { job: undefined, anchors: undefined })]))).toEqual(["j metadata.serves journey.serves-without-job"]);
  });

  it("an anchor jobStep that is not a step of the Journey's job", () => {
    expect(codes(catalog([job({ desiredOutcomes: undefined })], [journey("j", { serves: undefined, anchors: [{ name: "x", step: 1, jobStep: "nope" }] })]))).toEqual([
      "j metadata.anchors[0].jobStep journey.unknown-job-step",
    ]);
  });

  it("an anchor jobStep on a Journey linked to no job", () => {
    expect(codes(catalog([], [journey("j", { job: undefined, serves: undefined, anchors: [{ name: "x", step: 1, jobStep: "send" }] })]))).toEqual([
      "j metadata.anchors[0].jobStep journey.job-step-without-job",
    ]);
  });

  it("a Journey linking an undeclared job is left to the dangling-link report", () => {
    expect(codes(catalog([], [journey("j", { job: "undeclared" })]))).toEqual([]);
  });

  it("journeyRefIssues checks one Journey", () => {
    const c = catalog([job()], [journey("a", { serves: ["nope"] }), journey("b", { serves: ["nope"] })]);
    expect(journeyRefIssues(c, c.journeys[1]!).map((i) => i.journeyId)).toEqual(["b"]);
  });
});

describe("#465 severity", () => {
  const broken = catalog([job({ parent: "nobody", desiredOutcomes: [{ ...BASE_JOB.desiredOutcomes[0], metric: { kind: "abandon", at: "gone" }, target: undefined }] })]);

  it("problems in data as loaded are warnings", () => {
    expect([...new Set(catalogRefIssues(broken).map((i) => i.severity))]).toEqual(["warning"]);
  });

  it("enforced, a structural problem is an error and a gap stays a warning", () => {
    expect(jobRefIssues(broken, "invite", { enforce: true }).map((i) => `${i.code} ${i.severity}`)).toEqual(["job.unmeasurable-metric warning", "job.unknown-parent error"]);
  });

  it("assertJobRefs refuses a job with a structural problem", () => {
    expect(() => assertJobRefs(broken, "invite")).toThrow(BrokenJobRefsError);
  });

  it("assertJobRefs passes a job with only gaps", () => {
    expect(() => assertJobRefs(catalog([job({ desiredOutcomes: [{ ...BASE_JOB.desiredOutcomes[0], metric: { kind: "abandon", at: "gone" }, target: undefined }] })]), "invite")).not.toThrow();
  });

  it("as findings they never need an acknowledgment", () => {
    expect(refIssueFindings(catalogRefIssues(broken)).some((f) => f.requiresAcknowledgment)).toBe(false);
  });
});
