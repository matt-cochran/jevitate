import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { JourneySchema, type Journey } from "@jevitate/journey";
import { buildJourneyReview, renderReviewText } from "./journey-review.js";

/** #616 — proof-plan changes (metadata.mutationPairs / metadata.targetedProofs) show in the change-since-approval diff. */

const crm = (): Journey => JourneySchema.parse(JSON.parse(readFileSync(new URL("../test-fixtures/journeys/crm-contacts-import-happy.json", import.meta.url), "utf8")));

const targeted = { check: "end-state:0", mustFailWhen: "swap-param:threadId", relax: ["step:1"] };
const pair = { check: "end-state:0", mustFailWhen: "swap-param:threadId" };

describe("#616 proof-plan diffs in changeSinceApproval", () => {
  it("an added targeted proof appears as an added proof plan", () => {
    const current = crm();
    current.metadata.targetedProofs = [targeted];
    const r = buildJourneyReview(current, { approvedSnapshot: crm() });
    expect(r.changeSinceApproval).toMatchObject({ kind: "diff", proofPlans: { added: ["targeted proof: end-state:0 against swap-param:threadId may relax step:1"], removed: [] } });
  });

  it("a removed mutation pair appears as a removed proof plan", () => {
    const approved = crm();
    approved.metadata.mutationPairs = [pair];
    const r = buildJourneyReview(crm(), { approvedSnapshot: approved });
    expect(r.changeSinceApproval).toMatchObject({ kind: "diff", proofPlans: { added: [], removed: ["mutation pair: end-state:0 must fail when swap-param:threadId"] } });
  });

  it("no proof plans on either side omits the proofPlans field", () => {
    const r = buildJourneyReview(crm(), { approvedSnapshot: crm() });
    expect(r.changeSinceApproval).not.toHaveProperty("proofPlans");
  });

  it("the readable sheet prints a Proof plans block for the targeted-proofs-only change", () => {
    const current = crm();
    current.metadata.targetedProofs = [targeted];
    const r = buildJourneyReview(current, { approvedSnapshot: crm() });
    expect(renderReviewText(r, { full: true })).toContain("Proof plans:");
  });
});
