import { describe, expect, it } from "vitest";
import type { Journey, JourneyReview, JourneyTargetedProofPlan } from "@jevitate/journey";
import { runJourneyReadiness, type JourneyReadinessDeps } from "./journey-readiness.js";
import { buildJourneyReview, renderReviewText } from "./journey-review.js";
import { verifyAssertionLine } from "./journey-verify.js";

/**
 * #616 part B — the declared targeted-proof plans surface in the review sheet, the human verify
 * line, and the readiness guidance: a plan the automatic #609 bound refused now names exactly which
 * metadata.targetedProofs entry to declare (a human reviews it like any other proof change).
 */

function journey(id: string, metadata: Partial<Journey["metadata"]> = {}): Journey {
  return {
    metadata: {
      id,
      name: `Journey ${id}`,
      promoted: false,
      params: [],
      createdAtIso: "2026-01-01T00:00:00Z",
      endState: [{ kind: "page", assertion: { kind: "textIncludes", target: { testId: "live" }, text: "published" } }],
      ...metadata,
    },
    recording: { version: "1.0.0", site: "https://example.test", pages: [{ url: "/editor", steps: [] }] },
  };
}

/** A `review` dep returning the given Journey and verify record; nothing else is in play. */
function reviewDep(j: Journey, verify: unknown): NonNullable<JourneyReadinessDeps["review"]> {
  const review = {
    id: j.metadata.id,
    name: j.metadata.name,
    promoted: false,
    summary: { requiresAuth: false, preconditions: [], successCriteria: [], missingIntent: [] },
    steps: [],
    sideEffects: { writeRequests: [], riskyControls: [], origins: [] },
    inputs: { params: [], secrets: [] },
    proof: { endState: [], stepAssertions: [], lint: { errors: 0, warnings: 0, findings: [] }, verify },
    changeSinceApproval: { kind: "first-approval" },
    contentHash: "a".repeat(64),
    attention: [],
    catalog: { linked: true, job: { id: "j", status: "approved" }, persona: { id: "p", status: "approved" }, unvetted: [], needsReReview: [] },
  } as unknown as JourneyReview;
  return (async () => ({ journey: j, review })) as unknown as NonNullable<JourneyReadinessDeps["review"]>;
}

async function proofBlockerWhy(j: Journey, verify: unknown): Promise<string | undefined> {
  const r = await runJourneyReadiness({ id: j.metadata.id, journeysDir: "/tmp/jev-616" }, { review: reviewDep(j, verify) });
  return r.blockers.find((b) => b.check === "proof")?.why;
}

const SUGGESTION: JourneyTargetedProofPlan = { check: "end-state:0", mustFailWhen: "swap-param:threadId", relax: ["step:5", "step:15", "step:16", "step:17", "step:20"] };

const BOUND_REASON =
  "some paired assertions were neither proven nor shown vacuous (cascade, not-applied or error); a targeted proof was refused: relaxation bound 4 reached";

const boundVerify = (suggested?: readonly JourneyTargetedProofPlan[]) => ({
  status: "recorded" as const,
  verdict: "inconclusive",
  at: "2026-01-01T00:00:00Z",
  stale: false,
  reason: BOUND_REASON,
  summary: {},
  ...(suggested === undefined ? {} : { suggestedTargetedProofs: [...suggested] }),
});

const BLOCKED_REASON = "some paired assertions were neither proven nor shown vacuous (cascade, not-applied or error); a targeted proof was refused: step:7 blocked the declared proof (not in relax)";

const UNSOUND_REASON = "some paired assertions were neither proven nor shown vacuous (cascade, not-applied or error); a targeted proof was refused: relaxed site step:7 is not itself proven sensitive to swap-param:threadId";

const blockedVerify = (reason: string) => ({
  status: "recorded" as const,
  verdict: "inconclusive",
  at: "2026-01-01T00:00:00Z",
  stale: false,
  reason,
  summary: {},
});

describe("readiness guidance for a declared targeted proof (#616)", () => {
  it("a bound refusal with a suggestion names the exact metadata.targetedProofs entry to declare", async () => {
    const why = await proofBlockerWhy(journey("publish"), boundVerify([SUGGESTION]));
    expect(why).toContain(JSON.stringify(SUGGESTION));
  });

  it("a bound refusal with a suggestion says a human reviews the plan (the review hash changes)", async () => {
    const why = await proofBlockerWhy(journey("publish"), boundVerify([SUGGESTION]));
    expect(why).toContain("review hash");
  });

  it("a bound refusal no longer recommends removing or reducing checks", async () => {
    const why = await proofBlockerWhy(journey("publish"), boundVerify([SUGGESTION]));
    expect(why).not.toContain("reduce");
  });

  it("a bound refusal without a suggestion still points at metadata.targetedProofs", async () => {
    const why = await proofBlockerWhy(journey("publish"), boundVerify());
    expect(why).toContain("metadata.targetedProofs");
  });

  it("a bound refusal without a suggestion names the bound", async () => {
    const why = await proofBlockerWhy(journey("publish"), boundVerify());
    expect(why).toContain("bound 4");
  });

  it("a blocked declared proof tells the author to add the blocking site to the plan's relax list", async () => {
    const why = await proofBlockerWhy(journey("publish"), blockedVerify(BLOCKED_REASON));
    expect(why).toContain("add step:7 to that plan's relax list");
  });

  it("an unsound relaxed site tells the author to pair it with the mutation or make it a real defense", async () => {
    const why = await proofBlockerWhy(journey("publish"), blockedVerify(UNSOUND_REASON));
    expect(why).toContain("pair step:7 with swap-param:threadId");
  });
});

describe("declared targeted proof in the verify line and the review sheet (#616)", () => {
  it("verifyAssertionLine marks a declared proof's relaxations as a declared plan", () => {
    const line = verifyAssertionLine({ site: "end-state:0", check: "valueEquals Thread", verdict: "sensitive", provedBy: "swap-param:threadId", relaxedSites: ["step:5", "step:15"], declaredProof: true });
    expect(line).toContain("(proved by swap-param:threadId, declared plan relaxed step:5, step:15)");
  });

  it("the review JSON lists the Journey's declared targeted-proof plans", () => {
    const review = buildJourneyReview(journey("declared", { targetedProofs: [SUGGESTION] }));
    expect(review.proof.targetedProofs).toEqual([SUGGESTION]);
  });

  it("the readable review prints one declared-targeted-proof line per plan", () => {
    const review = buildJourneyReview(journey("declared", { targetedProofs: [SUGGESTION] }));
    expect(renderReviewText(review, { width: 200 })).toContain("declared targeted proof: end-state:0 against swap-param:threadId may relax step:5, step:15, step:16, step:17, step:20");
  });
});
