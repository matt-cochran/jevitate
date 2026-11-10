import { describe, expect, it } from "vitest";
import { contentHash } from "@jevitate/domain";
import { JobSchema } from "./catalog-schema.js";

/** #800 (0.30.0 §3): the job's optional `done` check, in the schema and in the content hash. */

const LEGACY_JOBS = [
  { id: "publish", trigger: "a draft is ready", motivation: "publish it", outcome: "readers see it" },
  {
    id: "invite",
    trigger: "a colleague joins",
    motivation: "invite them by email",
    outcome: "work together",
    personas: ["admin"],
    steps: [{ id: "send", name: "Send the invitation", stage: "execute" }],
    desiredOutcomes: [{ id: "fast", step: "send", direction: "minimize", measure: "time", object: "time to invite", metric: { kind: "duration", from: "job_start", to: "job_end", stat: "p50" } }],
    extensions: { journeeze: { board: "growth" } },
  },
];

const DONE = { version: 1, at: "/members", check: "textIncludes:#list|${email}", distinguishedBy: ["email"] };

const hashOf = (job: ReturnType<typeof JobSchema.parse>): string => {
  const { approval: _a, ...rest } = job;
  return contentHash(rest);
};

describe("#800 job done check", () => {
  it("existing jobs.json entries parse unchanged (done stays absent)", () => {
    for (const j of LEGACY_JOBS) {
      const parsed = JobSchema.parse(j);
      expect(parsed).toEqual(j);
      expect("done" in parsed).toBe(false);
    }
  });

  it("a job with done parses and keeps it", () => {
    expect(JobSchema.parse({ ...LEGACY_JOBS[0], done: DONE }).done).toEqual(DONE);
  });

  it("done is counted in the content hash", () => {
    const without = JobSchema.parse(LEGACY_JOBS[0]);
    const withDone = JobSchema.parse({ ...LEGACY_JOBS[0], done: DONE });
    expect(hashOf(withDone)).not.toBe(hashOf(without));
    expect(hashOf(JobSchema.parse({ ...LEGACY_JOBS[0], done: { ...DONE, at: "/team" } }))).not.toBe(hashOf(withDone));
  });

  it("refuses a malformed done", () => {
    expect(JobSchema.safeParse({ ...LEGACY_JOBS[0], done: { version: 2, at: "/", check: "x" } }).success).toBe(false);
    expect(JobSchema.safeParse({ ...LEGACY_JOBS[0], done: { version: 1, at: "/", check: "x", extra: 1 } }).success).toBe(false);
  });
});
