import { describe, expect, it } from "vitest";
import { FakeGenerationGateway, type Answer, type JudgmentPort, type Question } from "@jevitate/ai-core";
import { analyzeClaims, boundTargetOptions, gradeLabel, type GuardProbe } from "./claims.js";
import { controlKey } from "./adjudicate.js";
import { a11yChecks } from "./a11y.js";
import { CLAIM_PROMPTS } from "./claim-prompts.js";
import type { FrictionPoint } from "./friction.js";
import { groundFindings } from "./friction.js";
import { parseProductFacts } from "./product-facts.js";
import { buildReport } from "./report.js";
import { loadV1Rubric } from "./rubric/v1/index.js";
import type { SignalStep } from "./signals.js";
import type { AnalysisOutcome, Control, UxEvidence } from "./types.js";

const appContext = { appClass: "consumer", job: "save my profile" } as const;
const rubric = loadV1Rubric();

const save: Control = { index: 0, role: "button", name: "Save", tag: "button", inputType: null, enabled: true, summary: 'button "Save"' };
const del: Control = { index: 1, role: "button", name: "Delete account", tag: "button", inputType: null, enabled: true, summary: 'button "Delete account"' };

function screen(id = "s1", path = "/profile", controls: Control[] = [save, del], visibleText = "Profile\nSave\nDelete account"): UxEvidence {
  return {
    screenId: id,
    url: `https://app.example.com${path}`,
    controls,
    visibleText,
    appContext,
    job: appContext.job,
    history: [],
    behavior: { noProgress: false, backtracks: 0, formReentry: 0, dwellMs: 0, errors: 0 },
    a11yFacts: { controls: [] },
  };
}

const retry: FrictionPoint = { id: "retry@2-3", kind: "retry", impact: "slowed", steps: [2, 3], screenIds: ["s1"], routes: ["/profile"], detail: "click on Save repeated 2 times (steps 2, 3)" };
const steps: SignalStep[] = [
  { step: 2, op: "click", target: 'button "Save"', actOk: true, url: "https://app.example.com/profile" },
  { step: 3, op: "click", target: 'button "Save"', actOk: true, url: "https://app.example.com/profile" },
];
const unguarded: GuardProbe = {
  screenId: "s1",
  route: "/profile",
  control: 'button "Delete account"',
  controlKey: controlKey(del),
  status: "probed",
  guard: "none",
  blockedWrites: ["DELETE /api/account"],
  detail: "no guard",
};

type Script = (key: string, q: Question) => Answer;
function jev(script: Script): JudgmentPort & { calls: number } {
  const port = {
    calls: 0,
    async systemOne({ questions }: { questions: Record<string, Question> }) {
      port.calls++;
      return Object.fromEntries(Object.entries(questions).map(([k, q]) => [k, script(k, q)]));
    },
  };
  return port;
}
const yes = (p = 0.9): Answer => ({ kind: "noul", value: p >= 0.5, probability: p });
const pick = (value: string): Answer => ({ kind: "choice", value, confidence: 0.8 });

/** Friction typed as no-feedback on Save; grades yes/yes; duplicates new. */
const standard: Script = (k) => (k.endsWith("::type") ? pick("no-feedback") : k.endsWith("::target") ? pick("control:0") : k.startsWith("dup::") ? pick("new") : yes());

async function analyzed(p: Promise<AnalysisOutcome>): Promise<Extract<AnalysisOutcome, { kind: "analyzed" }>> {
  const o = await p;
  if (o.kind !== "analyzed") throw new Error(`failed: ${o.reason}`);
  return o;
}

describe("claims: the two-question grade (code mapping)", () => {
  it("maps need/ship onto actionable / relevant-minor / generic / wrong with the asset cutoffs", () => {
    expect(CLAIM_PROMPTS.cutoffs).toEqual({ need: 0.5, ship: 0.5, wrong: 0.2 });
    expect(gradeLabel(0.9, 0.8).label).toBe("actionable");
    expect(gradeLabel(0.9, 0.2).label).toBe("relevant-minor");
    expect(gradeLabel(0.3, 0.9).label).toBe("generic");
    expect(gradeLabel(0.1, 0.9).label).toBe("wrong");
    expect(gradeLabel(0.9, 0.8).confidence).toBeCloseTo(0.8);
  });
});

describe("claims: friction categorized by Jev, verified by code", () => {
  it("a retry on Save, typed no-feedback with target Save, is verified by the friction's own steps — template prose, cited, graded", async () => {
    const o = await analyzed(analyzeClaims({ screens: [screen()], rubric, appContext, judgmentBudget: 5, friction: [retry], steps, probes: [] }, { judge: jev(standard) }));
    expect(o.findings).toHaveLength(1);
    const f = o.findings[0]!;
    expect(f).toMatchObject({
      rubricItemId: "nielsen-1",
      tier: "behavioral",
      route: "/profile",
      controls: ['button "Save"'],
      claim: { type: "no-feedback", source: "friction", verifiedBy: "friction:retry@2-3", target: 'button "Save"' },
      quality: { label: "actionable" },
      grade: { need: 0.9, ship: 0.9 },
      journeyEvidence: { id: "retry@2-3", steps: [2, 3] },
      impact: "slowed",
      severity: "minor",
    });
    expect(f.observation).toBe('After acting on button "Save" on /profile, nothing confirmed the action: click on Save repeated 2 times (steps 2, 3).');
    expect(f.recommendation).toMatch(/^Show a clear result after button "Save" on \/profile/);
    expect(o.claims).toMatchObject({ candidates: 1, verified: 1 });
  });

  it("a claim type that does not fit the friction is refuted and counted as unverified (never shown)", async () => {
    const script: Script = (k, q) => (k.endsWith("::type") ? pick("error-unrecoverable") : standard(k, q));
    const o = await analyzed(analyzeClaims({ screens: [screen()], rubric, appContext, judgmentBudget: 5, friction: [retry], steps, probes: [] }, { judge: jev(script) }));
    expect(o.findings).toEqual([]);
    expect(o.suppressed).toEqual([expect.objectContaining({ reason: "unverified", rubricItemId: "nielsen-9" })]);
    expect(o.claims!.items[0]).toMatchObject({ status: "refuted", type: "error-unrecoverable" });
  });

  it("a target the friction's steps never acted on is refuted", async () => {
    const script: Script = (k, q) => (k.endsWith("::target") ? pick("control:1") : standard(k, q));
    const o = await analyzed(analyzeClaims({ screens: [screen()], rubric, appContext, judgmentBudget: 5, friction: [retry], steps, probes: [] }, { judge: jev(script) }));
    expect(o.findings).toEqual([]);
    expect(o.claims!.items[0]!.reason).toMatch(/did not act on button "Delete account"/);
  });

  it("friction Jev calls not-a-problem is suppressed as not-a-problem (counted; the report is not clean)", async () => {
    const script: Script = (k, q) => (k.endsWith("::type") ? pick("not-a-problem") : standard(k, q));
    const o = await analyzed(analyzeClaims({ screens: [screen()], rubric, appContext, judgmentBudget: 5, friction: [retry], steps, probes: [] }, { judge: jev(script) }));
    expect(o.suppressed?.map((s) => s.reason)).toEqual(["not-a-problem"]);
    const report = buildReport(o);
    expect(report.clean).toBe(false);
    expect(report.suppressed.byReason["not-a-problem"]).toBe(1);
  });

  it("friction a run signal already explains is not re-claimed", async () => {
    const o = await analyzed(
      analyzeClaims(
        {
          screens: [screen()],
          rubric,
          appContext,
          judgmentBudget: 5,
          friction: [retry],
          steps,
          probes: [],
          signalFindings: [{ screenIds: ["other"], signal: { kind: "inert-control", steps: [2, 3], requests: [], detail: "" } } as never],
        },
        { judge: jev(standard) },
      ),
    );
    expect(o.claims!.candidates).toBe(0);
  });

  it("an invalid categorization answer is a failed analysis, never a silent pass", async () => {
    const script: Script = (k, q) => (k.endsWith("::type") ? pick("something-else") : standard(k, q));
    const o = await analyzeClaims({ screens: [screen()], rubric, appContext, judgmentBudget: 5, friction: [retry], steps, probes: [] }, { judge: jev(script) });
    expect(o).toMatchObject({ kind: "failed", reason: expect.stringMatching(/no valid claim type/) });
  });

  it("a judge error is a failed analysis", async () => {
    const broken: JudgmentPort = { systemOne: async () => Promise.reject(new Error("boom")) };
    const o = await analyzeClaims({ screens: [screen()], rubric, appContext, judgmentBudget: 5, friction: [retry], steps, probes: [] }, { judge: broken });
    expect(o).toMatchObject({ kind: "failed", reason: expect.stringMatching(/boom/) });
  });
});

describe("claims: destructive controls (guard probe)", () => {
  it("an unguarded probe that attempted a write is a major finding; offline without probes it is unverifiable (coverage, not a finding)", async () => {
    const live = await analyzed(analyzeClaims({ screens: [screen()], rubric, appContext, judgmentBudget: 5, probes: [unguarded] }, { judge: jev(standard) }));
    expect(live.findings.map((f) => [f.claim?.type, f.severity, f.observation])).toEqual([
      ["destructive-unguarded", "major", 'button "Delete account" on /profile acts immediately: clicking it sent DELETE /api/account with no confirmation dialog, undo or confirmation step.'],
    ]);
    // Offline, a friction claim naming the control cannot be checked.
    const del2: FrictionPoint = { ...retry, id: "retry@4-5", steps: [4, 5], detail: "click on Delete account repeated" };
    const script: Script = (k, q) => (k.endsWith("::type") ? pick("destructive-unguarded") : k.endsWith("::target") ? pick("control:1") : standard(k, q));
    const offline = await analyzed(analyzeClaims({ screens: [screen()], rubric, appContext, judgmentBudget: 5, friction: [del2] }, { judge: jev(script) }));
    expect(offline.findings).toEqual([]);
    expect(offline.coverage.skipped).toEqual([expect.objectContaining({ rubricItemId: "claim:destructive-unguarded" })]);
    expect(buildReport(offline).coverageComplete).toBe(false);
  });

  it("a probe that wrote nothing, or found the control gone, is refuted / unverifiable", async () => {
    const quiet = await analyzed(analyzeClaims({ screens: [screen()], rubric, appContext, judgmentBudget: 5, probes: [{ ...unguarded, blockedWrites: [] }] }, { judge: jev(standard) }));
    expect(quiet.claims!.items[0]).toMatchObject({ status: "refuted", reason: expect.stringMatching(/no write request/) });
    expect(buildReport(quiet).clean).toBe(true);
    const gone = await analyzed(analyzeClaims({ screens: [screen()], rubric, appContext, judgmentBudget: 5, probes: [{ ...unguarded, status: "not-found", guard: undefined, detail: "not visible after a fresh load" }] }, { judge: jev(standard) }));
    expect(gone.claims!.items[0]).toMatchObject({ status: "unverifiable" });
  });
});

describe("claims: merge, duplicates, budget, polish", () => {
  it("probes dedupe per route × control; the same friction claim twice on one route merges by code into one finding with two occurrences", async () => {
    const o = await analyzed(analyzeClaims({ screens: [screen("s1"), screen("s2")], rubric, appContext, judgmentBudget: 5, probes: [unguarded, { ...unguarded, screenId: "s2" }] }, { judge: jev(standard) }));
    expect(o.findings).toHaveLength(1);
    expect(o.claims!.candidates).toBe(1);
    const again: FrictionPoint = { ...retry, id: "retry@6-7", steps: [6, 7], screenIds: ["s2"] };
    const steps2: SignalStep[] = [...steps, { ...steps[0]!, step: 6 }, { ...steps[0]!, step: 7 }];
    const m = await analyzed(analyzeClaims({ screens: [screen("s1"), screen("s2")], rubric, appContext, judgmentBudget: 5, friction: [retry, again], steps: steps2, probes: [] }, { judge: jev(standard) }));
    expect(m.findings).toHaveLength(1);
    expect(m.findings[0]!.occurrences).toBe(2);
    expect(m.findings[0]!.screenIds).toEqual(["s1", "s2"]);
    expect(m.claims).toMatchObject({ verified: 1, merged: 1 });
    expect(buildReport(m).headline).not.toMatch(/not attributed/);
  });

  it("Jev's duplicate choice merges a same-route same-type finding into the earlier one as contributing", async () => {
    const facts = parseProductFacts({ version: 1, plans: [{ name: "Pro", prices: [{ amount: 10, interval: "month" }] }, { name: "Team", prices: [{ amount: 20, interval: "month" }] }] });
    const s = screen("p1", "/pricing", [save], "Pro $12/month\nTeam $25/month");
    const script: Script = (k, q) => (k.startsWith("dup::") ? pick(q.kind === "choice" ? q.options[1]! : "new") : standard(k, q));
    const o = await analyzed(analyzeClaims({ screens: [s], rubric, appContext, judgmentBudget: 5, facts, probes: [] }, { judge: jev(script) }));
    expect(o.findings).toHaveLength(1);
    expect(o.findings[0]!.contributing).toHaveLength(1);
    expect(o.claims).toMatchObject({ verified: 1, merged: 1 });
    // Every occurrence is accounted for in the report headline.
    expect(buildReport(o).headline).not.toMatch(/not attributed/);
  });

  it("budget: one call categorizes, one grades; with no budget left the findings are ungraded and the screen is budget-truncated", async () => {
    const j = jev(standard);
    const o = await analyzed(analyzeClaims({ screens: [screen()], rubric, appContext, judgmentBudget: 1, friction: [retry], steps, probes: [] }, { judge: j }));
    expect(j.calls).toBe(1);
    expect(o.findings[0]!.quality).toBeUndefined();
    expect(o.coverage.budgetTruncated).toEqual(["s1"]);
    const none = await analyzed(analyzeClaims({ screens: [screen()], rubric, appContext, judgmentBudget: 0, friction: [retry], steps, probes: [] }, { judge: jev(standard) }));
    expect(none.claims!.items[0]).toMatchObject({ status: "budget-truncated" });
  });

  it("polish is opt-in: one generation call per verified finding, citation kept; off by default", async () => {
    let gens = 0;
    const gen = new FakeGenerationGateway({ "ux.recommendation": { recommendation: "Ask before deleting the account." } });
    const counted = { generate: async (k: never, i: never) => (gens++, gen.generate(k, i)) };
    const plain = await analyzed(analyzeClaims({ screens: [screen()], rubric, appContext, judgmentBudget: 5, probes: [unguarded] }, { judge: jev(standard), gen: counted as never }));
    expect(gens).toBe(0);
    expect(plain.findings[0]!.recommendation).toMatch(/^Guard button "Delete account"/);
    const polished = await analyzed(analyzeClaims({ screens: [screen()], rubric, appContext, judgmentBudget: 5, probes: [unguarded] }, { judge: jev(standard), gen: counted as never, polish: true }));
    expect(gens).toBe(1);
    expect(polished.findings[0]!.recommendation).toBe("Ask before deleting the account. (Nielsen Norman Group — 10 Usability Heuristics: nngroup.com/articles/ten-usability-heuristics)");
  });
});

describe("claims: report integration", () => {
  it("verified claims are ranked findings (never the heuristic appendix), pass through groundFindings untouched, and the ledger is on the report", async () => {
    const o = await analyzed(analyzeClaims({ screens: [screen()], rubric, appContext, judgmentBudget: 5, probes: [unguarded], friction: [retry], steps }, { judge: jev(standard), a11yChecker: a11yChecks }));
    const grounded = groundFindings(o, [retry]);
    const report = buildReport(grounded, { minConfidence: 0.3 });
    expect(report.heuristicAppendix).toEqual([]);
    expect(report.findings.map((f) => f.claim?.type).sort()).toEqual(["destructive-unguarded", "no-feedback"]);
    expect(report.claims).toMatchObject({ candidates: 2, verified: 2 });
    expect(report.headline).not.toMatch(/not attributed/);
  });

  it("bounds the target options below the choice cap, keeping the controls the friction acted on", () => {
    const many: Control[] = Array.from({ length: 400 }, (_, i) => ({ index: i, role: "option", name: `Country ${i}`, tag: "li", inputType: null, enabled: true, summary: `option "Country ${i}"` }));
    const point: FrictionPoint = { ...retry, steps: [7], detail: "click on Country 399 repeated" };
    const kept = boundTargetOptions(many, point, [{ step: 7, op: "click", target: 'option "Country 399"', actOk: true, url: "x" }]);
    expect(kept.length).toBe(254);
    expect(kept.some((c) => c.name === "Country 399")).toBe(true);
  });
});
