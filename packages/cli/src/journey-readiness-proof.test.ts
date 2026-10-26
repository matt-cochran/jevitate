import { describe, expect, it } from "vitest";
import type { Journey, JourneyReview } from "@jevitate/journey";
import { runJourneyReadiness, type JourneyReadinessDeps } from "./journey-readiness.js";

/**
 * #609 — `journey readiness` explains the mutation proof. The `verify` summary now carries a
 * `targeted` count (assertions also counted in `sensitive`), and a refused targeted proof names why
 * the assertion stays a cascade. These tests drive the public receipt only.
 */

function journey(id: string, metadata: Partial<Journey["metadata"]> = {}): Journey {
  return {
    metadata: {
      id,
      name: `Journey ${id}`,
      promoted: false,
      params: [],
      createdAtIso: "2026-01-01T00:00:00Z",
      endState: [{ kind: "reloadThen", assertion: { kind: "textIncludes", target: { testId: "live" }, text: "published" } }],
      ...metadata,
    },
    recording: { version: "1.0.0", site: "https://example.test", pages: [{ url: "/editor", steps: [] }] },
  };
}

/** A `review` dep that returns the given Journey and the given `verify` record, with nothing else in play. */
function reviewDep(journey: Journey, verify: unknown): NonNullable<JourneyReadinessDeps["review"]> {
  const review = {
    id: journey.metadata.id,
    name: journey.metadata.name,
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
  return (async () => ({ journey, review })) as unknown as NonNullable<JourneyReadinessDeps["review"]>;
}

function receipt(journey: Journey, verify: unknown) {
  return runJourneyReadiness({ id: journey.metadata.id, journeysDir: "/tmp/jev-609" }, { review: reviewDep(journey, verify) });
}

function proofOf(r: Awaited<ReturnType<typeof runJourneyReadiness>>) {
  return r.checks.find((c) => c.check === "proof");
}

function proofBlocker(r: Awaited<ReturnType<typeof runJourneyReadiness>>) {
  return r.blockers.find((b) => b.check === "proof");
}

const PROVEN_WITH_TARGETED = {
  status: "recorded" as const,
  verdict: "proven",
  at: "2026-01-01T00:00:00Z",
  stale: false,
  summary: { sensitive: 5, targeted: 2, insensitive: 0, cascade: 0, notApplied: 0, error: 0, unpaired: 0 },
};

const UNPAIRED_REASON =
  "some paired assertions were neither proven nor shown vacuous (cascade, not-applied or error); a targeted proof was refused: step:3 is not paired with swap-param:threadId";

const UNPAIRED_REFUSAL = {
  status: "recorded" as const,
  verdict: "inconclusive",
  at: "2026-01-01T00:00:00Z",
  stale: false,
  reason: UNPAIRED_REASON,
  summary: {},
};

const BOUND_REFUSAL = {
  status: "recorded" as const,
  verdict: "inconclusive",
  at: "2026-01-01T00:00:00Z",
  stale: false,
  reason: "some paired assertions were neither proven nor shown vacuous (cascade, not-applied or error); a targeted proof was refused: relaxation bound 4 reached",
  summary: {},
};

const GENERIC_INCONCLUSIVE = {
  status: "recorded" as const,
  verdict: "inconclusive",
  at: "2026-01-01T00:00:00Z",
  stale: false,
  reason: "the unmutated replay failed",
  summary: {},
};

describe("journey readiness proof detail", () => {
  it("counts a proven assertion once even when a targeted proof also proved it", async () => {
    const r = await receipt(journey("publish"), PROVEN_WITH_TARGETED);
    expect(proofOf(r)?.detail).toMatch(/^proven 5\/5/);
  });

  it("names how many assertions came through a targeted proof", async () => {
    const r = await receipt(journey("publish"), PROVEN_WITH_TARGETED);
    expect(proofOf(r)?.detail).toContain("2 through a targeted proof");
  });

  it("keeps an inconclusive proof inconclusive", async () => {
    const r = await receipt(journey("publish"), UNPAIRED_REFUSAL);
    expect(proofOf(r)?.state).toBe("inconclusive");
  });

  it("explains a refused targeted proof with a blocker naming mutationPairs", async () => {
    const r = await receipt(journey("publish"), UNPAIRED_REFUSAL);
    expect(proofBlocker(r)?.why).toContain("mutationPairs");
  });

  it("explains a refused targeted proof with a blocker naming the unpaired site", async () => {
    const r = await receipt(journey("publish"), UNPAIRED_REFUSAL);
    expect(proofBlocker(r)?.why).toContain("step:3");
  });

  it("explains a refused targeted proof with a blocker naming the mutation", async () => {
    const r = await receipt(journey("publish"), UNPAIRED_REFUSAL);
    expect(proofBlocker(r)?.why).toContain("swap-param:threadId");
  });

  it("offers the verify command as the blocker's next step", async () => {
    const r = await receipt(journey("publish"), UNPAIRED_REFUSAL);
    expect(proofBlocker(r)?.next).toBe("jevitate journey verify publish --mutate");
  });

  it("never turns a refused targeted proof into technical readiness", async () => {
    const r = await receipt(journey("publish"), UNPAIRED_REFUSAL);
    expect(r.verdict).toBe("inconclusive");
  });

  it("explains a relaxation-bound refusal with a blocker naming the bound", async () => {
    const r = await receipt(journey("publish"), BOUND_REFUSAL);
    expect(proofBlocker(r)?.why).toContain("bound 4");
  });

  it("keeps today's detail for an inconclusive proof without a targeted refusal", async () => {
    const r = await receipt(journey("publish"), GENERIC_INCONCLUSIVE);
    expect(proofOf(r)?.detail).toBe("the unmutated replay failed");
  });

  it("gives generic guidance for an inconclusive proof without a targeted refusal", async () => {
    const r = await receipt(journey("publish"), GENERIC_INCONCLUSIVE);
    expect(proofBlocker(r)?.why).toContain("cascade assertions");
  });
});

describe("journey readiness nothing-to-mutate", () => {
  it("keeps an unpaired receipt inconclusive even if it has a targeted counter", async () => {
    const verify = {
      status: "recorded" as const,
      verdict: "inconclusive",
      at: "2026-01-01T00:00:00Z",
      stale: false,
      reason: "no assertion is paired with a mutation",
      summary: { sensitive: 0, targeted: 1, unpaired: 1, insensitive: 0, cascade: 0, notApplied: 0, error: 0 },
    };
    const r = await receipt(journey("discover"), verify);
    expect(proofOf(r)?.state).toBe("inconclusive");
  });
});
