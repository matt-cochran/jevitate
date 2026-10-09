import { describe, expect, it } from "vitest";
import { JourneyReviewSchema, type Journey } from "@jevitate/journey";
import type { Step } from "@jevitate/recording";
import { buildJourneyReview, journeyReviewHash, renderReviewText } from "./journey-review.js";
import { journeyLocatorHealth } from "./locator-health-api.js";

/** #466/#467/#469/#470 — what the 0.10 review sheet adds. One behavioural assertion per test. */

const CLICK: Step = { kind: "click", target: { role: "button", name: "Go" }, expect: { kind: "urlIncludes", text: "/done" } };
const SHA = "a".repeat(40);

const journey = (metadata: Partial<Journey["metadata"]> = {}): Journey => ({
  metadata: { id: "j", name: "J", promoted: true, params: [], createdAtIso: "2026-10-09T00:00:00Z", ...metadata },
  recording: { version: "1", site: "https://example.test", pages: [{ url: "https://example.test/", steps: [{ step: CLICK }] }] },
});

const prApproved = (): Journey => {
  const j = journey();
  return {
    ...j,
    metadata: {
      ...j.metadata,
      approval: {
        contentHash: journeyReviewHash(j),
        at: "2026-10-09T00:00:00Z",
        provenance: { channel: "pr-review", agentSignals: [], pr: { number: 7, url: "https://github.com/o/r/pull/7", reviewer: "rita", author: "alex", mergedSha: SHA, codeOwner: true } },
      },
    },
  };
};

const ANCHOR_ISSUE = { code: "anchor-name-style", severity: "warning" as const, path: "metadata.anchors[0].name", message: "anchor names are lower-case", fix: "rename it to 'review'" };
// the rule codes are open strings on the sheet
const withIssue = { anchorIssues: [ANCHOR_ISSUE] as never, refIssues: [] };

describe("anchor-rule warnings", () => {
  it("are listed with their fix in the JSON", () => {
    const r = buildJourneyReview(journey(), { anchorIssues: withIssue });
    expect(r.anchorWarnings).toEqual([{ code: "anchor-name-style", severity: "warning", path: "metadata.anchors[0].name", message: "anchor names are lower-case", fix: "rename it to 'review'" }]);
  });
  it("render with their fix", () => {
    expect(renderReviewText(buildJourneyReview(journey(), { anchorIssues: withIssue }))).toContain("fix: rename it to 'review'");
  });
  it("are absent from the sheet when the caller computed none", () => {
    expect(buildJourneyReview(journey(), {}).anchorWarnings).toBeUndefined();
  });
});

describe("the step-id-only label", () => {
  const stale = (): Journey => ({ ...prApproved(), metadata: { ...prApproved().metadata, approval: { contentHash: "b".repeat(64), at: "2026-10-09T00:00:00Z" } } });
  it("is set on the change when the caller says only ids were added", () => {
    expect(buildJourneyReview(stale(), { stepIdOnly: true }).changeSinceApproval).toMatchObject({ kind: "snapshot-missing", stepIdOnly: true });
  });
  it("renders as 'ids added only (warn path)'", () => {
    expect(renderReviewText(buildJourneyReview(stale(), { stepIdOnly: true }))).toContain("ids added only (warn path)");
  });
  it("is absent for an ordinary change", () => {
    expect(renderReviewText(buildJourneyReview(stale(), {}))).not.toContain("ids added only");
  });
});

describe("brittle steps", () => {
  const health = () => journeyLocatorHealth(journey(), ["data-testid"]);
  it("are listed in the JSON with a fix", () => {
    expect(buildJourneyReview(journey(), { locatorHealth: health() }).locatorHealth?.brittleSteps[0]?.fix).toMatch(/data-testid/);
  });
  it("show the summary line in the text", () => {
    expect(renderReviewText(buildJourneyReview(journey(), { locatorHealth: health() }))).toContain(health().line);
  });
  it("the sheet still matches the published schema", () => {
    expect(JourneyReviewSchema.safeParse(buildJourneyReview(journey(), { locatorHealth: health(), anchorIssues: withIssue, stepIdOnly: true })).success).toBe(true);
  });
});

describe("pr-review provenance", () => {
  it("keeps the pull request in the JSON", () => {
    expect(buildJourneyReview(prApproved(), {}).approval?.provenance?.pr).toMatchObject({ number: 7, reviewer: "rita", author: "alex", mergedSha: SHA, codeOwner: true });
  });
  it("renders the PR number, reviewer and code-owner status", () => {
    expect(renderReviewText(buildJourneyReview(prApproved(), {}))).toContain("PR #7 (https://github.com/o/r/pull/7) · reviewer rita · author alex · merged aaaaaaaaaaaa · reviewer is a code owner");
  });
});
