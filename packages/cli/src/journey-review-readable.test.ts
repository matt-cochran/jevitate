import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { JourneyReviewSchema, JourneySchema, type Journey } from "@jevitate/journey";
import { buildJourneyReview, renderReviewMarkdown, renderReviewText, reviewSheetHash } from "./journey-review.js";

/** #496 — the human-readable review sheet, on a real 6-step Journey. */

const crm = (): Journey => JourneySchema.parse(JSON.parse(readFileSync(new URL("../test-fixtures/journeys/crm-contacts-import-happy.json", import.meta.url), "utf8")));
const review = buildJourneyReview(crm(), { approvedSnapshot: crm() });
const compact = renderReviewText(review, { width: 100 });
const lines = compact.split("\n");

describe("#496 compact sheet on a real Journey", () => {
  it("no prose line is longer than the width", () => {
    const long = lines.filter((l) => l.length > 100 && /\s/.test(l.trim()) && !/jevitate journey|--reviewed-hash|^Content hash:/.test(l));
    expect(long).toEqual([]);
  });

  it("the content hash line occurs exactly once", () => {
    expect(lines.filter((l) => l.includes("Content hash:"))).toHaveLength(1);
  });

  it("the hash appears nowhere else but the promote command and its line", () => {
    expect(compact.split(review.contentHash).length - 1).toBe(2);
  });

  it("the sheet binds with --review-sheet", () => {
    expect(reviewSheetHash(compact)).toBe(review.contentHash);
  });

  it("the attention list names steps 4–5 as proving nothing", () => {
    expect(review.attention?.[0]?.text).toBe("Steps 4–5 prove nothing: their checks pass even if the step fails");
  });

  it("the attention list is shown first", () => {
    expect(lines.indexOf("NEEDS YOUR ATTENTION")).toBeLessThan(lines.indexOf("STEPS"));
  });

  it("missing goal is flagged with the annotate command", () => {
    expect(compact).toContain("No goal or success criteria written → jevitate journey annotate crm-contacts-import-happy");
  });

  it("raw check syntax is gone", () => {
    expect(compact).not.toContain("count:testId=");
  });

  it("checks are explained inline under a step", () => {
    expect(compact).toContain("✓ the URL contains \"/dev-org-admin/sales/crm/contacts\"");
  });

  it("a weak check is flagged as proving nothing", () => {
    expect(compact).toContain("⚠ any number of field mapper auto accept, including none (proves nothing)");
  });

  it("the recording intent is shown when there is no goal", () => {
    expect(compact).toContain(crm().recording.intent!.trim().split(" ")[0]!);
  });

  it("the uploaded file is shown", () => {
    expect(compact).toContain("Uploads PresentationTier/ui.autopilot/scripts/jevitate/fixtures/crm-import-journey-happy.csv");
  });

  it("an anchor is shown on its step", () => {
    expect(lines.find((l) => /^\s+2\s+click/.test(l))).toContain("⚓ import-open");
  });

  it("a write is attached to its step", () => {
    expect(compact).toContain("writes POST /api/v1/tool/crm-upload/sessions");
  });

  it("the approval time is human-readable", () => {
    expect(compact.replace(/\s+/g, " ")).toContain("approved 11 Oct 2026 08:33 UTC by mc (terminal) · unchanged since");
  });

  it("no raw ISO timestamp appears", () => {
    expect(compact).not.toMatch(/\d{4}-\d\d-\d\dT\d\d:/);
  });

  it("an approved, unchanged Journey prefixes the command", () => {
    expect(compact).toMatch(/\(already approved\)\s+jevitate journey promote crm-contacts-import-happy --reviewed-hash/);
  });

  it("empty sections print no none line", () => {
    expect(compact).not.toMatch(/^\s*- none/m);
  });
});

describe("#496 render options", () => {
  it("full adds the lint section", () => {
    expect(renderReviewText(review, { full: true })).toContain("Lint: 0 error(s), 0 warning(s):");
  });

  it("compact leaves the lint section out", () => {
    expect(compact).not.toContain("Lint:");
  });

  it("colour is off by default", () => {
    expect(compact).not.toContain("\u001b[");
  });

  it("colour adds ANSI when asked", () => {
    expect(renderReviewText(review, { color: true })).toContain("\u001b[33m⚠");
  });

  it("a narrow width wraps with an indent", () => {
    expect(renderReviewText(review, { width: 60 }).split("\n").filter((l) => l.length > 60 && /\s/.test(l.trim()) && !/jevitate journey|--reviewed-hash|^Content hash:/.test(l))).toEqual([]);
  });

  it("markdown has headings and one hash line", () => {
    const md = renderReviewMarkdown(review);
    expect(md.split("Content hash:").length - 1).toBe(1);
  });

  it("markdown has the attention heading", () => {
    expect(renderReviewMarkdown(review)).toContain("## Needs your attention");
  });
});

describe("#496 JSON model", () => {
  it("the model validates with the additive attention list", () => {
    expect(JourneyReviewSchema.safeParse(JSON.parse(JSON.stringify(review))).success).toBe(true);
  });

  it("a gate-clear Journey says nothing needs attention", () => {
    const j = crm();
    j.metadata.goal = "Import contacts";
    j.metadata.successCriteria = [{ description: "contacts listed" }];
    const r = buildJourneyReview(j, { approvedSnapshot: j, lastVerify: { journeyId: j.metadata.id, contentHash: buildJourneyReview(j).contentHash, verdict: "sensitive", summary: {}, at: "2026-10-11T08:00:00.000Z" } });
    expect(r.attention?.filter((a) => a.severity === "warn" && !/prove nothing/.test(a.text))).toEqual([]);
  });
});

describe("#496 attention items", () => {
  const edited = (): Journey => {
    const j = crm();
    j.recording.pages[0]!.steps.pop();
    return j;
  };

  it("a changed Journey summarises the diff", () => {
    const r = buildJourneyReview(edited(), { approvedSnapshot: crm() });
    expect(r.attention?.find((a) => a.text.startsWith("Changed since approval"))?.text).toMatch(/^Changed since approval: .*−1 step/);
  });

  it("an unpromoted Journey gets the bare promote command", () => {
    const j = crm();
    j.metadata.promoted = false;
    expect(renderReviewText(buildJourneyReview(j), { width: 100 })).not.toContain("(already approved)");
  });

  it("a changed Journey is not marked already approved", () => {
    expect(renderReviewText(buildJourneyReview(edited(), { approvedSnapshot: crm() }))).not.toContain("(already approved)");
  });

  it("a pending proposal is listed in attention", () => {
    const base = buildJourneyReview(crm(), { approvedSnapshot: crm() });
    const proposal = { proposalId: "p-1", baseHash: base.contentHash, proposedHash: "c".repeat(64), createdAt: "2026-10-11T09:00:00.000Z", attempts: [], changes: { notes: [] }, steps: [] };
    const r = buildJourneyReview(crm(), { approvedSnapshot: crm(), proposal: { proposal: proposal as never, stale: false } });
    expect(r.attention?.some((a) => a.text.startsWith("A self-heal proposal"))).toBe(true);
  });

  it("a pending proposal gets its own section with the accept command", () => {
    const base = buildJourneyReview(crm(), { approvedSnapshot: crm() });
    const proposal = { proposalId: "p-1", baseHash: base.contentHash, proposedHash: "c".repeat(64), createdAt: "2026-10-11T09:00:00.000Z", attempts: [], changes: { notes: [] }, steps: [] };
    const r = buildJourneyReview(crm(), { approvedSnapshot: crm(), proposal: { proposal: proposal as never, stale: false } });
    expect(renderReviewText(r)).toContain("--proposal p-1 --reviewed-hash " + "c".repeat(64));
  });

  it("with nothing to decide the sheet says so", () => {
    const r = buildJourneyReview(crm(), { approvedSnapshot: crm() });
    const clean = { ...r, attention: [] };
    expect(renderReviewText(clean)).toContain("NEEDS YOUR ATTENTION  nothing — every gate is clear");
  });
});
