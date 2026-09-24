import { describe, expect, it } from "vitest";
import { detectFriction, groundFindings, type FrictionPoint } from "./friction.js";
import { buildReport } from "./report.js";
import { makeSignalFinding, type RunSignalCapture, type SignalScreen, type SignalStep } from "./signals.js";
import type { AnalysisOutcome, UxFinding } from "./types.js";

const URL = "http://app.test/checkout";

function step(n: number, op: string | null, over: Partial<SignalStep> = {}): SignalStep {
  return { step: n, op, target: op === "click" ? `button "Pay"` : null, actOk: true, url: URL, ...over };
}
function screen(index: number, n: number, over: Partial<SignalScreen> = {}): SignalScreen {
  return { index, step: n, at: n * 1000, url: URL, signature: `sig-${n}`, visibleText: "Checkout", busy: false, ...over };
}

function rubricFinding(id: string, severity: UxFinding["severity"], confidence: number, screenId: string, route = "/checkout"): UxFinding {
  return Object.freeze({
    rubricItemId: id,
    citation: { source: "S", ref: id },
    severity,
    confidence,
    evidenceRefs: [{ id: "control:0" }],
    observation: `observation ${id}`,
    userImpact: "impact",
    recommendation: "fix",
    tier: "semantic" as const,
    screenId,
    route,
    controls: ['button "Pay"'],
    quotes: [],
    occurrences: 1,
    screenIds: [screenId],
  });
}

const coverage = { totalItems: 1, evaluated: 1, skipped: [], budgetTruncated: [] };

describe("detectFriction (#132)", () => {
  it("finds retries, dead ends, long waits, errors, backtracks, abandoned fields and an unreached goal — each with its step range", () => {
    const capture: RunSignalCapture = {
      steps: [
        step(1, "type", { target: 'textbox "Coupon"', value: "SAVE10" }),
        step(2, "click", { url: "http://app.test/cart" }),
        step(3, "click"),
        step(4, "click"),
        step(5, "wait", { reason: "waited 3.0s (the page did not change)" }),
        step(6, "wait", { reason: "waited 3.0s (the page did not change)" }),
        step(7, "click", { target: 'button "Confirm"', actOk: false, reason: "disabled" }),
        step(8, "blocked", { reason: "model blocked" }),
      ],
      requests: [{ id: 0, method: "POST", endpoint: "POST /api/pay", url: "http://app.test/api/pay", resourceType: "fetch", startedAt: 4000, endedAt: 4100, status: 502, step: 4 }],
      screens: [
        screen(0, 1),
        screen(1, 2, { url: "http://app.test/cart" }),
        screen(2, 3),
        screen(3, 4),
        screen(4, 5),
        screen(5, 6),
        screen(6, 7),
        screen(7, 8),
      ],
      endedAt: 9_000,
    };
    const points = detectFriction(capture, { status: "incomplete", reason: "blocked: Confirm stayed disabled" });
    const byKind = (k: FrictionPoint["kind"]) => points.filter((p) => p.kind === k);
    expect(byKind("retry")[0]).toMatchObject({ steps: [3, 4], impact: "slowed" });
    expect(byKind("long-wait")[0]).toMatchObject({ steps: [5, 6], impact: "slowed" });
    expect(byKind("dead-end")[0]).toMatchObject({ steps: [7], impact: "blocked" });
    expect(byKind("error")[0]).toMatchObject({ steps: [4], impact: "blocked" });
    expect(byKind("abandoned")[0]).toMatchObject({ steps: [1, 2], impact: "confused" });
    expect(byKind("backtrack")[0]).toMatchObject({ steps: [1, 2, 3], impact: "confused" }); // checkout → cart → checkout
    expect(byKind("goal-not-reached")[0]).toMatchObject({ steps: [6, 7, 8], impact: "blocked" });
    for (const p of points) expect(p.detail.length).toBeGreaterThan(0);
  });

  it("a route left and returned to within a few screens is a backtrack", () => {
    const capture: RunSignalCapture = {
      steps: [step(1, "click"), step(2, "click", { url: "http://app.test/help" }), step(3, "click")],
      requests: [],
      screens: [screen(0, 1), screen(1, 2, { url: "http://app.test/help" }), screen(2, 3)],
      endedAt: 4_000,
    };
    expect(detectFriction(capture).find((p) => p.kind === "backtrack")).toMatchObject({ steps: [1, 2, 3], routes: expect.arrayContaining(["/checkout", "/help"]) });
  });

  it("a smooth, completed run has no friction", () => {
    const capture: RunSignalCapture = {
      steps: [step(1, "type", { value: "a" }), step(2, "click"), step(3, "done")],
      requests: [],
      screens: [screen(0, 1), screen(1, 2), screen(2, 3)],
      endedAt: 4_000,
    };
    expect(detectFriction(capture, { status: "completed" })).toEqual([]);
  });
});

describe("groundFindings (#132)", () => {
  const point: FrictionPoint = { id: "retry@3-4", kind: "retry", impact: "slowed", steps: [3, 4], screenIds: ["sig-3", "sig-4"], routes: ["/checkout"], detail: "Pay repeated" };

  it("grounds a rubric finding in the friction on its screen: behavioral evidence, severity from impact", () => {
    const outcome: AnalysisOutcome = { kind: "analyzed", findings: [rubricFinding("nielsen-1", "major", 0.6, "sig-3")], coverage };
    const [f] = (groundFindings(outcome, [point]) as Extract<AnalysisOutcome, { kind: "analyzed" }>).findings;
    expect(f).toMatchObject({ impact: "slowed", severity: "minor", journeyEvidence: { id: "retry@3-4", kind: "retry", steps: [3, 4] } });
  });

  it("collapses findings on one friction point into one, the others listed as its rationale", () => {
    const outcome: AnalysisOutcome = {
      kind: "analyzed",
      findings: [rubricFinding("nielsen-1", "minor", 0.5, "sig-3"), rubricFinding("scent", "major", 0.7, "sig-4"), rubricFinding("nielsen-7", "minor", 0.9, "sig-4")],
      coverage,
    };
    const report = buildReport(groundFindings(outcome, [point]), { minConfidence: 0 });
    expect(report.findings).toHaveLength(1);
    expect(report.findings[0]!.rubricItemId).toBe("scent");
    expect(report.findings[0]!.contributing?.map((c) => c.rubricItemId)).toEqual(["nielsen-7", "nielsen-1"]);
    expect(report.heuristicAppendix).toHaveLength(0);
  });

  it("a rubric finding on the same friction point as a run signal becomes that signal's rationale", () => {
    const signal = makeSignalFinding({
      kind: "inert-control",
      confidence: 0.7,
      url: URL,
      screenId: "sig-4",
      observation: "Clicking Pay changed nothing",
      userImpact: "dead end",
      recommendation: "make it work",
      controls: ['button "Pay"'],
      evidence: { kind: "inert-control", steps: [3, 4], requests: [], detail: "2 inert clicks" },
    });
    const outcome: AnalysisOutcome = { kind: "analyzed", findings: [rubricFinding("nielsen-1", "major", 0.6, "sig-3"), signal], coverage };
    const report = buildReport(groundFindings(outcome, [point]), { minConfidence: 0 });
    expect(report.findings.map((f) => f.rubricItemId)).toEqual(["signal-inert-control"]);
    expect(report.findings[0]).toMatchObject({ impact: "confused", journeyEvidence: { id: "signal:inert-control", steps: [3, 4] } });
    expect(report.findings[0]!.contributing).toEqual([expect.objectContaining({ rubricItemId: "nielsen-1" })]);
  });

  it("a rubric finding with no friction on its screen or route is heuristic-only: info, in the appendix", () => {
    const outcome: AnalysisOutcome = { kind: "analyzed", findings: [rubricFinding("nielsen-2", "major", 0.8, "sig-9", "/about")], coverage };
    const report = buildReport(groundFindings(outcome, [point]), { minConfidence: 0 });
    expect(report.findings).toHaveLength(0);
    expect(report.heuristicAppendix).toEqual([expect.objectContaining({ rubricItemId: "nielsen-2", severity: "info", heuristicOnly: true })]);
  });

  it("ranks blocked above slowed above confused", () => {
    const blocked: FrictionPoint = { ...point, id: "dead-end@7-7", kind: "dead-end", impact: "blocked", steps: [7], screenIds: ["sig-7"] };
    const outcome: AnalysisOutcome = { kind: "analyzed", findings: [rubricFinding("a", "minor", 0.9, "sig-3"), rubricFinding("b", "minor", 0.3, "sig-7")], coverage };
    const report = buildReport(groundFindings(outcome, [point, blocked]), { minConfidence: 0 });
    expect(report.findings.map((f) => [f.rubricItemId, f.impact, f.severity])).toEqual([
      ["b", "blocked", "major"],
      ["a", "slowed", "minor"],
    ]);
  });
});
