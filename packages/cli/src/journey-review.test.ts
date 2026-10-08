import { describe, expect, it } from "vitest";
import { JourneyReviewSchema, type Journey } from "@jevitate/journey";
import { buildJourneyReview, journeyReviewHash, renderReviewMarkdown, renderReviewText, reviewSheetHash, type JourneyVerifyRecord } from "./journey-review.js";

/** #432 — the review sheet builder: one assertion per test, per section. */

const SITE = "https://shop.example.test";
const LITERAL_SECRET = "hunter2-literal-value";
const SECRET_KEY_NAME = "SHOP_PASSWORD_ENV_KEY";

export function fixtureJourney(overrides: Partial<Journey["metadata"]> = {}): Journey {
  return {
    metadata: {
      id: "buy-pro",
      name: "Buy the Pro plan",
      description: "Signs in and buys the Pro plan",
      promoted: false,
      params: ["email", "password"],
      createdAtIso: "2026-10-01T00:00:00.000Z",
      goal: "Buy the Pro plan",
      successCriteria: [{ description: "The order is confirmed", check: { kind: "textIncludes", target: { role: "status" }, text: "Order confirmed" } }],
      parameters: [{ name: "email", description: "the buyer's login" }, { name: "password", secret: true }],
      secretRefs: [{ manager: "env", key: SECRET_KEY_NAME, origin: SITE, field: "password" }],
      endState: [
        { kind: "responseStatus", method: "POST", pathGlob: "/api/orders", status: { class: 2 } },
        { kind: "reloadThen", assertion: { kind: "textIncludes", target: { testId: "plan" }, text: "Pro" } },
      ],
      ...overrides,
    },
    recording: {
      version: "1.0.0",
      site: SITE,
      pages: [
        {
          url: `${SITE}/login`,
          steps: [
            { step: { kind: "navigate", url: "/login", expect: { kind: "visible", target: { label: "Email" } } }, objective: "Open the sign-in page" },
            { step: { kind: "fill", target: { label: "Email" }, value: { var: "email" }, expect: { kind: "visible", target: { label: "Email" } } } },
            { step: { kind: "fill", target: { label: "Password" }, value: { var: "password" }, expect: { kind: "visible", target: { role: "button", name: "Sign in" } } } },
            {
              step: { kind: "fill", target: { label: "API token" }, value: { redacted: false, value: LITERAL_SECRET }, expect: { kind: "visible", target: { role: "button", name: "Sign in" } } },
            },
            { step: { kind: "click", target: { role: "button", name: "Sign in" }, expect: { kind: "urlIncludes", text: "/plans" } } },
          ],
        },
        {
          url: `${SITE}/plans`,
          steps: [
            {
              step: { kind: "click", target: { role: "button", name: "Activate Pro" }, expect: { kind: "textIncludes", target: { role: "status" }, text: "Order confirmed" } },
              objective: "Pay for the plan",
              expectedResult: "The order is confirmed",
              expectRequests: [{ kind: "responseStatus", method: "POST", pathGlob: "/api/orders", status: { class: 2 } }],
              delta: { verdict: "relevant-change", why: "status changed", changes: ["status: Order confirmed"], requests: ["POST /api/orders → 201", "GET https://cdn.example.test/plan.json → 200"], overheadMs: 3 },
            },
            { step: { kind: "click", target: { role: "button", name: "Sign out" }, expect: { kind: "urlIncludes", text: "/login" } } },
          ],
        },
      ],
    },
  };
}

const VERIFY: JourneyVerifyRecord = {
  journeyId: "buy-pro",
  contentHash: journeyReviewHash(fixtureJourney()),
  verdict: "proven",
  summary: { sensitive: 3, insensitive: 0, cascade: 0, notApplied: 0, error: 0, unpaired: 1 },
  at: "2026-10-02T00:00:00.000Z",
};

const review = buildJourneyReview(fixtureJourney(), { safety: { paid: ["/^Activate/"] }, lastVerify: VERIFY, approvedSnapshot: null });

describe("#432 buildJourneyReview", () => {
  it("is schema-valid JSON", () => {
    expect(JourneyReviewSchema.safeParse(JSON.parse(JSON.stringify(review))).success).toBe(true);
  });

  it("summary: carries the goal", () => {
    expect(review.summary.goal).toBe("Buy the Pro plan");
  });

  it("summary: carries the success criteria with their checks", () => {
    expect(review.summary.successCriteria).toEqual([{ description: "The order is confirmed", check: "textIncludes:role=status|Order confirmed" }]);
  });

  it("summary: flags steps without an objective", () => {
    expect(review.summary.missingIntent).toEqual([expect.stringMatching(/^5 of 7 step\(s\) have no objective/)]);
  });

  it("summary: flags a missing goal and success criteria", () => {
    const bare = buildJourneyReview(fixtureJourney({ goal: undefined, successCriteria: undefined }));
    expect(bare.summary.missingIntent.slice(0, 2)).toEqual([expect.stringMatching(/^no goal/), expect.stringMatching(/^no success criteria/)]);
  });

  it("steps: the action in plain words with its target control, objective and expected result", () => {
    expect(review.steps[5]).toMatchObject({
      number: 6,
      action: 'click button "Activate Pro"',
      target: { role: "button", name: "Activate Pro" },
      objective: "Pay for the plan",
      expectedResult: "The order is confirmed",
    });
  });

  it("steps: the parameters each step uses", () => {
    expect(review.steps.map((s) => s.params)).toEqual([[], ["email"], ["password"], [], [], [], []]);
  });

  it("side effects: the expected write requests (recorded, expected, end state)", () => {
    expect(review.sideEffects.writeRequests).toEqual([
      { method: "POST", endpoint: "/api/orders", source: "recorded", step: 6 },
      { method: "POST", endpoint: "/api/orders", source: "expect-request", step: 6 },
      { method: "POST", endpoint: "/api/orders", source: "end-state" },
    ]);
  });

  it("side effects: controls matching the safety rules, with their rule ids", () => {
    expect(review.sideEffects.riskyControls.map((c) => `${c.step}:${c.control}:${c.ruleId}`)).toEqual(["6:Activate Pro:paid:/^Activate/", "7:Sign out:builtin:session-end"]);
  });

  it("side effects: the origins it touches", () => {
    expect(review.sideEffects.origins).toEqual([SITE, "https://cdn.example.test"]);
  });

  it("inputs: parameters by name, secrets marked", () => {
    expect(review.inputs.params).toEqual([
      { name: "email", description: "the buyer's login", secret: false },
      { name: "password", secret: true },
    ]);
  });

  it("inputs: secret references by field and manager only", () => {
    expect(review.inputs.secrets).toEqual([{ field: "password", manager: "env", origin: SITE }]);
  });

  it("proof: the end-state checks", () => {
    expect(review.proof.endState).toEqual(["responseStatus:POST /api/orders=2xx", "reloadThen:textIncludes:testId=plan|Pro"]);
  });

  it("proof: per-step assertions, the weak ones marked", () => {
    expect(review.proof.stepAssertions.filter((a) => a.weak).map((a) => a.step)).toEqual([1, 2, 3, 4]);
  });

  it("proof: the lint result", () => {
    expect(review.proof.lint.errors).toBe(review.proof.lint.findings.filter((f) => f.level === "error").length);
  });

  it("proof: the last mutation-proof verdict when one is recorded", () => {
    expect(review.proof.verify).toMatchObject({ status: "recorded", verdict: "proven", stale: false });
  });

  it("proof: a proof recorded for other content is stale", () => {
    const r = buildJourneyReview(fixtureJourney(), { lastVerify: { ...VERIFY, contentHash: "0".repeat(64) } });
    expect(r.proof.verify).toMatchObject({ status: "recorded", stale: true });
  });

  it("proof: not verified, with how to run it, when none is recorded", () => {
    expect(buildJourneyReview(fixtureJourney()).proof.verify).toEqual({ status: "not-verified", hint: expect.stringContaining("jevitate journey verify buy-pro --mutate") });
  });

  it("change: first approval when never approved", () => {
    expect(review.changeSinceApproval).toEqual({ kind: "first-approval" });
  });

  it("change: a diff against the approved snapshot", () => {
    const approved = fixtureJourney();
    const current = fixtureJourney({ endState: [{ kind: "responseStatus", method: "POST", pathGlob: "/api/orders", status: { class: 2 } }] });
    const r = buildJourneyReview(current, { approvedSnapshot: approved });
    expect(r.changeSinceApproval).toMatchObject({ kind: "diff", changed: true, assertions: { added: [], removed: ["end state: reloadThen:textIncludes:testId=plan|Pro"] } });
  });

  it("change: unchanged since an approval whose bookkeeping differs", () => {
    const approved = fixtureJourney();
    const current = fixtureJourney({ promoted: true, approval: { contentHash: journeyReviewHash(approved), at: "2026-10-03T00:00:00.000Z" } });
    expect(buildJourneyReview(current, { approvedSnapshot: approved }).changeSinceApproval).toMatchObject({ kind: "diff", changed: false });
  });

  it("change: an approval whose snapshot is missing is compared by hash", () => {
    const current = fixtureJourney({ promoted: true, approval: { contentHash: "a".repeat(64), at: "2026-10-03T00:00:00.000Z" } });
    expect(buildJourneyReview(current).changeSinceApproval).toEqual({ kind: "snapshot-missing", approvedHash: "a".repeat(64), approvedAt: "2026-10-03T00:00:00.000Z", changed: true });
  });

  it("content hash: the review hash, which promoting does not change", () => {
    expect(review.contentHash).toBe(journeyReviewHash(fixtureJourney({ promoted: true, acceptedWeak: { reason: "x", rules: [] } })));
  });
});

describe("#432 secrets never appear in the sheet", () => {
  const outputs = { json: JSON.stringify(review), markdown: renderReviewMarkdown(review), text: renderReviewText(review) };
  for (const [kind, out] of Object.entries(outputs)) {
    it(`${kind}: no credential-field literal`, () => {
      expect(out).not.toContain(LITERAL_SECRET);
    });
    it(`${kind}: no secret-manager key`, () => {
      expect(out).not.toContain(SECRET_KEY_NAME);
    });
  }
});

describe("#432 rendering", () => {
  it("markdown snapshot of the fixture Journey", () => {
    expect(renderReviewMarkdown(review)).toMatchSnapshot();
  });

  it("a rendered sheet names its content hash (markdown)", () => {
    expect(reviewSheetHash(renderReviewMarkdown(review))).toBe(review.contentHash);
  });

  it("a rendered sheet names its content hash (text)", () => {
    expect(reviewSheetHash(renderReviewText(review))).toBe(review.contentHash);
  });

  it("a JSON sheet names its content hash", () => {
    expect(reviewSheetHash(JSON.stringify(review))).toBe(review.contentHash);
  });

  it("a sheet naming no hash is refused", () => {
    expect(() => reviewSheetHash("# nothing here")).toThrow(/names no content hash/);
  });
});
