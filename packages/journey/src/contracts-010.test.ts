import { describe, expect, it } from "vitest";
import {
  APPROVAL_CHANNELS,
  ApprovalProvenanceSchema,
  JOB_STAGES,
  JobSchema,
  JourneySchema,
  anchorRuleIssues,
  type Journey,
} from "./index.js";

/** 0.10 shared contracts: anchor and metadata fields (#466 #467 #465), job fields (#465), `pr-review` (#469). */

function journey(metadata: Record<string, unknown> = {}): Journey {
  return {
    metadata: { id: "order", name: "Place an order", promoted: false, params: [], createdAtIso: "2026-10-01T00:00:00.000Z", ...metadata },
    recording: {
      version: "1",
      site: "http://127.0.0.1:1",
      pages: [
        {
          url: "/",
          steps: [
            { step: { kind: "navigate", url: "/", expect: { kind: "urlIncludes", text: "/" } }, stepId: "s-aaaaaa" },
            { step: { kind: "click", target: { testId: "send" }, expect: { kind: "visible", target: { testId: "done" } } }, stepId: "s-bbbbbb" },
          ],
        },
      ],
    },
  } as Journey;
}

const job = { id: "invite-teammate", trigger: "a colleague joins", motivation: "invite them by email", outcome: "work together" };

const outcome = { id: "invite-fast", direction: "minimize", measure: "time", object: "the time it takes to invite a teammate" };

describe("Journey anchors (0.10)", () => {
  it("an anchor with stepId, jobStep and boundary round-trips", () => {
    const anchor = { name: "invite-sent", step: 2, stepId: "s-bbbbbb", jobStep: "send", boundary: "end" };
    expect(JourneySchema.parse(journey({ anchors: [anchor] })).metadata.anchors?.[0]).toEqual(anchor);
  });

  it("an unknown boundary is refused", () => {
    expect(JourneySchema.safeParse(journey({ anchors: [{ name: "a", step: 1, jobStep: "send", boundary: "middle" }] })).success).toBe(false);
  });

  it("a boundary without a jobStep is refused", () => {
    expect(JourneySchema.safeParse(journey({ anchors: [{ name: "a", step: 1, boundary: "start" }] })).success).toBe(false);
  });

  it("an anchor stepId outside the step id rule is refused", () => {
    expect(JourneySchema.safeParse(journey({ anchors: [{ name: "a", step: 1, stepId: "S 1" }] })).success).toBe(false);
  });

  it("anchor validation keeps accepting today's mixed-case names", () => {
    expect(JourneySchema.safeParse(journey({ anchors: [{ name: "Review_Step", step: 1 }] })).success).toBe(true);
  });

  it("the anchor rules report an all-digit name at its path", () => {
    expect(anchorRuleIssues(journey({ anchors: [{ name: "3", step: 1 }] })).map((i) => i.path)).toEqual([["metadata", "anchors", 0, "name"]]);
  });
});

describe("Journey metadata serves and extensions (0.10)", () => {
  it("serves round-trips", () => {
    expect(JourneySchema.parse(journey({ serves: ["invite-fast"] })).metadata.serves).toEqual(["invite-fast"]);
  });

  it("a duplicate serves id is refused", () => {
    expect(JourneySchema.safeParse(journey({ serves: ["a", "a"] })).success).toBe(false);
  });

  it("namespaced extensions round-trip verbatim", () => {
    const extensions = { journeeze: { guide: { pinned: true } } };
    expect(JourneySchema.parse(journey({ extensions })).metadata.extensions).toEqual(extensions);
  });

  it("an extensions namespace that is not a lowercase slug is refused", () => {
    expect(JourneySchema.safeParse(journey({ extensions: { Journeeze: {} } })).success).toBe(false);
  });
});

describe("Job fields (#465)", () => {
  it("a 0.9 job without the new fields still parses", () => {
    expect(JobSchema.safeParse(job).success).toBe(true);
  });

  it("the full set of new job fields round-trips", () => {
    const full = {
      ...job,
      kind: "core",
      parent: "grow-the-team",
      context: ["team plan"],
      steps: [{ id: "send", name: "Send the invitation", stage: "execute" }],
      desiredOutcomes: [
        {
          ...outcome,
          step: "send",
          clarifier: "from opening Members to the invitation being sent",
          gulf: "execution",
          metric: { kind: "duration", from: "members-open", to: "invite-sent", stat: "p50" },
          target: { op: "<=", value: 60, unit: "s" },
          guardrail: false,
          priority: "high",
        },
      ],
      constraints: ["SSO-only workspaces cannot invite by email"],
      provenance: "team_hypothesis",
      revision: 3,
      lastValidated: "2026-10-09",
      extensions: { journeeze: { note: "x" } },
    };
    expect(JobSchema.parse(full)).toEqual(full);
  });

  it("the job-step stages are the universal job map", () => {
    expect(JOB_STAGES).toEqual(["define", "locate", "prepare", "confirm", "execute", "monitor", "modify", "resolve", "conclude"]);
  });

  it("an unknown job kind is refused", () => {
    expect(JobSchema.safeParse({ ...job, kind: "main" }).success).toBe(false);
  });

  it("an unknown provenance is refused", () => {
    expect(JobSchema.safeParse({ ...job, provenance: "guess" }).success).toBe(false);
  });

  it("an unknown job-step stage is refused", () => {
    expect(JobSchema.safeParse({ ...job, steps: [{ id: "s", name: "S", stage: "begin" }] }).success).toBe(false);
  });

  it("an unknown outcome direction is refused", () => {
    expect(JobSchema.safeParse({ ...job, desiredOutcomes: [{ ...outcome, direction: "reduce" }] }).success).toBe(false);
  });

  it("an unknown outcome measure is refused", () => {
    expect(JobSchema.safeParse({ ...job, desiredOutcomes: [{ ...outcome, measure: "money" }] }).success).toBe(false);
  });

  it("a lastValidated that is not a calendar date is refused", () => {
    expect(JobSchema.safeParse({ ...job, lastValidated: "yesterday" }).success).toBe(false);
  });

  it("an unknown top-level key is still refused", () => {
    expect(JobSchema.safeParse({ ...job, bogus: 1 }).success).toBe(false);
  });
});

describe("Desired-outcome metric kinds (#465)", () => {
  const withMetric = (metric: unknown) => JobSchema.safeParse({ ...job, desiredOutcomes: [{ ...outcome, metric }] }).success;

  it.each([
    { kind: "duration", from: "job_start", to: "job_end", stat: "p75" },
    { kind: "duration", from: "a", to: "b", stat: "share_under", threshold: 60 },
    { kind: "completion", from: "a", to: "b" },
    { kind: "abandon", at: "a" },
    { kind: "repeat", at: "a" },
    { kind: "error", at: "a" },
    { kind: "assisted", at: "a" },
    { kind: "answer", question: "got_it_done", value: "partly" },
  ])("accepts $kind with exactly its fields", (metric) => {
    expect(withMetric(metric)).toBe(true);
  });

  it.each([
    ["an unknown kind", { kind: "latency", at: "a" }],
    ["a duration with a field of another kind", { kind: "duration", from: "a", to: "b", stat: "p50", at: "c" }],
    ["share_under without a threshold", { kind: "duration", from: "a", to: "b", stat: "share_under" }],
    ["a threshold without share_under", { kind: "duration", from: "a", to: "b", stat: "p50", threshold: 60 }],
    ["a completion without to", { kind: "completion", from: "a" }],
    ["partly on a question other than got_it_done", { kind: "answer", question: "understood", value: "partly" }],
  ])("refuses %s", (_label, metric) => {
    expect(withMetric(metric)).toBe(false);
  });

  it("a percent target above 100 is refused", () => {
    expect(JobSchema.safeParse({ ...job, desiredOutcomes: [{ ...outcome, target: { op: ">=", value: 101, unit: "percent" } }] }).success).toBe(false);
  });
});

describe("pr-review approval channel (#469)", () => {
  const pr = { number: 42, mergedSha: "0123456789abcdef0123456789abcdef01234567", reviewer: "octocat" };

  it("is a known approval channel", () => {
    expect(APPROVAL_CHANNELS).toContain("pr-review");
  });

  it("a pr-review provenance with its PR round-trips", () => {
    const p = { channel: "pr-review", agentSignals: ["GITHUB_ACTIONS"], pr: { ...pr, forge: "github", url: "https://github.com/o/r/pull/42", author: "dev", reviewedAt: "2026-10-09T00:00:00Z", codeOwner: true } };
    expect(ApprovalProvenanceSchema.parse(p)).toEqual(p);
  });

  it("a pr-review provenance without its PR is refused", () => {
    expect(ApprovalProvenanceSchema.safeParse({ channel: "pr-review", agentSignals: [] }).success).toBe(false);
  });

  it("PR details on another channel are refused", () => {
    expect(ApprovalProvenanceSchema.safeParse({ channel: "tty", agentSignals: [], pr }).success).toBe(false);
  });
});
