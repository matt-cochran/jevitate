import { describe, expect, it } from "vitest";
import { JobSchema } from "./catalog-schema.js";

/** #874 — the optional, additive `guidance` field on a catalog job (contract v4). */

const story = { id: "invite-teammate", trigger: "a colleague joins", motivation: "invite them", outcome: "work together" };
const guidance = {
  aliases: [{ term: "workspace", uiTerms: ["piece"] }],
  expectedStates: ["the team settings page lists pending invites"],
  claims: [
    { id: "invite-pending", statement: "a new invite shows as Pending", check: { version: 1, at: "/team", check: "textIncludes:role=table|Pending" } },
    { id: "one-seat", statement: "an invite uses one free seat" },
  ],
};

const parse = (job: unknown) => JobSchema.safeParse(job);
/** Where a refusal points ("guidance.claims.0.statement"), so a test cannot pass on an unrelated error. */
const issuePaths = (job: unknown): string[] => {
  const r = JobSchema.safeParse(job);
  return r.success ? [] : r.error.issues.map((i) => i.path.join("."));
};

describe("job guidance (#874)", () => {
  it("accepts a job with guidance", () => {
    expect(parse({ ...story, guidance }).success).toBe(true);
  });

  it("a job without guidance still parses (every v3 job stays valid)", () => {
    expect(parse(story).success).toBe(true);
  });

  it("refuses an unknown guidance key (closed, like the rest of the job)", () => {
    expect(issuePaths({ ...story, guidance: { ...guidance, order: 2 } })).toEqual(["guidance"]);
  });

  it("refuses an alias with no UI term", () => {
    expect(issuePaths({ ...story, guidance: { aliases: [{ term: "workspace", uiTerms: [] }] } })).toEqual(["guidance.aliases.0.uiTerms"]);
  });

  it("refuses a claim with no statement", () => {
    expect(issuePaths({ ...story, guidance: { claims: [{ id: "c1" }] } })).toEqual(["guidance.claims.0.statement"]);
  });

  it("refuses a claim whose check is not a done-check shape", () => {
    expect(issuePaths({ ...story, guidance: { claims: [{ id: "c1", statement: "s", check: "textIncludes:x" }] } })).toEqual(["guidance.claims.0.check"]);
  });

  it("refuses two claims with one id", () => {
    const claims = [{ id: "c1", statement: "a" }, { id: "c1", statement: "b" }];
    expect(issuePaths({ ...story, guidance: { claims } })).toEqual(["guidance.claims"]);
  });

  it("caps the number of claims", () => {
    const claims = Array.from({ length: 21 }, (_, i) => ({ id: `c${i}`, statement: "s" }));
    expect(issuePaths({ ...story, guidance: { claims } })).toEqual(["guidance.claims"]);
  });

  it("refuses a multi-line statement (one line, like every catalog text)", () => {
    expect(issuePaths({ ...story, guidance: { claims: [{ id: "c1", statement: "line one\nline two" }] } })).toEqual(["guidance.claims.0.statement"]);
  });
});
