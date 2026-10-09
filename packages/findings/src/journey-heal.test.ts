import { describe, expect, it } from "vitest";
import { runFromMissionResult } from "./extract.js";
import { consolidate } from "./consolidate.js";
import { renderReportMarkdown } from "./markdown.js";

/** #453: a self-healed Journey run in the report — exhausted and unexplained are failures, a healed one is a pending proposal. */

const attempt = (n: number, extra: Record<string, unknown> = {}) => ({
  n,
  stepIndex: 1,
  source: "change-evidence",
  hypothesis: `label 'Create New' → 'Make ${n}'`,
  evidence: [{ id: "e1", kind: "label", before: "Create New", after: `Make ${n}`, file: "src/Toolbar.tsx", line: 42 }],
  candidate: { kind: "click", target: { role: "button", name: `Make ${n}` } },
  observation: { screenshot: `/logs/x.heal/step-2-attempt-${n}.png` },
  result: "rejected",
  rejection: { code: "no-match", detail: "no such button" },
  usage: { modelCalls: 0, ms: 5 },
  ...extra,
});

const run = (result: Record<string, unknown>) =>
  runFromMissionResult("/out/journey-checkout-2026-10-09T10-00-00-000Z.result.json", {
    missionOutcome: "defects-found",
    exitCode: 1,
    result: { mode: "journey", journeyId: "checkout", target: { seedUrl: "http://app.test/", allowlist: [] }, ...result },
  })!;

describe("journey self-heal in the report (#453)", () => {
  it("heal-exhausted is a hard journey-assertion titled with its attempt count and carrying the attempts", () => {
    const [o] = run({ outcome: "heal-exhausted", reason: "step 2 could not be healed", at: 1, heal: { verdict: "exhausted", attempts: [attempt(1), attempt(2)] } }).observations;
    expect(o).toMatchObject({ severity: "hard", identity: { category: "journey-assertion" } });
    expect(o!.title).toMatch(/heal exhausted after 2 attempts$/);
    expect(o!.evidence[0]!.healAttempts).toHaveLength(2);
  });

  it("a quarantined run whose break the change does not explain reads as a likely regression", () => {
    const [o] = run({ outcome: "quarantined", reason: "step 2 is not explained by the change", at: 1, heal: { verdict: "unexplained", attempts: [] } }).observations;
    expect(o!.title).toContain("likely regression: step 2 is not explained by the change");
  });

  it("a healed-pending-review run is a pending (not defect) journey-heal-pending finding that points at the review", () => {
    const record = run({
      outcome: "healed-pending-review",
      heal: { verdict: "proposed", attempts: [attempt(1, { result: "accepted", rejection: undefined })] },
      proposal: { id: "abc123def456", path: "/j/.proposals/checkout.json", steps: [{ number: 2, before: "click button 'Create New'", after: "click button 'Create'" }] },
    });
    const [o] = record.observations;
    expect(o).toMatchObject({ severity: "pending", identity: { category: "journey-heal-pending" }, reproduce: "jevitate journey review checkout" });
    expect(consolidate([record]).filter((d) => d.severity === "hard")).toHaveLength(0);
  });

  it("the markdown report prints the attempt table and a Proposed Journey revisions section", () => {
    const record = run({
      outcome: "healed-pending-review",
      heal: { verdict: "proposed", attempts: [attempt(1, { result: "accepted", rejection: undefined })] },
      proposal: { id: "abc123def456", path: "/j/.proposals/checkout.json", steps: [{ number: 2, before: "click button 'Create New'", after: "click button 'Create'" }] },
    });
    const md = renderReportMarkdown({ title: "t", runs: [record], defects: consolidate([record]) });
    expect(md).toContain("## Proposed Journey revisions");
    expect(md).toContain("| n | hypothesis | evidence | candidate | observation | rejection |");
    expect(md).toContain("src/Toolbar.tsx:42");
    expect(md).toContain("Proposal `abc123def456`");
  });
});
